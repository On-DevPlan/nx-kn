// kb 域（知识库）：把**若干** Obsidian vault 当作知识库，用 zg 建索引并做混合检索。
//
// 职责边界：zg 只当召回引擎（子进程调用，不装 MCP、不起常驻服务），
// 本域负责「有哪些库、各自的索引怎么建、结果怎么合并给人和 agent 用」。
//
// 为什么是「多库」而不是「一个库」：zg 的索引按 workspace 根组织
// （`<root>/.zvec-grep/`），两个 vault 天然就是两个索引、两个模型维度；
// 要一起搜就得逐个召回、再把结果并成一张列表。这里就是这个「并」的地方。
//
// 命令语义分工（读命令的 flag 不带 default，写命令才带——见 A07）：
//   kb add <path>    写：把一个 vault 加进列表（按绝对路径去重）
//   kb remove <path> 写：从列表移除（**不删索引**，索引归 zg 所有）
//   kb list          读：列出已登记的库
//   kb index         写：对列表里的库建/增索引（--root 只处理一个）
//   kb query         读：逐库召回 → 按 score 合并（cwd = 各库）
//   kb status        读：zg 可用性 + 逐库索引状态
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, resolve, join } from 'node:path';
import { badInput, external, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import {
  APP_NAME,
  VAULT_ENV,
  VAULT_EXCLUDES,
  defaultEmbeddingFromEnv,
  vaultPathFromEnv,
} from '../../core/paths.js';
import {
  INDEX_DIR,
  assertZgOk,
  hasIndex,
  indexDirOf,
  parseIndexSummary,
  parseQuery,
  parseStatus,
  probe,
  runZg,
} from '../../core/zg.js';

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function assertDir(p, label = '知识库目录') {
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    throw notFound(`${label}不存在: ${p}`);
  }
  if (!st.isDirectory()) throw badInput(`${label}不是目录: ${p}`);
  return p;
}

export async function storedVaults() {
  const store = await loadStore();
  return (store.kb && store.kb.vaults) || [];
}

// ---- 目标解析：--root / 环境变量（单库）> store 列表（多库）----
//
// 两层语义刻意不同：
//   --root 与环境变量 = 「这次只看这一个」（临时、无需登记，探路用）
//   store 列表        = 「我的知识库们」（长期，默认全都要）
// 所以前者不做存在性兜底（指错了直接报错更省事），后者对缺失目录**只标记不抛**——
// 多库里有一个被删/被移走是常态，抛错会让另外几个库一起不可用。
export async function resolveVaults({ root } = {}) {
  const fromFlag = root ? resolve(String(root)) : null;
  const fromEnv = fromFlag ? null : vaultPathFromEnv();

  if (fromFlag || fromEnv) {
    const dir = fromFlag || resolve(String(fromEnv));
    await assertDir(dir);
    return { vaults: [{ path: dir, name: basename(dir), model: null, missing: false }], source: fromFlag ? 'flag' : 'env' };
  }

  const stored = await storedVaults();
  if (!stored.length) {
    throw badInput(
      `还没有添加知识库目录。先跑 ${APP_NAME} kb add <vault路径>（临时用可设环境变量 ${VAULT_ENV}，或用 --root 指定）`
    );
  }

  const vaults = [];
  for (const rec of stored) {
    const dir = resolve(String(rec.path));
    vaults.push({ ...rec, path: dir, missing: !(await isDir(dir)) });
  }
  return { vaults, source: 'store' };
}

// ---- 只读探测：数笔记、认 Obsidian ----

// 递归数**可索引**的 md。上限 5 万个：大 vault 上这条只是「让人心里有数」，
// 不值得为它遍历一整个盘。
//
// 为什么按 zg 的口径数、而不是数所有 md：zg 建索引时会**静默跳过**好几类东西
// （0.2.2 实测）。若照实报「226 篇」而索引只有 173 篇，用户第一反应是「漏索引了」——
// 本机那 53 篇的差额全部来自下面第 3、4 条。这里把 zg 的口径近似一遍，
// 顺手还能回答「少的那些去哪了」：
//   1. 隐藏目录（`.xxx`）：zg 默认不扫（`.git`、`.zvec-grep` 更是硬跳过）
//   2. zg 内置的依赖/产物目录名（node_modules、dist、build、tmp、logs …）
//   3. **嵌套 git 仓库整棵**：子树里有 `.git` 就跳过——克隆下来的仓库不算你的笔记
//      （本机实测：`辅助工具/抓包/langgraph-claude-code` 正是克隆仓库，一整个 48 篇）
//   4. 0 字节空文件（本机 5 篇——Obsidian 里点出来的空笔记）
// 结果只是**估算**：权威数字永远是索引自己的 `files / filesTotal`。
const COUNT_LIMIT = 50_000;

// 抄自 zg 0.2.2 的 DEFAULT_IGNORED_DIRECTORY_NAMES
// （@zvec/zvec-grep/dist/engine/pipeline/indexing/scanner/index.js）。
// 这些名字出现在知识库 vault 里基本都不是笔记，跟着排掉比「全收进来」更贴近预期。
const ZG_IGNORED_DIRS = new Set([
  'node_modules', 'vendor', 'thirdparty', 'third_party', 'external', 'deps',
  'dist', 'build', 'out', 'target', 'coverage', 'generated', '__pycache__',
  'venv', '.venv', 'env', '.tox', '.eggs', 'Pods', '.next', '.nuxt',
  '.svelte-kit', '.turbo', '.vite', '.parcel-cache', '.cache', '.gradle',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', 'tmp', 'temp', 'logs',
  'locale', 'locales', 'translations',
]);

async function countNotes(dir, excludes) {
  let count = 0;
  let empty = 0;
  let nestedRepos = 0;
  const stack = [dir];
  while (stack.length && count < COUNT_LIMIT) {
    const cur = stack.pop();
    let entries;
    try {
      entries = await fsp.readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (excludes.includes(e.name) || e.name === INDEX_DIR) continue;
        if (e.name.startsWith('.') || ZG_IGNORED_DIRS.has(e.name)) continue;
        const sub = join(cur, e.name);
        if (existsSync(join(sub, '.git'))) {
          nestedRepos++; // 克隆来的仓库：zg 整棵跳过，这里只记账、不进去
          continue;
        }
        stack.push(sub);
      } else if (e.name.endsWith('.md')) {
        const st = await fsp.stat(join(cur, e.name)).catch(() => null);
        if (!st || st.size === 0) {
          empty++;
          continue;
        }
        count++;
      }
    }
  }
  return { count, truncated: count >= COUNT_LIMIT, empty, nestedRepos };
}

export async function inspect(dir) {
  const notes = await countNotes(dir, VAULT_EXCLUDES);
  return {
    vault: dir,
    name: basename(dir),
    obsidian: existsSync(join(dir, '.obsidian')),
    notes: notes.count,
    notesTruncated: notes.truncated,
    // 「为什么笔记数比 md 文件数少」的现成答案：两类 zg 默认不收的。纯解释用，
    // 不参与任何判定（真要精确，看索引自己的 files/filesTotal）。
    notesSkipped: { empty: notes.empty, nestedRepos: notes.nestedRepos },
    indexed: hasIndex(dir),
    indexPath: indexDirOf(dir),
  };
}

// ---- add / remove / list：维护库列表 ----

export async function add({ path, model } = {}) {
  if (!path) throw badInput(`用法: ${APP_NAME} kb add <vault路径> [--model <模型>]`);
  const dir = await assertDir(resolve(String(path)));
  const want = model ? String(model) : null;

  const before = await storedVaults();
  const already = before.some((v) => resolve(String(v.path)) === dir);

  await mutateStore((store) => {
    const rec = store.kb.vaults.find((v) => resolve(String(v.path)) === dir);
    if (!rec) {
      // model 是「这个库建索引时用哪个模型」的备忘，不是「已经生效的模型」——
      // 真正生效的看索引里的 schema（status/list 读的是那一份）。
      store.kb.vaults.push({
        path: dir,
        name: basename(dir),
        model: want,
        addedAt: new Date().toISOString(),
      });
    } else if (want) {
      rec.model = want; // 显式给了就更新：用户在纠正之前填错的模型
    }
    return store.kb.vaults;
  });

  const info = await inspect(dir);
  const idx = hasIndex(dir) ? await indexStatus(dir) : null;
  return {
    status: 'ok',
    ...info,
    // 带上索引详情，add 的 CLI 输出才能和 list 一样给出覆盖度而不是一串「?」
    index: idx,
    model: (idx && idx.embedding && idx.embedding.model) || null,
    plannedModel: want || (await storedVaults()).find((v) => resolve(String(v.path)) === dir)?.model || null,
    added: !already,
    count: (await storedVaults()).length,
    vaults: await listRows(),
    // Obsidian 判定只作提示，不作拦截——有些人的 vault 就是一堆 md，没装 Obsidian 客户端
    note: info.obsidian
      ? '已识别为 Obsidian vault（含 .obsidian/）'
      : '未发现 .obsidian/ 目录：不是 Obsidian vault 也能索引，但排除规则只按默认名单走',
  };
}

export async function remove({ path } = {}) {
  if (!path) throw badInput(`用法: ${APP_NAME} kb remove <vault路径>`);
  const dir = resolve(String(path));
  const before = await storedVaults();
  const hit = before.find((v) => resolve(String(v.path)) === dir);
  if (!hit) throw notFound(`这个目录不在知识库列表里: ${dir}`);

  await mutateStore((store) => {
    store.kb.vaults = store.kb.vaults.filter((v) => resolve(String(v.path)) !== dir);
    return store.kb.vaults;
  });

  return {
    status: 'ok',
    removed: dir,
    count: (await storedVaults()).length,
    vaults: await listRows(),
    // 索引是 zg 的产物，留在原 vault 里；说清楚，免得用户以为「移除=删数据」
    note: hasIndex(dir) ? `索引仍留在 ${indexDirOf(dir)}（nx-kn 不代删；要清掉跑 zg index ${dir} --drop）` : undefined,
  };
}

async function listRows() {
  const stored = await storedVaults();
  const out = [];
  for (const rec of stored) {
    const dir = resolve(String(rec.path));
    if (!(await isDir(dir))) {
      out.push({ path: dir, name: rec.name || basename(dir), model: rec.model || null, missing: true });
      continue;
    }
    const info = await inspect(dir);
    const idx = hasIndex(dir) ? await indexStatus(dir) : null;
    out.push({
      path: dir,
      name: rec.name || basename(dir),
      // model 只认索引里**实际生效**的那个；还没建索引时给 null，
      // 别把登记时填的「打算用哪个模型」冒充成已生效的模型（旧版就是在这里骗人的）。
      model: (idx && idx.embedding && idx.embedding.model) || null,
      plannedModel: rec.model || null,
      index: idx,
      ...info,
    });
  }
  return out;
}

export async function list() {
  const vaults = await listRows();
  return { status: 'ok', count: vaults.length, vaults };
}

// ---- index：建 / 增 / 重建（支持多库）----

// zg 的文件选择参数：只收 md，且显式排除 Obsidian 噪声目录。
// 实测（0.2.2）：.obsidian/ 与 .trash/ 本来就因「隐藏路径默认不扫」而不入库，
// 这里仍显式写出来，是为了不把正确性寄托在别人的默认值上。
function fileSelectionArgs(types) {
  const list = (types && types.length ? types : ['md']).map((t) => String(t).trim()).filter(Boolean);
  const args = [];
  for (const t of list) args.push('-t', t);
  for (const ex of VAULT_EXCLUDES) args.push('-g', `!${ex}/**`);
  return args;
}

function formatCommand(args) {
  return ['zg', ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
}

// 建索引用哪个模型。优先级（从高到低）：
//   命令行 --model  >  已建索引里实际生效的  >  这个库登记时记着的  >
//   环境变量 NX_KN_EMBEDDING 覆盖的默认  >  内置默认
// 最后两层是必须的：zg 的硬要求是「新索引必须显式给 --embedding，或已有全局默认」，
// 而一台干净机器的 `~/.zvec-grep/config.json` 并不存在。没有兜底，
// 「添加目录 → 更新索引」这条最普通的路径就会失败——用户得手动去配模型，
// 这正是我们要避免的「额外手动操作」。
export function resolveEmbeddingModel({ explicit, current, recorded } = {}) {
  return explicit || current || recorded || defaultEmbeddingFromEnv();
}

// 单个库的索引。**串行**调用（不并发）：zg 在同一时刻对多个 workspace 建索引
// 会抢模型与磁盘，实测会出现 `Cleanup of retired segment failed` 之类的残留告警；
// 索引本来就是慢操作，串行换来的是可读的日志与确定的顺序。
async function indexOne(v, { rebuild, model, types }) {
  const dir = v.path;
  const before = hasIndex(dir) ? await indexStatus(dir) : null;
  const current = (before && before.embedding && before.embedding.model) || null;
  const explicit = model ? String(model) : null;
  const want = resolveEmbeddingModel({ explicit, current, recorded: v.model });

  const args = ['index', dir, '--mode', 'direct', ...fileSelectionArgs(types)];

  if (!before || rebuild) {
    // 新建与重建都要显式给模型；重建还得把模型带回来，否则 zg 会退回全局默认或报错。
    args.push('--embedding', want);
  } else if (explicit && current && explicit !== current) {
    // 已建索引锁定了旧模型维度：不 --rebuild 就换模型必然维度冲突。
    // 与其让 zg 报一个难懂的错，不如在这里直接说清代价。
    throw badInput(
      `库 ${dir} 换模型（${current} → ${explicit}）必须叠加 --rebuild：已建索引锁定旧模型维度，普通 index 不能混用`
    );
  }
  // 增量的「模型不变」路径刻意**不传** --embedding：zg 会复用已存 schema，
  // 少一个参数就少一个出错面（也避免把已存 schema 当参数再校验一遍）。
  if (rebuild) args.push('--rebuild');

  const r = await runZg(args, { cwd: dir, timeoutMs: 600_000 });
  assertZgOk(r, `建立索引（${dir}）`);

  const after = await indexStatus(dir);
  const usedModel = (after && after.embedding && after.embedding.model) || want;
  if (usedModel) {
    await mutateStore((store) => {
      const rec = store.kb.vaults.find((x) => resolve(String(x.path)) === dir);
      if (rec) rec.model = usedModel; // 每库各自记模型（旧版是全局单值，多库下必须分家）
      return store.kb.vaults;
    });
  }

  return {
    path: dir,
    name: v.name || basename(dir),
    mode: rebuild ? 'rebuild' : 'incremental',
    rebuild: !!rebuild,
    model: usedModel,
    elapsedMs: r.elapsedMs,
    command: formatCommand(args),
    summary: r.stdout.trim().split('\n').slice(-12).join('\n'),
    changes: parseIndexSummary(r.stdout),
    index: after,
    ...(await inspect(dir)),
  };
}

export async function index({ root, rebuild = false, model, types } = {}) {
  const { vaults } = await resolveVaults({ root });

  const zg = await probe();
  if (!zg.installed) {
    throw external(
      `zg 不可用：请先安装召回引擎（npm install -g @zvec/zvec-grep）${zg.error ? ' —— ' + zg.error : ''}`
    );
  }

  const targets = vaults.filter((v) => !v.missing);
  const missing = vaults.filter((v) => v.missing).map((v) => v.path);
  if (!targets.length) {
    throw notFound(`知识库目录都不存在，无法建索引：${missing.join('、')}`);
  }

  const results = [];
  for (const v of targets) {
    results.push(await indexOne(v, { rebuild, model, types }));
  }

  return {
    status: 'ok',
    rebuild: !!rebuild,
    mode: rebuild ? 'rebuild' : 'incremental',
    count: results.length,
    missing,
    results,
    elapsedMs: results.reduce((n, r) => n + (r.elapsedMs || 0), 0),
  };
}

// ---- status：zg 可用性 + 逐库索引状态 ----

async function indexStatus(dir) {
  if (!hasIndex(dir)) return null;
  const r = await runZg(['status', dir, '--mode', 'direct'], { timeoutMs: 60_000 });
  if (!r.ok) return null;
  return parseStatus(r.stdout);
}

function vaultHint({ zgInstalled, info, idx }) {
  if (!zgInstalled) return 'zg 不可用：npm install -g @zvec/zvec-grep';
  if (!info.indexed) return `还没有索引：跑 ${APP_NAME} index`;
  if (idx && idx.stale) {
    return `索引待更新（新增 ${idx.changes?.added ?? '?'} / 改动 ${idx.changes?.modified ?? '?'} 篇）——跑 ${APP_NAME} index`;
  }
  return undefined;
}

export async function status({ root } = {}) {
  const zg = await probe();

  let vaults = [];
  let resolveError = null;
  try {
    vaults = (await resolveVaults({ root })).vaults;
  } catch (err) {
    resolveError = String((err && err.message) || err);
  }

  if (!vaults.length) {
    return {
      status: 'ok',
      zg,
      vaults: [],
      configured: false,
      indexed: false,
      // 还没添加库时面板照样要弹「添加目录」对话框，预填模型也得给上
      defaultModel: defaultEmbeddingFromEnv(),
      hint: resolveError,
    };
  }

  // 逐库并发探测：每个库要跑一次 `zg status`（约 2–6s），串行会让 3 个库的
  // 面板首屏变成 3 倍时长。不同 workspace 之间无共享状态，并发是安全的。
  const rows = await Promise.all(
    vaults.map(async (v) => {
      if (v.missing) {
        return { ...v, indexed: false, notes: null, obsidian: false, hint: `目录不存在: ${v.path}` };
      }
      const info = await inspect(v.path);
      const idx = await indexStatus(v.path);
      return {
        ...info,
        // path 与 info.vault 是同一个值，但语义不同：vault 是「探测到的目录」，
        // path 是「列表里的这一条」。面板按列表渲染，需要 path 稳定在场。
        path: v.path,
        name: v.name || basename(v.path),
        missing: false,
        // 修「模型」语义：只认索引里实际生效的模型，索引不存在就明说「未记录」。
        // 旧版在这里回落到 store 的全局 model，切换/新增库后会显示上一个库的残留值。
        model: (idx && idx.embedding && idx.embedding.model) || null,
        index: idx,
        hint: vaultHint({ zgInstalled: zg.installed, info, idx }),
      };
    })
  );

  const indexed = rows.filter((r) => r.indexed).length;
  const stale = rows.filter((r) => r.index && r.index.stale).length;
  return {
    status: 'ok',
    zg,
    configured: true,
    count: rows.length,
    vaults: rows,
    // 面板「添加目录」对话框的预填值从这里取，而不是在自己那边写死一个字符串——
    // 否则设了 NX_KN_EMBEDDING 的机器上，面板会把一个拉不下来的模型预填给用户。
    defaultModel: defaultEmbeddingFromEnv(),
    // 聚合视图：面板顶部一句话能说清的就去这里取
    totals: {
      vaults: rows.length,
      indexed,
      stale,
      missing: rows.filter((r) => r.missing).length,
      notes: rows.reduce((n, r) => n + (r.notes || 0), 0),
    },
    indexed: indexed > 0,
    hint: !zg.installed
      ? 'zg 不可用：npm install -g @zvec/zvec-grep'
      : indexed === 0
        ? `还没有任何索引：跑 ${APP_NAME} index`
        : undefined,
  };
}

// ---- query：逐库召回 → 按 score 合并 ----

// 给 agent 看的归属头：zg 的结果里只有 workspace 内相对路径，没有「这是哪个库」——
// AI 拿到一个 `notes/x.md:12-20` 无法定位到磁盘上的文件。多库时还必须先知道
// 「哪个库」，否则拼绝对路径时会把库根拼错。
export function attributionHeader(vaults) {
  const lines = ['[nx-kn 知识库召回]'];
  if (vaults.length === 1) {
    lines.push(`知识库根: ${vaults[0].path}`);
  } else {
    lines.push(`知识库（${vaults.length} 个）:`);
    for (const v of vaults) lines.push(`  [${v.name}] ${v.path}`);
  }
  lines.push('命中路径是**所属库内**的相对路径；读全文拼 <该库的根>/<相对路径>');
  lines.push('');
  return lines.join('\n');
}

// 单库召回。--fuse 与 --trace 都不是可选优化：
//   --fuse  不加时 zg 会把问句**按词拆成多个查询分组**（"Scenario / DSL / 场景怎么写"
//           各一组），每组各返回 limit 条并互相重复——实测一个三词问句回来 21 条，
//           大半是同一条的不同分组副本。融合后是一条统一排序的列表。
//   --trace 让命中头带上 `score=`（RRF 融合分）。多库合并**只能**靠它排序：
//           craft 各自库内 rank 无法跨库比较，而 RRF 是由 rank 派生、可跨库比较的。
async function queryOne(v, { text, limit, preview }) {
  const dir = v.path;
  const r = await runZg(
    ['query', text, '--mode', 'direct', '--fuse', '--trace', '--limit', String(limit), '--preview', preview],
    // query 没有 root 参数（zg 0.2.x），workspace 由子进程 cwd 解析 —— 必须 cwd=vault
    { cwd: dir, timeoutMs: 120_000 }
  );
  if (!r.ok) {
    const detail = (r.stderr || r.stdout || r.error || '').trim().split('\n').slice(0, 4).join('\n');
    return { vault: v, ok: false, error: detail || `zg 退出码 ${r.code}`, hits: [], notes: [] };
  }
  const parsed = parseQuery(r.stdout);
  return {
    vault: v,
    ok: true,
    elapsedMs: r.elapsedMs,
    hits: parsed.hits,
    groups: parsed.groups,
    notes: parsed.notes,
  };
}

export async function query({ q, root, limit = 7, preview = 'short' } = {}) {
  const text = String(q ?? '').trim();
  if (!text) throw badInput(`用法: ${APP_NAME} query <问句> —— 查询不能为空`);

  const { vaults } = await resolveVaults({ root });

  const usable = vaults.filter((v) => !v.missing && hasIndex(v.path));
  if (!usable.length) {
    // 「还没建索引」是业务结果而非错误：面板要拿它渲染引导，不是弹错误框
    return {
      status: 'ok',
      needIndex: true,
      vaults: vaults.map((v) => ({ path: v.path, name: v.name, missing: v.missing })),
      hint: `知识库还没有索引——先跑 ${APP_NAME} index`,
    };
  }

  // 逐库并发召回：不同 workspace 无共享状态，并发让总耗时 ≈ 最慢的那个库，
  // 而不是 N 个库之和。
  const per = await Promise.all(
    usable.map((v) => queryOne(v, { text, limit: Math.max(limit, 1), preview }))
  );

  const order = usable.map((v) => v.path);
  const merged = [];
  for (const r of per) {
    for (const h of r.hits) {
      merged.push({ ...h, vault: r.vault.path, vaultName: r.vault.name });
    }
  }

  // 排序键：score 降序（RRF，跨库可比）→ 同分按库登记顺序 → 再按库内 rank。
  // score 为 null（理论上不会：我们固定带 --trace）时沉到最后，不让它污染排序。
  merged.sort((a, b) => {
    const sa = a.score ?? Number.NEGATIVE_INFINITY;
    const sb = b.score ?? Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    const va = order.indexOf(a.vault);
    const vb = order.indexOf(b.vault);
    if (va !== vb) return va - vb;
    return a.n - b.n;
  });

  const hits = merged.slice(0, limit).map((h, i) => ({ ...h, n: i + 1 }));
  const notes = [...new Set(per.flatMap((r) => r.notes))];
  const dropped = usable.filter((_, i) => !per[i].ok);

  return {
    status: 'ok',
    query: text,
    limit,
    preview,
    vaults: vaults.map((v) => ({ path: v.path, name: v.name, missing: v.missing })),
    searched: usable.map((v) => ({ path: v.path, name: v.name })),
    elapsedMs: Math.max(0, ...per.map((r) => r.elapsedMs || 0)),
    hits,
    totalHits: merged.length,
    groups: per.flatMap((r) => r.groups),
    notes,
    // 某个库召不回时不能整体报错：其余库的结果仍然有用，但必须让人知道少了谁
    skipped: [
      ...vaults.filter((v) => v.missing).map((v) => ({ path: v.path, name: v.name, reason: '目录不存在' })),
      ...dropped.map((r) => ({ path: r.vault.path, name: r.vault.name, reason: r.error || '召回失败' })),
    ],
    header: attributionHeader(usable),
  };
}

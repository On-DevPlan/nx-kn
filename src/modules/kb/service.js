// kb 域（知识库）：把 Obsidian vault 当作知识库，用 zg 建索引并做混合检索。
//
// 职责边界：zg 只当召回引擎（子进程调用，不装 MCP、不起常驻服务），
// 本域负责「vault 是哪个、索引怎么建、结果怎么给人和 agent 用」。
//
// 三条命令的语义分工（读命令的 flag 不带 default，写命令才带——见 A07）：
//   kb use <path>   写：把 vault 路径落到 store.json
//   kb index        写：跑 zg index
//   kb query        读：跑 zg query（cwd = vault）
//   kb status       读：zg 可用性 + 索引状态
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { badInput, external, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import { VAULT_ENV, VAULT_EXCLUDES, vaultPathFromEnv } from '../../core/paths.js';
import {
  INDEX_DIR,
  assertZgOk,
  hasIndex,
  indexDirOf,
  parseQuery,
  parseStatus,
  probe,
  runZg,
} from '../../core/zg.js';

// ---- vault 解析：--root > 环境变量 > store.json ----

async function storedVault() {
  const store = await loadStore();
  return (store.kb && store.kb.vault) || null;
}

async function storedModel() {
  const store = await loadStore();
  return (store.kb && store.kb.model) || null;
}

// 解析出「当前要操作哪个 vault」，并给出它是从哪儿来的（排查时有用）。
export async function resolveVault(root) {
  const fromFlag = root ? String(root) : null;
  const fromEnv = vaultPathFromEnv();
  const fromStore = fromFlag || fromEnv ? null : await storedVault();
  const raw = fromFlag || fromEnv || fromStore;

  if (!raw) {
    throw badInput(
      `还没有设定知识库目录。先跑 nx-kn kb use <vault路径>（临时用可设环境变量 ${VAULT_ENV}，或用 --root 指定）`
    );
  }

  const dir = resolve(String(raw));
  let st;
  try {
    st = await fsp.stat(dir);
  } catch {
    throw notFound(`知识库目录不存在: ${dir}`);
  }
  if (!st.isDirectory()) throw badInput(`知识库路径不是目录: ${dir}`);

  return { dir, source: fromFlag ? 'flag' : fromEnv ? 'env' : 'store' };
}

// ---- 只读探测：数笔记、认 Obsidian ----

// 递归数 md 文件；跳过排除目录与 zg 自己的索引目录。
// 上限 5 万个：大 vault 上这条只是「让人心里有数」，不值得为它遍历一整个盘。
const COUNT_LIMIT = 50_000;

async function countNotes(dir, excludes) {
  let count = 0;
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
        stack.push(join(cur, e.name));
      } else if (e.name.endsWith('.md')) {
        count++;
      }
    }
  }
  return { count, truncated: count >= COUNT_LIMIT };
}

export async function inspect(dir) {
  const notes = await countNotes(dir, VAULT_EXCLUDES);
  return {
    vault: dir,
    name: basename(dir),
    obsidian: existsSync(join(dir, '.obsidian')),
    notes: notes.count,
    notesTruncated: notes.truncated,
    indexed: hasIndex(dir),
    indexPath: indexDirOf(dir),
  };
}

// ---- use：设定 vault ----

export async function use({ path }) {
  const { dir, source } = await resolveVault(path);
  const info = await inspect(dir);
  const kb = await mutateStore((store) => {
    store.kb = { ...store.kb, vault: dir };
    return store.kb;
  });
  return {
    status: 'ok',
    ...info,
    source,
    store: kb,
    // Obsidian 判定只作提示，不作拦截——有些人的 vault 就是一堆 md，没装 Obsidian 客户端
    note: info.obsidian
      ? '已识别为 Obsidian vault（含 .obsidian/）'
      : '未发现 .obsidian/ 目录：不是 Obsidian vault 也能索引，但排除规则只按默认名单走',
  };
}

// ---- index：建 / 增 / 重建索引 ----

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

export async function index({ root, rebuild = false, model, types } = {}) {
  const { dir } = await resolveVault(root);

  const zg = await probe();
  if (!zg.installed) {
    throw external(
      `zg 不可用：请先安装召回引擎（npm install -g @zvec/zvec-grep）${zg.error ? ' —— ' + zg.error : ''}`
    );
  }

  const args = ['index', dir, '--mode', 'direct', ...fileSelectionArgs(types)];
  if (model) {
    // 已建索引锁定了旧模型的维度：不 --rebuild 就换模型必然维度冲突，
    // 与其让 zg 报一个难懂的错，不如在这里直接说清代价。
    if (!rebuild) {
      throw badInput(`换模型（${model}）必须叠加 --rebuild：已建索引锁定旧模型维度，普通 index 不能混用`);
    }
    args.push('--embedding', model);
  }
  if (rebuild) args.push('--rebuild');

  const r = await runZg(args, { cwd: dir, timeoutMs: 600_000 });
  assertZgOk(r, '建立索引');

  const after = await indexStatus(dir);
  if (after && after.embedding && after.embedding.model) {
    await mutateStore((store) => {
      store.kb = { ...store.kb, vault: dir, model: after.embedding.model };
      return store.kb;
    });
  }

  return {
    status: 'ok',
    ...(await inspect(dir)),
    rebuild,
    elapsedMs: r.elapsedMs,
    command: formatCommand(args),
    summary: r.stdout.trim().split('\n').slice(-12).join('\n'),
    index: after,
  };
}

function formatCommand(args) {
  return ['zg', ...args.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
}

// ---- status：zg 可用性 + 索引状态 ----

async function indexStatus(dir) {
  if (!hasIndex(dir)) return null;
  const r = await runZg(['status', dir, '--mode', 'direct'], { timeoutMs: 60_000 });
  if (!r.ok) return null;
  return parseStatus(r.stdout);
}

export async function status({ root } = {}) {
  const zg = await probe();

  let vault = null;
  let resolveError = null;
  try {
    vault = (await resolveVault(root)).dir;
  } catch (err) {
    resolveError = String((err && err.message) || err);
  }

  if (!vault) {
    return {
      status: 'ok',
      zg,
      vault: root ? resolve(String(root)) : (vaultPathFromEnv() || null),
      configured: false,
      indexed: false,
      hint: resolveError,
    };
  }

  const info = await inspect(vault);
  const idx = await indexStatus(vault);
  return {
    status: 'ok',
    zg,
    configured: true,
    ...info,
    model: (idx && idx.embedding && idx.embedding.model) || (await storedModel()),
    index: idx,
    // 索引在但 zg 不可用时，query 一定会失败——把这句话提前放在状态里，
    // 免得用户在「为什么搜不出来」上绕圈。
    hint: !zg.installed
      ? 'zg 不可用：npm install -g @zvec/zvec-grep'
      : !info.indexed
        ? '还没有索引：跑 nx-kn index 建立索引'
        : idx && idx.stale
          ? `索引待更新（新增 ${idx.changes?.added ?? '?'} / 改动 ${idx.changes?.modified ?? '?'} 篇）——跑 nx-kn index`
          : undefined,
  };
}

// ---- query：混合检索 ----

// 给 agent 看的归属头：zg 的结果里只有 vault 内相对路径，没有「这是哪个库」——
// AI 拿到一个 `notes/x.md:12-20` 无法定位到磁盘上的文件。这一段把根目录补上，
// 沿用 nx-rp 已验证的做法（对 AI 消费结果很关键）。
export function attributionHeader(vault) {
  return [
    '[nx-kn 知识库召回]',
    `知识库根: ${vault}`,
    '命中路径为 vault 内相对路径；要读全文直接拼绝对路径: <知识库根>/<相对路径>',
    '',
  ].join('\n');
}

export async function query({ q, root, limit = 7, preview = 'short' } = {}) {
  const text = String(q ?? '').trim();
  if (!text) throw badInput('用法: nx-kn query <问句> —— 查询不能为空');

  const { dir } = await resolveVault(root);

  if (!hasIndex(dir)) {
    // 「还没建索引」是业务结果而非错误：面板要拿它渲染引导，不是弹错误框
    return { status: 'ok', needIndex: true, vault: dir, hint: `知识库还没有索引——先跑 nx-kn index` };
  }

  const r = await runZg(
    [
      'query',
      text,
      '--mode',
      'direct',
      // --fuse 是必须的，不是可选优化：不加它时 zg 会把问句**按词拆成多个查询分组**
      // （"Scenario / DSL / 场景怎么写" 各一组），每组各返回 limit 条并互相重复——
      // 实测一个三词问句回来 21 条命中，其中大半是同一条的不同分组副本。
      // 融合后是一条统一排序的列表，去重且 rank 更准。
      '--fuse',
      '--limit',
      String(limit),
      '--preview',
      preview,
    ],
    // query 没有 root 参数（zg 0.2.x），workspace 由子进程 cwd 解析 —— 必须 cwd=vault
    { cwd: dir, timeoutMs: 120_000 }
  );
  assertZgOk(r, '检索');

  const parsed = parseQuery(r.stdout);
  return {
    status: 'ok',
    vault: dir,
    query: text,
    limit,
    preview,
    elapsedMs: r.elapsedMs,
    hits: parsed.hits,
    groups: parsed.groups,
    notes: parsed.notes,
    header: attributionHeader(dir),
    text: r.stdout.trim(),
  };
}

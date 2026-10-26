// obsidian 域：vault 定位、规范文档登记、以及 vault 里的双链修复动作。
//
// 这一域回答两类问题：
//   1. 「内容规范文档在哪、里面写了什么」——配置 + 登记 + 读取
//   2. 「vault 里有哪些未解析双链 / 新笔记的 frontmatter 怎么写 / 写完有没有引入新红链」
//      ——原 repair skill 自带的三个 Python 脚本，现在都是这里的命令
//
// 解析链（vault）：--vault 参数 > store 配置 > 环境变量 NX_OBSIDIAN_VAULT
//                 > 第一个含 .obsidian/ 的 kb 登记库 > 从当前目录沿父目录找 .obsidian
//
// **兜底只在「未设置」时发生，不在「设了但坏了」时发生**：store 里明确指过的 vault
// 从磁盘上消失，必须如实报出来（vaultExists:false + hint）。静默换一个 vault
// 等于把配置错误藏起来——agent 会拿着错误的规范写一堆笔记，事后没人知道为什么。
//
// 错误契约（见 core/errors）：只有 set() 会抛（参数非法 / 目标不存在）；
// get() / spec() / scan() / frontmatter() / check() 未配置时返回
// **业务结果** {configured:false, hints:[...]}，不是错误——
// 调用方（skill / 面板）要能把它当正常状态渲染，而不是当成失败。
import fsp from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { badInput, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import {
  APP_NAME,
  OBSIDIAN_VAULT_ENV,
  assertSafeRelPath,
  obsidianVaultFromEnv,
} from '../../core/paths.js';
import {
  findLinkSources,
  findVaultRoot,
  genFrontmatterYaml,
  pythonTrim,
  readVaultText,
  sanitizeName,
  scanVaultUnresolved,
  splitExt,
  baseName,
} from '../../core/obsidian-links.js';
import { probeObsidianCli, runObsidianUnresolved, cliDisabled } from '../../core/obsidian-cli.js';

// 写入口的白名单：顶层键 + `docs.<key>` 形式。
export const OBSIDIAN_KEYS = ['vault'];
export const OBSIDIAN_DOCS_PREFIX = 'docs.';

// 登记表项的 key 名：只允许字母数字下划线连字符（命令行里好打，也不会撞上路径分隔符）。
const DOC_KEY_RE = /^[A-Za-z0-9_-]+$/;

// ---- vault 解析 ----

// 六条命令共用一条链。flagVault 来自 `--vault` 参数（最高优先级）。
export async function resolveVault({ flagVault } = {}) {
  const store = await loadStore();
  const config = store.obsidian || { vault: '', docs: {} };

  if (flagVault) return { vault: resolve(String(flagVault)), source: 'flag', config };
  if (config.vault) return { vault: resolve(config.vault), source: 'store', config };

  const fromEnv = obsidianVaultFromEnv();
  if (fromEnv) return { vault: resolve(fromEnv), source: 'env', config };

  for (const v of (store.kb && store.kb.vaults) || []) {
    if (!v || !v.path) continue;
    const p = resolve(String(v.path));
    if (existsSync(join(p, '.obsidian'))) return { vault: p, source: 'kb', config };
  }

  // 最后一段兜底：从当前目录沿父目录找 .obsidian（移植自原 Python 脚本）。
  // 这一段让「站在 vault 里直接跑命令」开箱可用——那是脚本时代最常见的用法。
  const walked = findVaultRoot(process.cwd());
  if (walked) return { vault: walked, source: 'cwd', config };

  return { vault: null, source: null, config };
}

// 登记表：key → 相对 vault 根的路径。
function docsOf(config) {
  const docs = (config && config.docs) || {};
  const out = {};
  for (const [k, v] of Object.entries(docs)) {
    if (DOC_KEY_RE.test(k) && typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

// 把登记表解析成带绝对路径与存在性的列表。
async function resolveDocs(vault, config) {
  const docs = docsOf(config);
  const out = [];
  for (const [key, rel] of Object.entries(docs)) {
    const abs = vault ? join(vault, rel) : null;
    out.push({
      key,
      rel,
      path: abs,
      exists: abs ? existsSync(abs) : false,
    });
  }
  return out;
}

// ---- 全量解析（管理视图 / get 用）----
export async function resolvePaths({ flagVault } = {}) {
  const { vault, source, config } = await resolveVault({ flagVault });
  const out = { status: 'ok', configured: !!vault, source, vault, config: { vault: config.vault || '', docs: docsOf(config) } };

  if (!vault) {
    out.hints = [
      `vault 未设置 —— 跑 ${APP_NAME} obsidian set vault=<vault绝对路径>`,
      `临时用可设环境变量 ${OBSIDIAN_VAULT_ENV}=<绝对路径>（原 skill 自带的 python 脚本也认它）`,
      `或先 ${APP_NAME} kb add <目录>：第一个含 .obsidian/ 的登记库会作为兜底`,
      `也可以直接站在 vault 目录里跑命令——会沿父目录找 .obsidian`,
    ];
    return out;
  }

  out.vaultExists = isDir(vault);
  out.hasObsidianMarker = existsSync(join(vault, '.obsidian'));
  out.docs = await resolveDocs(vault, config);

  const hints = [];
  if (source === 'cwd') {
    // cwd 上溯是整条链里唯一「猜」出来的一段：在项目根里跑命令时，
    // 沿父目录找到的 .obsidian 很可能不是用户心里那个库——明说，让人确认。
    hints.push(
      `vault 是从当前目录沿父目录找到的（cwd 上溯）——如果你在别的项目里跑命令，请确认这是不是你要的库；不是就用 ${APP_NAME} obsidian set vault=<路径> 登记一次`
    );
  }
  if (!out.vaultExists) {
    hints.push(`vault 目录不存在: ${vault} —— 移动 / 改名后用 ${APP_NAME} obsidian set vault=<新路径> 更新`);
  } else if (!out.hasObsidianMarker) {
    hints.push(`未发现 .obsidian/：不像 Obsidian vault`);
  }
  for (const d of out.docs) {
    if (d.exists) continue;
    hints.push(`规范文档缺失: ${d.path} —— 把规范写进这个文件，或 ${APP_NAME} obsidian set ${OBSIDIAN_DOCS_PREFIX}${d.key}=<相对路径> 指向已有文件`);
  }
  out.hints = hints;
  return out;
}

export async function get({ flagVault } = {}) {
  return resolvePaths({ flagVault });
}

// ---- 规范文档：登记 / 读取 ----

/**
 * 取规范文档。
 * - 不带 doc：列出登记表（key → 相对路径 → 绝对路径 → 是否存在）
 * - 带 doc：读出**全文**（skill 用它拿「内容要求」，不用自己找路径）
 */
export async function spec({ doc, flagVault } = {}) {
  const r = await resolvePaths({ flagVault });
  if (!r.configured) return { status: 'ok', configured: false, hints: r.hints };

  if (!doc) {
    return {
      status: 'ok',
      configured: true,
      source: r.source,
      vault: r.vault,
      docs: r.docs,
      ...(r.hints.length ? { hints: r.hints } : {}),
    };
  }

  const found = r.docs.find((d) => d.key === doc);
  if (!found) {
    const keys = r.docs.map((d) => d.key).join(', ') || '(无)';
    throw notFound(`规范文档未登记: ${doc}（已登记: ${keys}）—— 用 ${APP_NAME} obsidian set ${OBSIDIAN_DOCS_PREFIX}${doc}=<相对路径> 登记`);
  }
  if (!found.exists) {
    throw notFound(`规范文档不存在: ${found.path} —— 把规范写进这个文件，或改登记指向已有文件`);
  }

  const content = readVaultText(found.path);
  return {
    status: 'ok',
    configured: true,
    key: found.key,
    rel: found.rel,
    path: found.path,
    exists: true,
    bytes: Buffer.byteLength(content, 'utf8'),
    content,
  };
}

// ---- 读笔记内容 ----

/**
 * 读一篇 vault 笔记的内容（「内容获取走指令」的落点）。
 *
 * agent 不再直接 Read/Grep 拿笔记正文——直接 Read 遇到 GBK / BOM 文件会拿到
 * 乱码，而这里走的解码链与 scan / frontmatter 是**同一条**（口径一致：
 * scan 说这几行有链接，read 出来的就是那段原文）。行号 1 起、含端点，
 * 可直接用于「文件:行号」式引用与 `--from`/`--to` 精确复读。
 */
export async function read({ file, from, to, flagVault } = {}) {
  const { vault } = await resolveVault({ flagVault });
  if (!vault) {
    return { status: 'ok', configured: false, hints: (await resolvePaths({ flagVault })).hints };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);

  const rel = assertSafeRelPath(file, { label: '笔记路径' });
  const abs = join(vault, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw notFound(`笔记不存在: ${rel}（vault: ${vault}）`);
  }

  const text = readVaultText(abs);
  const all = text.split('\n');
  const total = all.length;
  const a = normLineNo(from, 1, total, 'from');
  const b = normLineNo(to, total, total, 'to');
  if (a > b) {
    throw badInput(`行区间反了: --from ${a} > --to ${b}`);
  }

  return {
    status: 'ok',
    configured: true,
    vault,
    file: rel,
    path: abs,
    total,
    from: a,
    to: b,
    bytes: Buffer.byteLength(text, 'utf8'),
    lines: all.slice(a - 1, b).map((t, i) => ({ n: a + i, text: t })),
  };
}

// 行号归一：空值给默认；非整数 / 越界直接报——**不是 clamp**，
// clamp 会把算错的行号变成「读到了」的假象（读到别处还以为自己读了原文）。
function normLineNo(v, dflt, max, label) {
  if (v === undefined || v === null || v === '') return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) {
    throw badInput(`--${label} 必须是正整数: ${v}`);
  }
  if (n > max) {
    throw badInput(`--${label} 超出范围: ${n}（全文共 ${max} 行）`);
  }
  return n;
}

// ---- set：写配置 ----

const VALIDATORS = {
  // 绝对路径：resolve 接受相对（对齐 kb add），存在性严格；空串 = 清除。
  vault: (v) => {
    if (!v) return '';
    const abs = resolve(String(v));
    if (!isDir(abs)) throw notFound(`vault 目录不存在: ${abs}（填的是: ${v}）`);
    return abs;
  },
};

// 登记项的校验：相对 vault 根的路径；空值 = 注销这一项。
function validateDocPath(value, key) {
  if (!value) return '';
  return assertSafeRelPath(value, { label: `规范文档路径（${key}）` });
}

export async function set({ patch = {} } = {}) {
  const keys = Object.keys(patch || {});
  if (!keys.length) return { status: 'ok', skipped: true, ...(await resolvePaths()) };

  const unknown = keys.filter(
    (k) => k !== 'vault' && !(k.startsWith(OBSIDIAN_DOCS_PREFIX) && DOC_KEY_RE.test(k.slice(OBSIDIAN_DOCS_PREFIX.length)))
  );
  if (unknown.length) {
    throw badInput(`未知的 obsidian 配置键: ${unknown.join(', ')}（允许: vault / ${OBSIDIAN_DOCS_PREFIX}<key>）`);
  }

  const validatedVault = {};
  const validatedDocs = {};
  for (const k of keys) {
    if (k === 'vault') {
      validatedVault.vault = VALIDATORS.vault(patch[k]);
      continue;
    }
    const docKey = k.slice(OBSIDIAN_DOCS_PREFIX.length);
    validatedDocs[docKey] = validateDocPath(patch[k], docKey);
  }

  await mutateStore((store) => {
    const obsidian = store.obsidian || { vault: '', docs: {} };
    if (validatedVault.vault !== undefined) obsidian.vault = validatedVault.vault;
    const docs = { ...(obsidian.docs || {}) };
    for (const [k, v] of Object.entries(validatedDocs)) {
      if (v) docs[k] = v;
      else delete docs[k]; // 空值 = 注销
    }
    obsidian.docs = docs;
    store.obsidian = obsidian;
    return store.obsidian;
  });

  const r = await resolvePaths();
  return { status: 'ok', written: keys, ...r };
}

// ---- 扫未解析双链 ----

/**
 * 扫 vault 里未解析的双链。
 *
 * 优先用外部 obsidian CLI（它与 Obsidian 实际解析最接近），
 * 拿不到就回退内置解析——**不因为外部 CLI 不可用而失败**。
 * 输出里的 via 字段标明实际来源，便于排查「两台机器结果不同」。
 */
export async function scan({ flagVault, out, project } = {}) {
  const { vault, source } = await resolveVault({ flagVault });
  if (!vault) {
    return {
      status: 'ok',
      configured: false,
      count: 0,
      links: [],
      hints: (await resolvePaths({ flagVault })).hints,
    };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);

  // 扫描范围：给了 --project 就只看该项目的目录（多项目并发时的隔离边界）。
  const scope = project ? projectScopeOf(vault, project) : null;

  let via = 'builtin';
  let links = null;
  let cliNote;

  // 有范围时不走外部 CLI：它只能扫整个 vault，没有「只看某个项目」的概念，
  // 用了就会绕过隔离（看到别的项目的红链 → 越界去动别人的笔记）。
  if (!cliDisabled() && !scope) {
    const probe = await probeObsidianCli();
    if (probe.available) {
      const r = await runObsidianUnresolved(vault);
      if (r.ok) {
        via = 'cli';
        links = normalizeCliItems(r.items);
      } else {
        cliNote = `obsidian CLI 不可用（${r.error}）—— 已回退内置解析`;
      }
    } else {
      cliNote = probe.reason ? `未使用 obsidian CLI：${probe.reason}` : undefined;
    }
  }

  if (!links) links = scanVaultUnresolved(vault, { scanRoot: scope ? scope.rel : '' });

  if (out) {
    const target = isAbsolute(out) ? out : join(vault, out);
    await fsp.writeFile(target, JSON.stringify(links, null, 2) + '\n', 'utf8');
  }

  const hints = [];
  if (scope && !scope.exists) {
    hints.push(
      `项目目录还没初始化: ${scope.abs} —— 先跑 ${APP_NAME} obsidian ask --project ${scope.projectAbs} 建根文档`
    );
  }

  return {
    status: 'ok',
    configured: true,
    via,
    source,
    vault,
    ...(scope
      ? { scope: scope.rel, scopeExists: scope.exists, project: scope.projectAbs, projectName: scope.projectName }
      : { scope: null }),
    count: links.length,
    links,
    ...(cliNote ? { note: cliNote } : {}),
    ...(hints.length ? { hints } : {}),
    ...(out ? { out: isAbsolute(out) ? out : join(vault, out) } : {}),
  };
}

// 外部 CLI 的条目形状与内置扫描对齐：{ link, sources: [{file, line}] }。
function normalizeCliItems(items) {
  const out = [];
  for (const it of items || []) {
    if (!it || typeof it.link !== 'string') continue;
    let sources = it.sources;
    if (typeof sources === 'string') {
      // 旧 CLI 可能给字符串；统一成数组，元素退化成 file 字符串
      sources = sources ? [{ file: sources, line: 0 }] : [];
    }
    if (!Array.isArray(sources)) sources = [];
    out.push({
      link: it.link,
      sources: sources.map((s) =>
        typeof s === 'string' ? { file: s, line: 0 } : { file: String((s && s.file) || ''), line: Number((s && s.line) || 0) }
      ),
    });
  }
  return out;
}

// ---- 生成 frontmatter ----

/**
 * 生成新笔记的 frontmatter YAML 段。
 *
 * bklink 的来源顺序（照搬 Python 版）：先 `--source` 指向的那篇，
 * 再 `--locate` 找到的所有引用源（去重，先到先得）。
 * `--source` 指向的文件**不需要存在**——脚本从不打开它。
 *
 * `project`（项目解读模式）：把「这篇文档讲的是哪个代码库」写进 frontmatter
 * （`project: <绝对路径>`）。后续对这篇文档做双链拷问时，agent 读到这个字段
 * 就知道答案要从哪份源码里找，而不是只复述文档。
 *
 * `spec`（规范/风格文档链接）：`--spec <key>[,<key>…]`，key 必须已在
 * `docs.<key>` 登记且文件存在。命中后在 YAML 里追加 `spec:` wiki 链接列表
 * （stem = basename 去 ext，与 bklink 同口径），让「按这份规范写的笔记」
 * 与规范文档之间有结构化关联（Dataview / 反链可查）。校验口径与 spec 指令
 * 一致——未登记 / 文件缺失直接报错并给出登记命令，不静默跳过。
 */
export async function frontmatter({ link, source, locate, project, spec, flagVault } = {}) {
  const { vault, source: vaultSource } = await resolveVault({ flagVault });
  if (!vault) {
    return {
      status: 'ok',
      configured: false,
      hints: (await resolvePaths({ flagVault })).hints,
    };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);

  let projectAbs;
  if (project) {
    if (!isAbsolute(String(project))) {
      throw badInput(`项目根必须是绝对路径: ${project}（项目解读模式需要明确区分项目根与 vault 根）`);
    }
    projectAbs = resolve(String(project));
    if (!isDir(projectAbs)) throw notFound(`项目目录不存在: ${projectAbs}（填的是: ${project}）`);
  }

  const bklink = [];
  if (source) {
    const [stem] = splitExt(baseName(String(source)));
    if (stem) bklink.push(stem);
  }
  const located = [];
  if (locate || !source) {
    for (const s of findLinkSources(vault, String(link))) {
      const [stem] = splitExt(baseName(s.file));
      if (stem && !bklink.includes(stem)) bklink.push(stem);
      located.push(s);
    }
  }

  // --spec <key>[,<key>…]：规范/风格文档 → frontmatter 里的 spec: wiki 链接。
  // 逗号分隔支持多篇；重复 key 只校验/收录一次（core 里再按 stem 去重，双保险）。
  const specStems = [];
  const specMeta = [];
  const specKeys = new Set();
  const specArg = String(spec || '').trim();
  if (specArg) {
    const r = await resolvePaths({ flagVault });
    for (const key of specArg.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (specKeys.has(key)) continue; // 重复 key 只校验/收录一次
      specKeys.add(key);
      const found = r.docs.find((d) => d.key === key);
      if (!found) {
        const registered = r.docs.map((d) => d.key).join(', ') || '(无)';
        throw notFound(
          `规范文档未登记: ${key}（已登记: ${registered}）—— 用 ${APP_NAME} obsidian set ${OBSIDIAN_DOCS_PREFIX}${key}=<相对路径> 登记`
        );
      }
      if (!found.exists) {
        throw notFound(`规范文档不存在: ${found.path} —— 把规范写进这个文件，或改登记指向已有文件`);
      }
      const [stem] = splitExt(baseName(found.rel));
      if (stem && !specStems.includes(stem)) specStems.push(stem);
      specMeta.push({ key, rel: found.rel, stem });
    }
  }

  const yaml = genFrontmatterYaml({ bklink, specs: specStems, extra: projectAbs ? { project: projectAbs } : null });
  return {
    status: 'ok',
    configured: true,
    vault,
    source: vaultSource,
    link: String(link),
    filename: `${sanitizeName(String(link))}.md`,
    ...(projectAbs ? { project: projectAbs } : {}),
    bklink,
    located,
    ...(specMeta.length ? { spec: specMeta } : {}),
    yaml,
  };
}

// ---- 校验：新笔记有没有引入新的未解析双链 ----

/**
 * 两个模式（照搬 Python 版 postcheck.py）：
 *   1. `--snapshot <file>`：把当前未解析链接存成快照
 *   2. `--snapshot-before <file> --new-file <rel>`：与快照比对，列出**新引入**的
 *
 * diff 是**全库集合差**（after − before），不按新文件过滤——新文件路径只用于文案。
 * 「引入了新的未解析双链」是**业务结果**（passed:false），不是错误。
 */
export async function check({ snapshot, snapshotBefore, newFile, flagVault, project } = {}) {
  const { vault } = await resolveVault({ flagVault });
  if (!vault) {
    return {
      status: 'ok',
      configured: false,
      passed: false,
      hints: (await resolvePaths({ flagVault })).hints,
    };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);

  // after-scan 与 scan 同一套范围：只 check 自己项目目录下的红链。
  const current = await scan({ flagVault, project });

  if (snapshot) {
    const target = isAbsolute(snapshot) ? snapshot : join(vault, snapshot);
    const map = {};
    for (const item of current.links) map[item.link] = item.sources;
    await fsp.writeFile(target, JSON.stringify(map, null, 2) + '\n', 'utf8');
    return {
      status: 'ok',
      configured: true,
      mode: 'snapshot',
      vault,
      snapshot: target,
      count: Object.keys(map).length,
    };
  }

  if (!snapshotBefore || !newFile) {
    throw badInput(
      `用法: ${APP_NAME} obsidian check --snapshot <文件>  或  ${APP_NAME} obsidian check --snapshot-before <文件> --new-file <相对路径> —— 两者至少给一组`
    );
  }

  const beforePath = isAbsolute(snapshotBefore) ? snapshotBefore : join(vault, snapshotBefore);
  let before;
  try {
    before = JSON.parse(await fsp.readFile(beforePath, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      throw notFound(`快照文件不存在: ${beforePath} —— 先跑一次 ${APP_NAME} obsidian check --snapshot <文件>`);
    }
    throw badInput(`快照文件读不出来（不是合法 JSON?）: ${beforePath} —— ${(e && e.message) || e}`);
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) {
    throw badInput(`快照文件格式不对（应当是 {链接: 来源} 的对象）: ${beforePath}`);
  }

  const beforeKeys = new Set(Object.keys(before));
  const newUnresolved = current.links
    .filter((item) => !beforeKeys.has(item.link))
    .map((item) => ({ link: item.link, sources: item.sources }));

  return {
    status: 'ok',
    configured: true,
    mode: 'diff',
    vault,
    newFile: String(newFile),
    before: beforeKeys.size,
    after: current.links.length,
    passed: newUnresolved.length === 0,
    newUnresolved,
  };
}

// ---- 项目域提问：位置初始化的唯一入口 ----

// 项目名推导（项目解读 SOP 的规则）：package.json → Cargo.toml → pyproject.toml → 目录名。
// scope 前缀（@org/pkg）去掉——vault 路径里不该出现 @。
// ---- 项目范围（多项目并发时的隔离边界）----
//
// 「自己的项目」= vault 里的 projects/<项目名>/ 目录（项目名按 ask 的同一套规则推导）。
// 扫描与校验都只在这个目录里收集链接——两个项目同时跑，各自动自己那份，互不打扰。
//
// 注意**解析仍对照全库**：链到共享笔记 / 别的项目的笔记不算红链，
// 否则 agent 会跑去重复建一份——那才是真正破坏隔离的地方。
function projectScopeOf(vault, project) {
  const projectAbs = resolve(String(project));
  if (!isDir(projectAbs)) {
    throw notFound(`项目目录不存在: ${projectAbs}（项目域扫描必须绑定一个真实存在的代码库）`);
  }
  const projectName = sanitizeName(projectNameOf(projectAbs));
  const rel = `projects/${projectName}`;
  return { projectAbs, projectName, rel, abs: join(vault, rel), exists: isDir(join(vault, rel)) };
}

function projectNameOf(root) {
  try {
    const pkg = JSON.parse(readVaultText(join(root, 'package.json')));
    if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) return pkg.name.trim().split('/').pop();
  } catch {
    /* 没有 package.json 或不是合法 JSON，试下一个 */
  }
  for (const file of ['Cargo.toml', 'pyproject.toml']) {
    const m = readVaultText(join(root, file)).match(/^\s*name\s*=\s*["']([^"']+)["']/m);
    if (m) return m[1].trim().split('/').pop();
  }
  return baseName(root);
}

/**
 * 项目域提问的唯一入口——「不要让 agent 自己决定位置」就靠这条命令兜住。
 *
 * 做且只做三件事：
 *   1. 定位 / 首次初始化 `<vault>/projects/<项目名>/Base-<项目名>.md`
 *      （根文档 = 树根：frontmatter 带 project 绑定，正文只有标题；不放清单 / 树 / 索引）
 *   2. 带提问时：把提问清洗成合法文件名，以 `[[清洗后]]` **追加到根文档末尾**；
 *      同一提问重复提交不重复追加（幂等）
 *   3. 返回标准 9 步流程要用的全部定位信息（base 相对路径 / 追加行号 / 答案笔记路径 / 项目根）
 *
 * 除根文档外**不创建任何结构文件**——树靠 bklink 长出来，索引类文件一律不建。
 * 不带 `--question` 时只做 1 和 3（项目解读首次建树的入口）。
 */
export async function ask({ question, project, source, flagVault } = {}) {
  const original = pythonTrim(String(question ?? ''));

  const { vault, source: vaultSource } = await resolveVault({ flagVault });
  if (!vault) {
    return { status: 'ok', configured: false, hints: (await resolvePaths({ flagVault })).hints };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);

  const projectAbs = resolve(String(project || process.cwd()));
  if (!isDir(projectAbs)) {
    throw notFound(`项目目录不存在: ${projectAbs}（项目域提问必须绑定一个真实存在的代码库）`);
  }

  const projectName = sanitizeName(projectNameOf(projectAbs));
  const dirRel = `projects/${projectName}`;
  const baseRel = `${dirRel}/Base-${projectName}.md`;
  const baseAbs = join(vault, baseRel);

  // 提问清洗成合法文件名：`* " \ / < > : | ?` 会被 sanitizeName 去掉（`, . ?` 里只剩
  // `?` 非法）——保证 `[[清洗后]]` 能被 `projects/<项目名>/<清洗后>.md` 这个文件解析。
  // 原文与清洗后的差异如实返回，agent 不需要再做一次「格式重写」判断。
  const hasQuestion = original.length > 0;
  const link = hasQuestion ? sanitizeName(original) : null;

  const baseExisted = existsSync(baseAbs);
  let text;
  if (baseExisted) {
    text = readVaultText(baseAbs);
  } else {
    // 首次初始化：frontmatter 只带 project 绑定（bklink 空 = 树根没有父节点）；正文只有标题。
    text = `${genFrontmatterYaml({ bklink: [], extra: { project: projectAbs } })}\n\n# ${projectName}\n`;
  }

  const base = { rel: baseRel, abs: baseAbs, existed: baseExisted, created: !baseExisted };

  // 目标笔记的 frontmatter：**这是「两条关系」的载体**，由脚本生成、agent 照抄。
  //
  //   bklink: [Base-<项目名>, <问题链接>]   ← 根文档（父）+ 问题本身
  //   project: <项目根>                     ← 文档 ↔ 代码库的绑定
  //
  // 「Base ↔ 目标」与「问题 source 文档 ↔ 目标」这两条关系都靠同一个 `[[问题]]` 链接成立：
  // Base 里那一条由本命令追加；source 文档里那一条是用户自己写的。
  // 两条都在是**正常且预期**的——不是重复，是两个入口指向同一篇答案笔记。
  const noteBkl = [`Base-${projectName}`, link].filter(Boolean);
  const noteFrontmatter = link ? genFrontmatterYaml({ bklink: noteBkl, extra: { project: projectAbs } }) : null;

  // 问题出处（vault 内相对路径）：核对那篇文档里确实有这个双链。
  // 「出处」是关系的一端，agent 可能给错——如实回报，不猜。
  let sourceInfo = null;
  if (source) {
    const sourceRel = String(source).replace(/\\/g, '/');
    const hit = findLinkSources(vault, link).find((s) => s.file === sourceRel) || null;
    sourceInfo = { rel: sourceRel, hasLink: !!hit, line: hit ? hit.line : null };
  }

  if (!hasQuestion) {
    if (!baseExisted) {
      await fsp.mkdir(join(vault, dirRel), { recursive: true });
      await fsp.writeFile(baseAbs, text, 'utf8');
    }
    return {
      status: 'ok',
      configured: true,
      vault,
      source: vaultSource,
      project: projectAbs,
      projectName,
      base,
      source: sourceInfo,
      question: null,
      appended: false,
      duplicate: false,
      line: null,
      note: null,
    };
  }

  // 幂等：同一提问已在根文档里 → 不重复追加，只回报它所在的行号。
  const marker = `[[${link}]]`;
  const existingLine = text.split('\n').findIndex((line) => line.includes(marker));
  if (existingLine >= 0) {
    return {
      status: 'ok',
      configured: true,
      vault,
      source: vaultSource,
      project: projectAbs,
      projectName,
      base,
      source: sourceInfo,
      question: { original, link, rewritten: link !== original },
      appended: false,
      duplicate: true,
      line: existingLine + 1,
      note: {
        dir: dirRel,
        path: `${dirRel}/${link}.md`,
        filename: `${link}.md`,
        frontmatter: noteFrontmatter,
      },
    };
  }

  // 追加到末尾（保证恰好一个换行收尾），并算出落点行号（1 起）。
  const endsWithNewline = text.endsWith('\n');
  const newText = endsWithNewline ? `${text}${marker}\n` : `${text}\n${marker}\n`;
  const line = endsWithNewline ? text.split('\n').length : text.split('\n').length + 1;
  await fsp.mkdir(join(vault, dirRel), { recursive: true });
  await fsp.writeFile(baseAbs, newText, 'utf8');

  return {
    status: 'ok',
    configured: true,
    vault,
    source: vaultSource,
    project: projectAbs,
    projectName,
    base,
    source: sourceInfo,
    question: { original, link, rewritten: link !== original },
    appended: true,
    duplicate: false,
    line,
    note: {
      dir: dirRel,
      path: `${dirRel}/${link}.md`,
      filename: `${link}.md`,
      frontmatter: noteFrontmatter,
    },
    relations: [
      `Base ↔ 目标：根文档第 ${line} 行的 [[${link}]]`,
      sourceInfo
        ? `出处 ↔ 目标：${sourceInfo.rel}${sourceInfo.hasLink ? ` 第 ${sourceInfo.line} 行` : '（那里没有这个双链，请核对出处）'}`
        : `出处 ↔ 目标：由 Base 第 ${line} 行的 [[${link}]] 建立`,
    ],
    next:
      `Write ${dirRel}/${link}.md —— 内容 = 返回的 note.frontmatter + 空行 + 正文（frontmatter 照抄，不要自己编）` +
      `；正文必须是「回答这个问句」的实质内容（读源码 / 读资料后写出来的答案），` +
      `不是「这条问句是什么」的说明`,
  };
}

function isDir(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

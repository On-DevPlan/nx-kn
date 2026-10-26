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
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { badInput, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import {
  APP_NAME,
  OBSIDIAN_VAULT_ENV,
  assertSafeName,
  assertSafeRelPath,
  dataDirFromEnv,
  obsidianVaultFromEnv,
} from '../../core/paths.js';
import {
  findLinkSources,
  findVaultRoot,
  formatLocalTimestamp,
  genFrontmatterYaml,
  listVaultMarkdown,
  pythonTrim,
  readVaultText,
  sanitizeName,
  scanVaultUnresolved,
  splitExt,
  baseName,
} from '../../core/obsidian-links.js';
import { probeObsidianCli, runObsidianUnresolved, cliDisabled } from '../../core/obsidian-cli.js';
import { buildZip, readZip } from '../../core/zip.js';

// 写入口的白名单：顶层键 + `docs.<key>` 形式。
export const OBSIDIAN_KEYS = ['vault'];
export const OBSIDIAN_DOCS_PREFIX = 'docs.';

// 迁移包写进 manifest 的版本标识（包里的 `app` 字段用它，便于事后知道谁导出的）。
const VERSION = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version;

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
export async function scan({ flagVault, out, project, projectName } = {}) {
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
  const scope = project ? projectScopeOf(vault, project, projectName) : null;

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
      `项目目录还没初始化: ${scope.abs} —— 先跑 ${APP_NAME} obsidian ask --project ${scope.projectAbs} ${PROJECT_NAME_FLAG} ${scope.projectName} 建根文档（把名字显式固定下来，别让推导再变一次）`
    );
  }

  return {
    status: 'ok',
    configured: true,
    via,
    source,
    vault,
    ...(scope
      ? {
          scope: scope.rel,
          scopeExists: scope.exists,
          project: scope.projectAbs,
          projectName: scope.projectName,
          projectNameSource: scope.nameSource,
        }
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

// ---- 项目清单：vault 里 projects/ 下的项目树 ----
//
// 只读枚举，**不创建任何东西**：项目由目录约定 `<vault>/projects/<项目名>/` 定义，
// 根文档 `Base-<项目名>.md` 的唯一创建入口是 ask()——这里缺了只报告、不补。
// 「同一件事两个入口迟早只改一边」：如果这里顺手建根文档，两条路径的 frontmatter
// 形状迟早漂移（ask 里那份带 project 绑定，这份不会带）。
//
// 红链数复用**一次**全库扫描的结果按「源文件属于哪个项目」分摊：
// N 个项目共享一次读盘，而不是每个项目重扫一遍（那是 O(N × 库大小)）。
export async function projects({ flagVault } = {}) {
  const { vault, source } = await resolveVault({ flagVault });
  if (!vault) {
    const r = await resolvePaths({ flagVault });
    return { status: 'ok', configured: false, hints: r.hints || [] };
  }

  const rootRel = 'projects';
  const rootAbs = join(vault, rootRel);
  if (!isDir(rootAbs)) {
    return {
      status: 'ok',
      configured: true,
      source,
      vault,
      root: rootRel,
      count: 0,
      projects: [],
      hints: [
        `还没有 ${rootRel}/ 目录 —— 项目解读首次运行时跑 ${APP_NAME} obsidian ask --project <项目根> 会创建`,
      ],
    };
  }

  const unresolvedByProject = new Map();
  for (const link of scanVaultUnresolved(vault)) {
    const owners = new Set();
    for (const s of link.sources || []) {
      const m = /^projects\/([^/]+)\//.exec(String((s && s.file) || ''));
      if (m) owners.add(m[1]);
    }
    // 一条红链在一个项目里出现多次（多文件引用）只算一条
    for (const name of owners) unresolvedByProject.set(name, (unresolvedByProject.get(name) || 0) + 1);
  }

  const all = listVaultMarkdown(vault);
  const entries = readdirSync(rootAbs, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const out = [];
  for (const e of entries) {
    const rel = `${rootRel}/${e.name}`;
    const mine = all.filter((f) => f.startsWith(`${rel}/`));
    const baseRel = `${rel}/Base-${e.name}.md`;
    const hasBase = mine.includes(baseRel);
    let updated = 0;
    const documents = mine.map((f) => {
      try {
        const st = statSync(join(vault, f));
        if (st.mtimeMs > updated) updated = st.mtimeMs;
      } catch {
        /* 文件在两次读之间被删：时间统计跳过，文档仍列出 */
      }
      return { file: f.slice(rel.length + 1), title: firstHeading(vault, f) };
    });

    out.push({
      name: e.name,
      rel,
      docs: documents.length,
      base: hasBase ? baseRel : null,
      // 代码库绑定：只有 Base 根文档的 frontmatter 里才有 `project:`。
      // 面板要显示「这个项目对应哪个代码库」，而绑定就写在根文档里——
      // 与其让前端再发一次请求、再实现一遍「相对路径 → 绝对路径」的拼接，
      // 不如在这里顺手读一次根文档（N 个项目 = N 次小读，与已做的逐篇取 H1 同量级）。
      // 读不出来一律 null：手写的 Base 可能根本没有这一行，那不是错误。
      projectPath: hasBase ? bindingOfFile(join(vault, baseRel)) : null,
      updatedAt: updated ? formatLocalTimestamp(new Date(updated)) : null,
      unresolved: unresolvedByProject.get(e.name) || 0,
      documents,
    });
  }

  const hints = [];
  const missingBase = out.filter((p) => !p.base).map((p) => p.name);
  if (missingBase.length) {
    hints.push(
      `缺根文档 Base-<项目名>.md: ${missingBase.join(', ')} —— 建根文档的唯一入口是 ` +
        `${APP_NAME} obsidian ask --project <项目根> ${PROJECT_NAME_FLAG} ${missingBase[0]}` +
        `（不自动补，避免两处形状漂移；名字必须显式给定，否则推导出来的名字可能和已有笔记的 bklink 错位）`
    );
  }

  return {
    status: 'ok',
    configured: true,
    source,
    vault,
    root: rootRel,
    count: out.length,
    projects: out,
    ...(hints.length ? { hints } : {}),
  };
}

// ---- 项目迁移：导出 / 导入 zip ----
//
// 迁移的本质不是「把文件拷过去」，而是保住三样东西：**目录名**（bklink 的目标）、
// **每个文件的字节**、**Base 里的 project 绑定**。前两样丢一个就变成红链，
// 第三样丢了就找不到源码。所以包里必须有 manifest：它声明「应该有哪些文件、
// 各自 sha256 多少」，导入端**以 manifest 为准**——zip 里多出来的条目一律忽略，
// 不认识的字节绝不落盘。
//
// `.zvec-grep` 索引**不进包**：它绑死绝对路径与 embedding 维度，换台机器必然失效；
// 带过去只会让检索静默返回旧结果（比没有索引更糟）。导入后重建即可。

const EXPORT_FORMAT = 'nx-kn/projects';
const EXPORT_VERSION = 1;
const MANIFEST_NAME = 'manifest.json';

/**
 * 导出一个或多个项目为 zip。
 *
 * `--name a,b` 按 vault 里已有的目录名挑（推荐：名字是目录名，人一眼能对上）；
 * `--all` 导出 projects/ 下全部。两者互斥——同时给就是没说清要哪个，报错。
 *
 * `--out` 必填：迁移是重操作，「导到哪」不该由默认值决定。
 * 相对路径按**当前工作目录**解析（不是 vault）——导出物通常要放到别处去。
 */
export async function exportProjects({ names, all, out, flagVault, transport } = {}) {
  const { vault, source } = await resolveVault({ flagVault });
  if (!vault) {
    return { status: 'ok', configured: false, hints: (await resolvePaths({ flagVault })).hints };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);

  const picked = pickProjects(vault, { names, all });

  const entries = [];
  const manifestProjects = [];
  const skipped = [];
  let fileBytes = 0;

  for (const name of picked) {
    const dirRel = `projects/${name}`;
    const dirAbs = join(vault, dirRel);
    const files = [];
    let projectPath = null;

    for (const rel of listProjectFiles(dirAbs)) {
      const abs = join(dirAbs, ...rel.split('/'));
      let buf;
      let mtime;
      try {
        buf = readFileSync(abs);
        mtime = statSync(abs).mtime;
      } catch {
        // 两次读之间被删 / 权限不足：如实记进 skipped，不假装导出完整
        skipped.push({ project: name, path: `${dirRel}/${rel}`, reason: '读取失败' });
        continue;
      }
      entries.push({ name: `${dirRel}/${rel}`, data: buf, mtime });
      files.push({ path: rel, size: buf.length, sha256: sha256(buf) });
      fileBytes += buf.length;
    }

    // project 绑定从 Base 取；没有根文档就是 null（不猜、不补）
    try {
      projectPath = projectBindingOf(readVaultText(join(dirAbs, `Base-${name}.md`)));
    } catch {
      projectPath = null;
    }

    manifestProjects.push({ name, dir: dirRel, projectPath, fileCount: files.length, files });
  }

  const manifest = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    createdAt: formatLocalTimestamp(),
    app: `${APP_NAME}@${VERSION}`,
    source: { vault, vaultSource: source },
    projects: manifestProjects,
    ...(skipped.length ? { skipped } : {}),
  };
  entries.unshift({ name: MANIFEST_NAME, data: `${JSON.stringify(manifest, null, 2)}\n` });

  const zip = buildZip(entries);

  const summary = {
    status: 'ok',
    configured: true,
    vault,
    bytes: zip.length,
    fileBytes,
    fileCount: entries.length - 1,
    projects: manifestProjects.map((p) => ({
      name: p.name,
      files: p.fileCount,
      bytes: p.files.reduce((s, f) => s + f.size, 0),
      projectPath: p.projectPath,
    })),
    ...(skipped.length ? { skipped } : {}),
  };

  // 不写 --out 有两种都合法的解释，按**通道**分开，而不是按「谁猜得准」：
  //   HTTP（面板点「导出」）→ 把 zip 交给浏览器下载，落点由浏览器决定；
  //   CLI（终端里敲）      → 就地落在当前工作目录，名字与面板下载完全一致。
  // 曾在这里对 CLI 直接报「--out 必填」：人只想导个包，却被迫先想好路径再敲一遍。
  // 默认落点不是猜——名字、内容都由服务端算，命令结束时把绝对路径打出来。
  const filename = exportFilename(picked, all);
  if (!out && transport === 'http') {
    return {
      ...summary,
      filename,
      download: { buffer: zip, filename, contentType: 'application/zip' },
    };
  }

  const defaultedOut = !out;
  const target = !out ? resolve(filename) : isAbsolute(String(out)) ? String(out) : resolve(String(out));
  // 同一秒内导两次会撞名。宁可加后缀，也不静默盖掉上一个包（那是不可逆的丢数据）。
  const outAbs = defaultedOut ? uniqueOutPath(target) : target;
  await fsp.mkdir(dirname(outAbs), { recursive: true });
  await fsp.writeFile(outAbs, zip);

  return {
    ...summary,
    out: outAbs,
    ...(defaultedOut ? { defaultedOut: true } : {}),
    next: `目标机器上：${APP_NAME} obsidian import --file "${outAbs}"`,
  };
}

// 同目录同名已存在时依次尝试 -2 / -3…；上限只是防御，正常一次就返回。
function uniqueOutPath(abs) {
  if (!existsSync(abs)) return abs;
  const dot = abs.lastIndexOf('.');
  const stem = dot > 0 ? abs.slice(0, dot) : abs;
  const ext = dot > 0 ? abs.slice(dot) : '';
  for (let i = 2; i < 100; i++) {
    const cand = `${stem}-${i}${ext}`;
    if (!existsSync(cand)) return cand;
  }
  return abs;
}

// 包名：kn-<项目|all>-<yyyyMMdd-HHmmss>.zip
// 项目名可能是中文/带点号，只换掉文件系统非法字符，不转拼音（人要在下载目录里认得出它）。
function exportFilename(names, all) {
  const ts = formatLocalTimestamp();
  const stamp = `${ts.slice(0, 10).replace(/-/g, '')}-${ts.slice(11, 19).replace(/:/g, '')}`;
  const part = all ? 'all' : names.join('+');
  const safe = part.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'projects';
  return `kn-${safe}-${stamp}.zip`;
}

// 挑要导出的项目。名字走 assertSafeName（拒 `..` / 分隔符 / 点开头），
// 并且**必须已存在**：导出阶段就报错，好过导出一个空包到别的机器才发现。
function pickProjects(vault, { names, all }) {
  const root = join(vault, 'projects');
  const raw = pythonTrim(String(names ?? ''));

  if (all && raw) throw badInput('--all 与 --name 只能给一个');
  if (!all && !raw) {
    throw badInput(`要导出哪些项目？给 ${APP_NAME} obsidian export --name <项目名>[,<项目名>...]，或 --all 导出全部`);
  }

  if (all) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      throw notFound(`vault 里没有 projects/ 目录: ${root}`);
    }
    const list = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    if (!list.length) throw notFound(`projects/ 下没有任何项目: ${root}`);
    return list;
  }

  const out = [];
  const seen = new Set();
  for (const name of raw.split(',').map((s) => pythonTrim(s)).filter(Boolean)) {
    if (seen.has(name)) continue; // 重复名字只导一次（zip 里不能有两条同名条目）
    seen.add(name);
    assertSafeName(name, '项目名');
    if (!isDir(join(root, name))) {
      throw notFound(`项目不存在: projects/${name}（先跑 ${APP_NAME} obsidian projects 看有哪些）`);
    }
    out.push(name);
  }
  return out;
}

// 递归列项目目录下的文件（相对项目目录、`/` 分隔、排序）。
// 跳过点开头的目录与文件：那是编辑器/系统残留（.obsidian、.DS_Store），不是知识内容。
function listProjectFiles(dirAbs, prefix = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listProjectFiles(join(dirAbs, e.name), rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 从 zip 导入项目。
 *
 * 三个默认值都是「不猜」的那一侧：
 *   - 目标已有同名项目 → **整体拒绝**（不做部分导入），加 `--force` 才覆盖，覆盖前整目录备份；
 *   - `project:` 里的绝对路径 → **原样保留**，只是如实报告「这路径在本机不存在」；
 *     要改写就显式给 `--project-path <绝对路径>`；
 *   - 只写 manifest 列过的文件 → 包里多出来的条目忽略并列入 `ignored`。
 *
 * 校验先全部跑完再动盘：任何一项不合格就一个文件都不写，避免留下半截项目。
 */
export async function importProjects({ file, uploadName, force, dryRun, projectPath, flagVault } = {}) {
  const { vault } = await resolveVault({ flagVault });
  if (!vault) {
    return { status: 'ok', configured: false, hints: (await resolvePaths({ flagVault })).hints };
  }
  if (!isDir(vault)) throw notFound(`vault 目录不存在: ${vault}`);
  if (!file) throw badInput(`--file 必填：要导入哪个 zip`);

  const zipAbs = isAbsolute(String(file)) ? String(file) : resolve(String(file));
  // 拖拽上传时 file 是服务端临时路径（跑完就删），回显给人看的是**原始文件名**
  const fileLabel = uploadName || zipAbs;
  let buf;
  try {
    buf = await fsp.readFile(zipAbs);
  } catch (e) {
    if (e && e.code === 'ENOENT') throw notFound(`zip 不存在: ${fileLabel}`);
    throw badInput(`zip 读不出来: ${fileLabel} —— ${(e && e.message) || e}`);
  }

  // readZip 已经拦掉：非 zip / 截断 / CRC 不符 / zip-slip / 解压超限 / 未知压缩方法
  const entries = readZip(buf);
  const byName = new Map(entries.map((e) => [e.name, e]));

  const manifestEntry = byName.get(MANIFEST_NAME);
  if (!manifestEntry) throw badInput(`这不是 ${APP_NAME} 的项目迁移包：缺 ${MANIFEST_NAME}`);
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.data.toString('utf8'));
  } catch (e) {
    throw badInput(`${MANIFEST_NAME} 不是合法 JSON —— ${(e && e.message) || e}`);
  }
  if (!manifest || manifest.format !== EXPORT_FORMAT) {
    throw badInput(`包格式不符: ${manifest && manifest.format}（期望 ${EXPORT_FORMAT}）`);
  }
  const version = Number(manifest.version);
  if (!Number.isFinite(version) || version > EXPORT_VERSION) {
    throw badInput(`包版本 ${manifest.version} 高于本机支持的 ${EXPORT_VERSION} —— 先升级 ${APP_NAME}`);
  }
  if (!Array.isArray(manifest.projects) || !manifest.projects.length) {
    throw badInput(`${MANIFEST_NAME} 里没有项目`);
  }

  const targetProjectPath = projectPath ? resolve(String(projectPath)) : null;
  if (targetProjectPath && !isDir(targetProjectPath)) {
    // 改写目标必须是真实代码库：写一个不存在的路径等于把绑定弄坏
    throw notFound(`--project-path 指向的目录不存在: ${targetProjectPath}`);
  }

  const plan = [];
  const problems = [];
  for (const p of manifest.projects) {
    const name = String((p && p.name) || '');
    try {
      assertSafeName(name, '项目名');
    } catch (e) {
      problems.push(`${name || '(空名)'}: ${(e && e.message) || e}`);
      continue;
    }
    if (!Array.isArray(p.files)) {
      problems.push(`${name}: manifest 缺 files 列表`);
      continue;
    }

    const missing = [];
    const mismatched = [];
    const files = [];
    for (const f of p.files) {
      const rel = String((f && f.path) || '');
      try {
        assertSafeRelPath(rel, { label: `项目 ${name} 的文件路径` });
      } catch {
        mismatched.push(`${rel || '(空)'}（路径非法）`);
        continue;
      }
      const entry = byName.get(`projects/${name}/${rel}`);
      if (!entry) {
        missing.push(rel);
        continue;
      }
      if (f.sha256 && sha256(entry.data) !== f.sha256) {
        mismatched.push(rel);
        continue;
      }
      files.push({ rel, data: entry.data, mtime: entry.mtime });
    }

    if (missing.length || mismatched.length) {
      const detail = [...missing, ...mismatched].slice(0, 3).join(', ');
      problems.push(
        `${name}: ${missing.length ? `缺 ${missing.length} 个文件` : ''}` +
          `${mismatched.length ? `${missing.length ? ' / ' : ''}${mismatched.length} 个哈希不符` : ''}` +
          `（${detail}${missing.length + mismatched.length > 3 ? ' …' : ''}）`
      );
      continue;
    }
    plan.push({ name, dirRel: `projects/${name}`, files, projectPath: (p && p.projectPath) || null });
  }
  if (problems.length) {
    throw badInput(`包校验未通过，**未写入任何文件**:\n  - ${problems.join('\n  - ')}`);
  }

  const conflicts = plan.filter((p) => isDir(join(vault, p.dirRel))).map((p) => p.name);
  // dry-run 例外：它的整个意义就是「先看见会冲突」，此时拦住它等于不让人预演
  if (conflicts.length && !force && !dryRun) {
    throw badInput(
      `目标 vault 里已存在同名项目: ${conflicts.join(', ')} —— 确认要覆盖就加 --force` +
        `（覆盖前会把这些目录整份备份到数据目录的 backup/ 下）；只想看会做什么用 --dry-run`
    );
  }

  // manifest 之外的多余条目：不落盘，但要报告——可能是打包工具塞的，也可能是有人动了包
  const declared = new Set(plan.flatMap((p) => p.files.map((f) => `projects/${p.name}/${f.rel}`)));
  const ignored = entries.map((e) => e.name).filter((n) => n !== MANIFEST_NAME && !declared.has(n));

  const summary = plan.map((p) => ({
    name: p.name,
    dir: p.dirRel,
    files: p.files.length,
    bytes: p.files.reduce((s, f) => s + f.data.length, 0),
    conflict: isDir(join(vault, p.dirRel)),
    projectPath: targetProjectPath || p.projectPath,
    projectPathExists: (() => {
      const at = targetProjectPath || p.projectPath;
      return at ? isDir(at) : null;
    })(),
  }));

  if (dryRun) {
    return {
      status: 'ok',
      configured: true,
      dryRun: true,
      vault,
      file: fileLabel,
      wouldImport: summary,
      ...(conflicts.length ? { wouldOverwrite: conflicts } : {}),
      ...(ignored.length ? { ignored } : {}),
      // 纯文本：这段既进 CLI 输出也进面板结果块，Markdown 强调符会原样露出来。
      note: '只做了校验与规划，没有写入任何文件；去掉 --dry-run 才真正导入',
    };
  }

  // 覆盖前备份：搬到数据目录（跟 store.json 走，测试指向临时目录即天然隔离），
  // 不放进 vault 里——vault 里的任何目录都会被 Obsidian 当成笔记树的一部分。
  let backupDir = null;
  for (const p of plan.filter((x) => isDir(join(vault, x.dirRel)))) {
    if (!backupDir) {
      backupDir = join(dataDirFromEnv(), 'backup', `import-${Date.now()}`);
      await fsp.mkdir(backupDir, { recursive: true });
    }
    await fsp.cp(join(vault, p.dirRel), join(backupDir, p.name), { recursive: true });
  }

  const written = [];
  for (const p of plan) {
    const dirAbs = join(vault, p.dirRel);
    // 覆盖语义 = 用包内容**替换**旧目录，而不是往上叠：叠会留下上游已删的笔记，
    // 那些文件会让红链「看起来解析成功」，是最难发现的那种陈旧。
    if (isDir(dirAbs)) await fsp.rm(dirAbs, { recursive: true, force: true });
    await fsp.mkdir(dirAbs, { recursive: true });

    for (const f of p.files) {
      const abs = join(dirAbs, ...f.rel.split('/'));
      await fsp.mkdir(dirname(abs), { recursive: true });
      let data = f.data;
      if (targetProjectPath && f.rel === `Base-${p.name}.md`) {
        data = rewriteProjectBinding(data, targetProjectPath);
      }
      await fsp.writeFile(abs, data);
      if (f.mtime instanceof Date && !Number.isNaN(f.mtime.getTime())) {
        // mtime 还原只是让 `projects` 的「最近更新」看起来仍然合理，失败不影响内容
        await fsp.utimes(abs, f.mtime, f.mtime).catch(() => {});
      }
    }
    written.push({
      name: p.name,
      dir: p.dirRel,
      files: p.files.length,
      projectPath: targetProjectPath || p.projectPath,
      projectPathRewritten: !!(targetProjectPath && targetProjectPath !== p.projectPath),
    });
  }

  return {
    status: 'ok',
    configured: true,
    vault,
    file: fileLabel,
    imported: written,
    ...(backupDir ? { backup: backupDir } : {}),
    ...(ignored.length ? { ignored } : {}),
    next:
      `索引不在包里（绑死绝对路径与 embedding 维度），导入后要重建：${APP_NAME} kb index` +
      `；核对红链：${APP_NAME} obsidian scan --project <项目根> --project-name ${written.map((w) => w.name).join(',')}`,
  };
}

// 只改 Base 根文档 frontmatter 里的那一行 `project:`；没有这一行就在 frontmatter
// 结束前补一条（旧版本的包可能没写绑定）。用索引拼接而不是 String.replace(fmBody)：
// 正文里出现相同字符串时 replace 会改错位置。
function rewriteProjectBinding(data, projectAbs) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return data; // 没有 frontmatter：不硬塞结构进去

  const value = String(projectAbs).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const line = `project: "${value}"`;
  const body = fm[1];
  const next = /^\s*project\s*:/m.test(body) ? body.replace(/^\s*project\s*:.*$/m, line) : `${body}\n${line}`;

  const at = fm.index + fm[0].indexOf(body);
  return Buffer.from(`${text.slice(0, at)}${next}${text.slice(at + body.length)}`, 'utf8');
}

// 标题取正文第一个 `# ` 行（先跳过 frontmatter，再跳过代码围栏里的示例标题）；
// 没有 H1 就用文件名 stem——「列文档」这件事不该因为某篇没写标题就失败。
function firstHeading(vault, rel) {
  let text;
  try {
    text = readVaultText(join(vault, rel));
  } catch {
    return splitExt(baseName(rel))[0];
  }
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(text);
  if (fm) text = text.slice(fm[0].length);

  let inFence = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^#\s+(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return splitExt(baseName(rel))[0];
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
export async function check({ snapshot, snapshotBefore, newFile, flagVault, project, projectName } = {}) {
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
  // 项目名必须透传——ask/scan/check 若各自解析一次，三条命令可能算出三个目录名。
  const current = await scan({ flagVault, project, projectName });

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

// ---- 项目名解析：显式 > 已有绑定 > 自动推导 ----
//
// 项目名一次决定三样东西：vault 目录 `projects/<名>/`、根文档 `Base-<名>.md`、
// 以及每篇笔记 bklink 里的 `[[Base-<名>]]`。所以它必须**稳定**——
// 这个名字变一次，该项目全部笔记的 bklink 会在同一秒集体变成红链。
//
// 三个来源，顺序不可换：
//   1. `--project-name`（显式）—— 人来定。目录名是「给人看的阅读目录名」，
//      不该被 npm 包名绑架：后者是包标识（可能带 scope、可能留着产品线早期的
//      版本号，如 sedoc-fe-1.0），跟人怎么找笔记没有关系。
//   2. 已有绑定（`projects/<名>/Base-<名>.md` 的 `project:` == 本项目绝对路径）
//      —— 绑定过就永远沿用。这一级不是锦上添花：少了它，只要有人忘带
//      `--project-name`，就会在旧目录旁边再长一棵新树，而且**不报错**。
//   3. 自动推导（package.json → Cargo.toml → pyproject.toml → 目录名）
//      —— 只服务「这个项目在 vault 里还没有过身份」的首次初始化。
//
// 解析全程只读：这里不创建任何文件，建根文档仍然只有 ask 一条入口。
const PROJECT_NAME_FLAG = '--project-name';

function resolveProjectName(vault, projectAbs, explicit) {
  const raw = pythonTrim(String(explicit ?? ''));
  if (raw) {
    const name = assertExplicitProjectName(raw);
    assertNameNotTaken(vault, name, projectAbs);
    return { name, source: 'flag' };
  }

  const bound = findBoundProjectName(vault, projectAbs);
  if (bound) return { name: bound, source: 'binding' };

  return { name: sanitizeName(projectNameOf(projectAbs)), source: 'derived' };
}

// 显式给的名字必须**原样可用**，不静默 sanitize。
// sanitizeName 的职责是「提问文本 → 合法文件名」（删字符 / 折空格 / 空则兜底
// unresolved-xxxx）；拿它处理人来指定的目录名，等于把拼错的名字悄悄改成另一个
// 目录——正是这套代码最该防的那种静默失效。
function assertExplicitProjectName(raw) {
  if (/[\\/]/.test(raw)) {
    throw badInput(`项目名不能含路径分隔符: ${raw}（它是 projects/ 下的单层目录名）`);
  }
  if (raw === '.' || raw === '..' || /^\.+$/.test(raw)) {
    throw badInput(`项目名不能是 ${raw}`);
  }
  const cleaned = sanitizeName(raw);
  if (cleaned !== raw) {
    throw badInput(`项目名含非法字符: ${raw}（会被清洗成 ${cleaned}）—— 请直接给清洗后的名字，不静默改写`);
  }
  return raw;
}

// 目录已被**另一个**项目根绑定 → 报错，不覆盖、不合并。
// 目录存在但没有根文档（无绑定声明）→ 允许接管：这是「早期手写笔记后来补项目
// 身份」的正常路径，也是 add 之前那些无主的笔记目录唯一的升级方式。
function assertNameNotTaken(vault, name, projectAbs) {
  const baseAbs = join(vault, 'projects', name, `Base-${name}.md`);
  let text;
  try {
    text = readVaultText(baseAbs);
  } catch {
    return; // 没有根文档 = 没有绑定声明
  }
  const bound = projectBindingOf(text);
  if (!bound || samePath(bound, projectAbs)) return;
  throw badInput(
    `目录 projects/${name} 已被另一个项目占用（Base-${name}.md 里绑定的是 ${bound}）——` +
      ` 换一个 ${PROJECT_NAME_FLAG}，或先确认这两个路径是不是同一个项目`
  );
}

// 反查「这个项目根在 vault 里已经有哪个目录」。多命中时报错而不是挑一个：
// 一个项目两棵树本身就是需要人判断的坏状态，脚本替它选一边只会让另一边变成孤儿。
function findBoundProjectName(vault, projectAbs) {
  const root = join(vault, 'projects');
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null; // 还没有 projects/：首次初始化，交给推导
  }

  const hits = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    let text;
    try {
      text = readVaultText(join(root, e.name, `Base-${e.name}.md`));
    } catch {
      continue; // 没有根文档 = 没有绑定声明
    }
    const bound = projectBindingOf(text);
    if (bound && samePath(bound, projectAbs)) hits.push(e.name);
  }

  if (hits.length > 1) {
    throw badInput(
      `同一个项目根被多个目录绑定: ${hits.join(', ')} —— 用 ${PROJECT_NAME_FLAG} 指定用哪一个（不自动挑）`
    );
  }
  return hits[0] || null;
}

// 从根文档 frontmatter 取 `project:` 值。
// genFrontmatterYaml 写的是 JSON 风格的双引号标量（`project: "D:\\repos\\app"`），
// 所以双引号值优先按 JSON 解；手写的裸标量（`project: D:\repos\app`）原样返回。
function projectBindingOf(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(String(text));
  if (!fm) return null;
  for (const raw of fm[1].split('\n')) {
    const m = /^\s*project\s*:\s*(.*?)\s*$/.exec(raw.replace(/\r$/, ''));
    if (!m) continue;
    const v = m[1];
    if (!v) return null;
    if (!v.startsWith('"')) return v;
    try {
      const parsed = JSON.parse(v);
      return typeof parsed === 'string' && parsed ? parsed : null;
    } catch {
      return v.replace(/^"|"$/g, '') || null;
    }
  }
  return null;
}

// 读一个文件的 project 绑定；读失败（权限 / 编码 / 文件刚被删）返回 null。
// 枚举项目时用它：单个根文档读不出来不该让整张表失败。
function bindingOfFile(abs) {
  try {
    return projectBindingOf(readVaultText(abs));
  } catch {
    return null;
  }
}

// Windows 路径大小写不敏感：`D:\Repos\App` 与 `d:\repos\app` 必须认成同一个，
// 否则「已有绑定」会因为大小写差异失效，悄悄退回推导再分裂一次。
function samePath(a, b) {
  const norm = (p) => resolve(String(p)).replace(/\\/g, '/');
  const x = norm(a);
  const y = norm(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}

// ---- 项目范围（多项目并发时的隔离边界）----
//
// 「自己的项目」= vault 里的 projects/<项目名>/ 目录（项目名走上面的三级解析）。
// 扫描与校验都只在这个目录里收集链接——两个项目同时跑，各自动自己那份，互不打扰。
//
// 注意**解析仍对照全库**：链到共享笔记 / 别的项目的笔记不算红链，
// 否则 agent 会跑去重复建一份——那才是真正破坏隔离的地方。
function projectScopeOf(vault, project, explicitName) {
  const projectAbs = resolve(String(project));
  if (!isDir(projectAbs)) {
    throw notFound(`项目目录不存在: ${projectAbs}（项目域扫描必须绑定一个真实存在的代码库）`);
  }
  const { name, source } = resolveProjectName(vault, projectAbs, explicitName);
  const rel = `projects/${name}`;
  return {
    projectAbs,
    projectName: name,
    nameSource: source,
    rel,
    abs: join(vault, rel),
    exists: isDir(join(vault, rel)),
  };
}

// 第三级兜底（项目解读 SOP 原规则）：package.json → Cargo.toml → pyproject.toml → 目录名。
// scope 前缀（@org/pkg）去掉——vault 路径里不该出现 @。
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
export async function ask({ question, project, projectName, source, flagVault } = {}) {
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

  // 名字走三级解析（显式 > 已有绑定 > 推导）：这是「同一批笔记只该有一棵树」的锚点。
  // 返回 nameSource，让调用方看得见这名字是推出来的还是人给的。
  const { name, source: nameSource } = resolveProjectName(vault, projectAbs, projectName);
  const dirRel = `projects/${name}`;
  const baseRel = `${dirRel}/Base-${name}.md`;
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
    text = `${genFrontmatterYaml({ bklink: [], extra: { project: projectAbs } })}\n\n# ${name}\n`;
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
  const noteBkl = [`Base-${name}`, link].filter(Boolean);
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
      vaultSource,
      project: projectAbs,
      projectName: name,
      projectNameSource: nameSource,
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
      vaultSource,
      project: projectAbs,
      projectName: name,
      projectNameSource: nameSource,
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
    vaultSource,
    project: projectAbs,
    projectName: name,
    projectNameSource: nameSource,
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

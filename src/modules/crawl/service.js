// crawl 域（资料采集）：把**vault 之外的文档站**抓下来、清洗成 markdown 入知识库。
//
// 设计要点（整个域只有一句话）：**抓取产物落成普通 .md 目录，再当作一个知识库登记。**
// 于是索引（zg）、检索、增量、多库合并、面板展示全部复用 kb 域，一行都不用特化；
// 采集域只负责「URL → 干净 markdown」这一件事。这是它能保持「一丢丢」的原因。
//
// ---- 两个引擎 ----
//
// 抓取有两条实现路径，用 `engine` 选择，**默认 skill-seekers**：
//
//   skill-seekers  外部引擎（Python 3.10+ / uv）。抓取、分类、组织成
//                  `SKILL.md + references/` 由它负责，我们只把产出摘进 vault。
//                  `--enhance-level` 可让它调外部 agent 写增强内容。
//                  代价：要求用户机器上有 Python + uv（或自行 pip 安装）。
//
//   node           内置引擎，纯 Node（fetch + cheerio + turndown），零额外依赖。
//                  代价：只认静态 HTML，不分类、不增强。
//
// 为什么默认是 skill-seekers 而不是「零依赖的 node」：这是 2026-10-04 的显式选择
// （见 docs/plan/nx-kn-plan.md 的决策修正）。**代价是被明知的**——没装 Python 的机器
// 上 `crawl run` 会直接报错。所以错误信息必须把两条出路都写清楚：
// `--engine node` 用内置引擎，或装上 uv 让 uvx 免安装拉起。
// 依赖的调用细节在 core/skill-seekers.js（含 env 逃生舱 NX_KN_SKILL_SEEKERS_CMD）。
//
// 命令面（与 kb 域动词对齐）：
//   crawl add <url> [--name n] [--engine e] [--enhance-level 0-3] [--match glob] [--max n]
//   crawl run [--name n] [--engine e] [--rebuild]
//   crawl list
//   crawl remove <name> [--purge]
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { badInput, conflict, external, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import {
  APP_NAME,
  CRAWL_ENGINES,
  CRAWL_MANIFEST,
  CRAWL_UA,
  DEFAULT_CRAWL_ENGINE,
  assertSafeName,
  crawlDelayMs,
  sourceDirOf,
} from '../../core/paths.js';
import {
  SKILL_SEEKERS_TIMEOUT_MS,
  describeCandidate,
  listMarkdownFiles,
  runSkillSeekers,
} from '../../core/skill-seekers.js';
import {
  fetchText,
  globMatch,
  htmlToMarkdown,
  isHtmlContentType,
  normalizeUrl,
  originOf,
  pageFileFor,
  parseSitemap,
  pathOf,
  sameOrigin,
  sitemapCandidates,
} from '../../core/web.js';

const DEFAULT_MAX = 200;

// 抓取引擎常量定义在 core/paths.js（store 的归一化也要用它补默认值，而 core 不能依赖
// modules）。这里只是转发，让 index.js 从一个地方（service）就能拿到枚举与默认值。
export const ENGINES = CRAWL_ENGINES;
export const DEFAULT_ENGINE = DEFAULT_CRAWL_ENGINE;
const ENGINE_SS = 'skill-seekers';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function engineOf(rec, override) {
  const e = override || (rec && rec.engine) || DEFAULT_ENGINE;
  return ENGINES.includes(e) ? e : DEFAULT_ENGINE;
}

// ---- 源名推导 ----

// 不给 --name 时从 URL 推一个安全的名字：`https://vitepress.dev/guide/` → `vitepress-dev-guide`。
// 结果必须是安全目录名（不含分隔符、不以点开头）—— 它直接落成 ~/.nx-kn/sources/<name>/。
function deriveName(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return 'site';
  }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const seg = u.pathname.split('/').filter(Boolean)[0] || '';
  const usableSeg = seg && !/\.(html?|php|aspx?)$/i.test(seg) ? '-' + seg : '';
  const base = (host + usableSeg)
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return base || 'site';
}

// 本地目录源的名字：取路径最后一段（两种分隔符都认，理由同 store.js 的 displayNameOf），
// 再压成安全目录名。中文保留（`Base-面试` 是完全合法的源名），空白与符号折成连字符。
function deriveLocalName(path) {
  const parts = String(path).split(/[\\/]+/).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : String(path);
  const base = last
    .replace(/[^A-Za-z0-9\u4e00-\u9fa5._-]+/g, '-')
    .replace(/^[-.]+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60);
  return base || 'local-dir';
}

// 判断一个输入是不是「存在的本地目录」。是则返回原样路径（调用方负责 resolve），
// 不是（不存在 / 是文件）返回 null。存在即是本地源——文档站地址不可能撞上磁盘目录。
async function toLocalDir(p) {
  try {
    const st = await fsp.stat(p);
    return st.isDirectory() ? p : null;
  } catch {
    return null;
  }
}

// YAML 标量：标题里可能带冒号、井号、引号、换行。直接塞进 frontmatter 会破坏解析，
// 所以可疑的一律加引号并转义。多行标题压成单行（frontmatter 不支持真正的多行标量）。
function yamlScalar(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '""';
  if (/^[A-Za-z0-9\u4e00-\u9fa5][^:#"'\n]*$/.test(s)) return s; // 简单安全值，裸写
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// 取第一个一级标题当标题（与 node 引擎从 <h1> 取标题等价）。
function firstHeading(md) {
  const m = String(md || '').match(/^\s*#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : null;
}

// ---- 采集清单（源目录内的 .nx-kn-crawl.json）----

async function readManifest(dir) {
  try {
    return JSON.parse(await fsp.readFile(join(dir, CRAWL_MANIFEST), 'utf8'));
  } catch {
    return null;
  }
}

async function writeManifest(dir, data) {
  await fsp.mkdir(dir, { recursive: true });
  const p = join(dir, CRAWL_MANIFEST);
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p); // 原子写：抓一半中断不会留下半个清单
}

// ---- 陈旧产物清理：上次记录过、本次不再产出的 .md ----
//
// 两个来源的「陈旧文件」都由它兜住：
//   1. **远端已删的页面** —— 它从 manifest.pages 里消失了，文件却还在盘上，
//      于是继续被索引、继续被检索到（用户翻到的是一篇早就不存在的文档）。
//   2. **换引擎的残留** —— node 与 skill-seekers 的落盘命名空间不同，
//      换引擎后旧引擎的文件不会被任何一次抓取覆盖，只会和新的一套并存
//      （同一内容两份命中，白占 --limit 名额）。
// 少了它，sources/ 目录会随使用时间单向增长，且没有任何机制能让它缩小。
//
// ⚠️ 第三個参数必须是「**本次真正产出**的文件名集合」（fresh），而不是本次写出的
// manifest.pages —— 后者是从上一次的清单**继承**来的（增量语义需要它做 unchanged 判定），
// 远端已删的页面因此会一直留在里面；拿它当保留集合，清理就永远一个都删不掉
// （第一版实现正是错在这里，P11b 抓到了）。
//
// 清理集合刻意**只取上一次 manifest 记录过的文件**：手工放进 sources/<名>/ 的
// 东西不在名单里，永远不会被误删。
//
// 只在本次确有产出时调用（produced > 0）。站点临时抽风导致「一页都没抓到」时，
// 按「上一次的成果不作废」这条既有纪律，一个文件都不动。
async function pruneStalePages(dir, prevManifest, fresh) {
  const candidates = new Set();
  for (const rec of Object.values((prevManifest && prevManifest.pages) || {})) {
    if (rec && rec.file) candidates.add(String(rec.file));
  }

  const removed = [];
  for (const rel of candidates) {
    if (fresh.has(rel)) continue;
    // manifest 是磁盘上的普通文件，不能当可信输入：只删「确实落在源目录内」的 .md
    if (!/\.md$/i.test(rel)) continue;
    const abs = resolve(dir, rel);
    const back = relative(dir, abs);
    if (!back || back.startsWith('..') || isAbsolute(back)) continue;
    try {
      await fsp.rm(abs, { force: true });
    } catch {
      continue; // 删不掉就留着：多一份内容远好过误删
    }
    removed.push(rel);
    await pruneEmptyDirs(dirname(abs), dir);
  }
  return removed;
}

// 删完文件顺手收掉空目录，否则 sources/<名>/ 会留下一堆空壳。
// 从最深的目录往上走，遇到非空 / 越界 / 到源目录根就停。
async function pruneEmptyDirs(start, stopAt) {
  const root = resolve(stopAt);
  let cur = resolve(start);
  while (cur !== root) {
    const rel = relative(root, cur);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    try {
      if ((await fsp.readdir(cur)).length) return;
      await fsp.rmdir(cur);
    } catch {
      return;
    }
    const up = dirname(cur);
    if (up === cur) return;
    cur = up;
  }
}

// ---- store 里的源列表 ----

export async function storedSources() {
  const store = await loadStore();
  return (store.crawl && store.crawl.sources) || [];
}

// ---- add：登记一个采集源 ----

export async function add({ url, name, include, max, engine, enhanceLevel, agent } = {}) {
  if (!url) {
    throw badInput(
      `用法: ${APP_NAME} crawl add <url或本地目录> [--name <名>] [--engine <${ENGINES.join('|')}>] ` +
        `[--enhance-level <0-3>] [--agent <名>] [--match <glob>] [--max <n>]`
    );
  }

  // 源分两路：存在的本地目录 = local（整理，引擎只认 skill-seekers）；
  // 否则按文档站 URL 处理。判定只看「磁盘上有没有这个目录」——二者不可能撞车。
  const rawUrl = String(url);
  const localDir = await toLocalDir(rawUrl);
  const abs = localDir ? resolve(localDir) : normalizeUrl(rawUrl);
  if (!abs) {
    throw badInput(
      `不是合法的 http(s) 地址，也不是存在的本地目录: ${url}`
    );
  }

  const nm = name ? String(name) : localDir ? deriveLocalName(abs) : deriveName(abs);
  assertSafeName(nm, '采集源名');

  // 引擎：不合法直接报错，不静默回落 —— 「我明明选了 A，怎么按 B 跑了」是最难查的一类问题。
  const eng = engine === undefined || engine === null || engine === '' ? DEFAULT_ENGINE : String(engine);
  if (!ENGINES.includes(eng)) {
    throw badInput(`--engine 只能是 ${ENGINES.join(' | ')}，收到: ${engine}`);
  }
  // 本地目录源只认 skill-seekers：内置引擎是「抓 HTTP 页面」的，对本地目录无能为力；
  // 而本地源的语义恰恰是「整理」，分类与组织全在外部引擎里。
  if (localDir && eng !== ENGINE_SS) {
    throw badInput(
      `本地目录源只支持 skill-seekers 引擎（收到 --engine ${eng}）——` +
        `内置 Node 引擎只抓 http(s) 页面，整理不了本地文件`
    );
  }

  // 增强级别 0~3（0 = 纯抓取，不调任何 LLM）。仅对 skill-seekers 有意义，但一律校验、一律存储，
  // 这样「先按 node 抓、以后换 ss 重抓」时参数不会莫名丢失。
  const lvl = enhanceLevel === undefined || enhanceLevel === null || enhanceLevel === '' ? 0 : Number(enhanceLevel);
  if (!Number.isInteger(lvl) || lvl < 0 || lvl > 3) {
    throw badInput(`--enhance-level 只能是 0~3 的整数，收到: ${enhanceLevel}`);
  }
  const ag = agent ? String(agent) : null;

  const inc = include ? String(include) : '**';
  const mx = max === undefined || max === null || max === '' ? DEFAULT_MAX : Number(max);
  if (!Number.isFinite(mx) || mx <= 0) throw badInput(`--max 必须是正整数，收到: ${max}`);

  const before = await storedSources();
  const dupName = before.find((s) => s.name === nm);
  if (dupName) {
    throw conflict(`已存在名为 ${nm} 的采集源（${dupName.url}）—— 换 --name，或先 ${APP_NAME} crawl remove ${nm}`);
  }
  const dupUrl = before.find((s) => s.url === abs);
  if (dupUrl) {
    throw conflict(`这个地址已有采集源：${dupUrl.name}（${dupUrl.url}）—— 要重抓跑 ${APP_NAME} crawl run --name ${dupUrl.name}`);
  }

  const dir = sourceDirOf(nm);
  await fsp.mkdir(dir, { recursive: true });
  await writeManifest(dir, {
    name: nm,
    url: abs,
    kind: localDir ? 'local' : 'web',
    engine: eng,
    enhanceLevel: lvl,
    agent: ag,
    include: inc,
    max: mx,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    via: null,
    pages: {},
  });

  await mutateStore((store) => {
    store.crawl.sources.push({
      name: nm,
      url: abs,
      kind: localDir ? 'local' : 'web',
      engine: eng,
      enhanceLevel: lvl,
      agent: ag,
      include: inc,
      max: mx,
      addedAt: new Date().toISOString(),
      lastRunAt: null,
      pages: null,
      failed: null,
      via: null,
    });
    return store.crawl.sources;
  });

  return {
    status: 'ok',
    name: nm,
    url: abs,
    kind: localDir ? 'local' : 'web',
    engine: eng,
    enhanceLevel: lvl,
    agent: ag,
    dir,
    include: inc,
    max: mx,
    count: (await storedSources()).length,
    hint: localDir
      ? `跑 ${APP_NAME} crawl run --name ${nm} 开始整理（skill-seekers）`
      : `跑 ${APP_NAME} crawl run --name ${nm} 开始抓取`,
  };
}

// 幂等登记：pipeline 一步直达的入口用。同一个 URL/目录已有源就直接复用，
// 没有才真的 add——于是「重复提供同目录」语义退化为增量重跑，而不是报冲突。
// 解析规则与 add 完全一致（存在的本地目录 = local，否则按 http(s) URL）。
export async function ensureSource({ url, name, include, max, engine, enhanceLevel, agent } = {}) {
  if (!url) throw badInput(`用法: ${APP_NAME} pipeline <目录或URL>（或先 crawl add 登记）`);
  const raw = String(url);
  const localDir = await toLocalDir(raw);
  const abs = localDir ? resolve(localDir) : normalizeUrl(raw);
  if (!abs) {
    throw badInput(`不是合法的 http(s) 地址，也不是存在的本地目录: ${url}`);
  }
  const hit = (await storedSources()).find((s) => s.url === abs);
  if (hit) {
    return { name: hit.name, url: hit.url, kind: hit.kind === 'local' ? 'local' : 'web', engine: hit.engine, added: false };
  }
  const r = await add({ url: raw, name, include, max, engine, enhanceLevel, agent });
  return { name: r.name, url: r.url, kind: r.kind, engine: r.engine, added: true };
}

// ---- list：源列表 + 上次抓取统计 ----

export async function list() {
  const store = await loadStore();
  const sources = (store.crawl && store.crawl.sources) || [];
  const vaults = (store.kb && store.kb.vaults) || [];

  const rows = [];
  for (const s of sources) {
    const dir = sourceDirOf(s.name);
    const exists = await isDir(dir);
    const manifest = exists ? await readManifest(dir) : null;
    const pageCount = manifest && manifest.pages ? Object.keys(manifest.pages).length : null;
    rows.push({
      name: s.name,
      url: s.url,
      kind: s.kind === 'local' ? 'local' : 'web',
      engine: engineOf(s, null),
      enhanceLevel: Number.isInteger(s.enhanceLevel) ? s.enhanceLevel : 0,
      agent: s.agent || null,
      dir,
      include: s.include,
      max: s.max,
      exists,
      pages: pageCount != null ? pageCount : s.pages ?? 0,
      failed: s.failed ?? 0,
      via: s.via || null,
      lastRunAt: s.lastRunAt || (manifest && manifest.updatedAt) || null,
      registered: vaults.some((v) => resolve(String(v.path)) === resolve(dir)),
    });
  }
  return { status: 'ok', count: rows.length, sources: rows };
}

// ---- remove：解登记（默认保留抓下来的文件与索引）----

export async function remove({ name, purge = false } = {}) {
  if (!name) throw badInput(`用法: ${APP_NAME} crawl remove <name> [--purge]`);
  const sources = await storedSources();
  const hit = sources.find((s) => s.name === String(name));
  if (!hit) throw notFound(`没有名为 ${name} 的采集源`);

  const dir = sourceDirOf(hit.name);

  await mutateStore((store) => {
    store.crawl.sources = store.crawl.sources.filter((s) => s.name !== hit.name);
    // --purge 才连带撤掉自动登记的知识库；默认保留——抓下来的目录仍是有用的知识库。
    if (purge) {
      store.kb.vaults = store.kb.vaults.filter((v) => resolve(String(v.path)) !== resolve(dir));
    }
    return store.crawl.sources;
  });

  let purged = null;
  if (purge) {
    await fsp.rm(dir, { recursive: true, force: true });
    purged = dir;
  }

  return {
    status: 'ok',
    removed: hit.name,
    dir,
    purged,
    count: (await storedSources()).length,
    note: purge
      ? `已删除 ${dir}（含抓取文件与 zg 索引），并从知识库列表移除`
      : `采集文件与索引仍留在 ${dir}（它同时还是一个知识库；要连文件一起删，加 --purge）`,
  };
}

// ================= 引擎 A：内置 Node =================
//
// 发现：sitemap 优先，回退同域 BFS。抓取与清洗都不依赖外部进程。

// 递归收集 sitemap 里的页面 URL。sitemap index 会往下钻（限深 3 层、限 5000 条，
// 免得遇到「无限嵌套的 sitemap 站」时把内存吃光）。
async function collectSitemap(smUrl, xml, origin, out, seenSitemaps, depth) {
  if (depth > 3 || out.length >= 5000) return;
  const parsed = parseSitemap(xml);
  if (parsed.isIndex) {
    for (const loc of parsed.locs) {
      if (seenSitemaps.has(loc) || out.length >= 5000) continue;
      seenSitemaps.add(loc);
      const r = await fetchText(loc, { ua: CRAWL_UA, timeoutMs: 15_000 });
      if (!r.ok) continue;
      await collectSitemap(loc, r.text, origin, out, seenSitemaps, depth + 1);
    }
    return;
  }
  for (const loc of parsed.locs) {
    const n = normalizeUrl(loc, smUrl);
    if (n && sameOrigin(n, origin)) out.push(n);
  }
}

// 单个源的抓取。**串行 + 节流**（不并发）：既有礼貌，也让日志顺序可读。
async function runOneViaNode(s, { rebuild }) {
  const dir = sourceDirOf(s.name);
  await fsp.mkdir(dir, { recursive: true });

  const manifest = (await readManifest(dir)) || {};
  // --rebuild = 无视已存哈希，全部重写。默认增量：内容没变的页面**不落盘**，
  // 从而让后续 zg 增量索引如实报「unchanged」（不动 mtime，就不必重嵌入）。
  //
  // 只在「上次也是 node 引擎」时才相信旧的 url→file 映射：换过引擎，命名空间不同
  // （ss 按它自己的分类目录落盘），沿用旧映射只会得到一堆假的「未变」。
  const sameEngine = manifest.engine !== ENGINE_SS;
  const prev = !rebuild && sameEngine && manifest.pages ? manifest.pages : {};
  // next 只装**本次产出**的页面，不再从上一次的清单继承——
  // 继承正是「远端已删的页面永远留在 manifest 里」的根源（见 pruneStalePages 的注释）。
  // 上一次的映射已由 prev 持有，unchanged 判定不受影响。
  const next = {};
  // 本次真正落盘/确认过的文件名，给陈旧产物清理当「保留集合」
  const fresh = new Set();

  const stats = { added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, removed: 0 };
  const failures = [];
  const delay = crawlDelayMs();
  let firstReq = true;
  const wait = async () => {
    if (firstReq) {
      firstReq = false;
      return;
    }
    if (delay > 0) await sleep(delay);
  };

  const onFail = (u, error) => {
    stats.failed++;
    failures.push({ url: u, error: String(error || '未知错误') });
  };

  // 一页 → 一个 md。返回该页的链接（BFS 靠它继续发现）。
  const onPage = async (u, html) => {
    const { title, markdown, links } = htmlToMarkdown(html, { url: u });
    if (!markdown.trim()) {
      stats.skipped++;
      return { links };
    }

    let file = pageFileFor(u, s.url) || 'index.md';
    const clash = Object.entries(next).some(([k, v]) => k !== u && v && v.file === file);
    if (clash) file = file.replace(/\.md$/i, '') + '-' + sha256(u).slice(0, 8) + '.md';

    // 哈希只算**正文**：frontmatter 里的 fetchedAt 每次都变，算进去会让「没改的页面」
    // 永远判定为 changed，增量就失效了。
    const hash = sha256(markdown);
    const prevRec = prev[u];
    const absFile = join(dir, file);
    const existed = existsSync(absFile);

    if (prevRec && prevRec.hash === hash && prevRec.file === file && existed) {
      stats.unchanged++;
    } else {
      const body =
        '---\n' +
        `source: ${yamlScalar(u)}\n` +
        `title: ${yamlScalar(title || '')}\n` +
        `fetchedAt: ${new Date().toISOString()}\n` +
        '---\n\n' +
        markdown +
        '\n';
      await fsp.mkdir(dirname(absFile), { recursive: true });
      await fsp.writeFile(absFile, body, 'utf8');
      if (existed || prevRec) stats.updated++;
      else stats.added++;
    }

    next[u] = { file, hash, title: title || null };
    fresh.add(file);
    return { links };
  };

  // ① 先试 sitemap
  let mode = 'bfs';
  let urlList = null;
  for (const sm of sitemapCandidates(s.url)) {
    const r = await fetchText(sm, { ua: CRAWL_UA, timeoutMs: 15_000 });
    if (!r.ok) continue;
    if (!/<\/?(urlset|sitemapindex)/i.test(r.text)) continue;
    const raw = [];
    await collectSitemap(sm, r.text, originOf(s.url), raw, new Set(), 0);
    const filtered = [...new Set(raw)].filter(
      (u) => sameOrigin(u, s.url) && globMatch(s.include, pathOf(u))
    );
    if (filtered.length) {
      urlList = filtered.slice(0, s.max);
      mode = 'sitemap';
      break;
    }
  }

  // ② 有列表就逐条抓；没有就同域 BFS
  if (urlList) {
    for (const u of urlList) {
      await wait();
      const r = await fetchText(u, { ua: CRAWL_UA });
      if (!r.ok) {
        onFail(u, r.error);
        continue;
      }
      if (!isHtmlContentType(r.contentType)) {
        onFail(u, `非 HTML（${r.contentType || '未知类型'}）`);
        continue;
      }
      await onPage(u, r.text);
    }
  } else {
    const seen = new Set();
    const queue = [s.url];
    urlList = [];
    while (queue.length && urlList.length < s.max) {
      const u = queue.shift();
      if (seen.has(u)) continue;
      seen.add(u);
      await wait();
      const r = await fetchText(u, { ua: CRAWL_UA });
      if (!r.ok) {
        onFail(u, r.error);
        continue;
      }
      if (!isHtmlContentType(r.contentType)) {
        onFail(u, `非 HTML（${r.contentType || '未知类型'}）`);
        continue;
      }
      if (!globMatch(s.include, pathOf(u))) continue;
      urlList.push(u);
      const { links } = await onPage(u, r.text);
      for (const l of links) {
        if (sameOrigin(l, s.url) && !seen.has(l) && globMatch(s.include, pathOf(l))) queue.push(l);
      }
    }
  }

  const produced = stats.added + stats.updated + stats.unchanged;

  // 一页都没抓到：**绝不建出空内容的源**（与 B05 同一条纪律）。已抓过的目录另说——
  // 站点临时抽风不该把上次的成果判死。
  if (produced === 0) {
    const hadContent = existsSync(join(dir, 'index.md')) || Object.keys(prev).length > 0;
    if (!hadContent) {
      const detail = failures.slice(0, 5).map((f) => `${f.url} —— ${f.error}`).join('\n  ');
      throw external(
        `没有抓到任何页面（源：${s.url}）${stats.failed ? `\n  失败 ${stats.failed} 次：\n  ` + detail : ''}\n` +
          `  检查地址是否可访问、是否为静态 HTML；需要 JS 渲染的站点内置引擎不支持——` +
          `可改用 skill-seekers：${APP_NAME} crawl run --name ${s.name} --engine skill-seekers`
      );
    }
  }

  // 清理陈旧产物（远端已删的页面 / 换引擎留下的另一套命名空间）。
  // 只在本次确有产出时做——理由见 pruneStalePages 的注释。
  const removed = produced > 0 ? await pruneStalePages(dir, manifest, fresh) : [];
  stats.removed = removed.length;

  await writeManifest(dir, {
    name: s.name,
    url: s.url,
    engine: 'node',
    enhanceLevel: null,
    agent: null,
    include: s.include,
    max: s.max,
    createdAt: manifest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    via: mode,
    pages: next,
  });

  return { mode, stats, failures, pages: Object.keys(next).length, produced, removed };
}

// ================= 引擎 B：Skill Seekers =================
//
// 与内置引擎的区别：**发现、抓取、清洗、分类全在外部进程里完成**，我们只做两件事——
// 把它的产出摘进 vault，以及维持增量语义。

// Skill Seekers 把产物落在 `<cwd>/output/<名>/`（名字可由 `--name` 指定）。
// 但它的目录命名规则是它自己的实现细节、会随版本变，所以这里不硬编码路径，
// 而是「先按 --name 找 → 再找 output 下唯一的目录 → 再找最近修改的那个 → 最后兜底扫 SKILL.md」。
async function pickSkillSeekersOutput(scratch, name) {
  const outRoot = join(scratch, 'output');
  const named = join(outRoot, String(name));
  if (await isDir(named)) return named;

  let dirs = [];
  try {
    const entries = await fsp.readdir(outRoot, { withFileTypes: true });
    dirs = entries.filter((e) => e.isDirectory()).map((e) => join(outRoot, e.name));
  } catch {
    dirs = [];
  }
  if (dirs.length === 1) return dirs[0];
  if (dirs.length > 1) {
    const stamped = [];
    for (const d of dirs) {
      try {
        stamped.push({ d, t: (await fsp.stat(d)).mtimeMs });
      } catch {
        /* 竞态：抓取期间被挪走，跳过 */
      }
    }
    stamped.sort((a, b) => b.t - a.t);
    if (stamped.length) return stamped[0].d;
  }

  // 兜底：scratch 下任意含 SKILL.md 的目录
  const hit = (await listMarkdownFiles(scratch)).find((p) => basename(p) === 'SKILL.md');
  return hit ? dirname(hit) : null;
}

// 给产出补一层 frontmatter（来源、引擎、抓取时间），与内置引擎的产物保持同构。
// 已经自带 frontmatter 的（Skill Seekers 的 SKILL.md 通常自带）原样保留，不叠加。
function withFrontmatter(body, sourceUrl) {
  const text = String(body ?? '');
  if (/^---\s*\r?\n/.test(text)) return text;
  return (
    '---\n' +
    `source: ${yamlScalar(sourceUrl)}\n` +
    'engine: skill-seekers\n' +
    `fetchedAt: ${new Date().toISOString()}\n` +
    '---\n\n' +
    text.replace(/^\s+/, '') +
    '\n'
  );
}

async function runOneViaSkillSeekers(s, { rebuild }) {
  const dir = sourceDirOf(s.name);
  await fsp.mkdir(dir, { recursive: true });

  const manifest = (await readManifest(dir)) || {};
  const sameEngine = manifest.engine === ENGINE_SS;
  const prev = !rebuild && sameEngine && manifest.pages ? manifest.pages : {};
  // 与内置引擎同一条规矩：next 只装本次产出，不从上一次继承（见 pruneStalePages）。
  const next = {};
  const fresh = new Set();

  const stats = { added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0, removed: 0 };
  const failures = [];
  const level = Number.isInteger(s.enhanceLevel) ? s.enhanceLevel : 0;
  const isLocal = s.kind === 'local';

  // 让 skill-seekers 在**库外**的临时目录里产出：它的中间产物（SQLite 索引、
  // search.py、各种缓存）不该混进知识库。抓完只把 .md 摘进去。
  const scratch = await fsp.mkdtemp(join(tmpdir(), `nx-kn-ss-${s.name}-`));
  let outDir = null;
  try {
    const args = ['create', s.url, '--name', s.name, '--enhance-level', String(level)];
    // 本地目录源：限定只收 markdown——vault 里还有图片、.obsidian 配置、.zvec-grep
    // 索引等，整理的对象只是笔记本身。
    if (isLocal) args.push('--file-patterns', '*.md');
    if (s.agent) args.push('--agent', String(s.agent));

    const r = await runSkillSeekers(args, { cwd: scratch, timeoutMs: SKILL_SEEKERS_TIMEOUT_MS });
    if (!r.ok) {
      const detail = (r.stderr || r.stdout || r.error || '').trim().split('\n').slice(0, 8).join('\n  ');
      throw external(
        `skill-seekers ${isLocal ? '整理' : '抓取'}失败（源：${s.url}）${detail ? `\n  ${detail}` : ''}\n` +
          (isLocal
            ? `  本地目录源只支持 skill-seekers：检查 Python 3.10+/uv 环境，` +
              `或用环境变量 NX_KN_SKILL_SEEKERS_CMD 指定调用命令`
            : `  换内置引擎重试：${APP_NAME} crawl run --name ${s.name} --engine node`)
      );
    }

    outDir = await pickSkillSeekersOutput(scratch, s.name);
    if (!outDir) {
      throw external(
        `skill-seekers 跑完了，但没有找到产出目录（预期 ${join(scratch, 'output')} 下有内容）——\n` +
          `  可能是它的输出布局变了（当前通过 ${describeCandidate({ bin: r.bin, args: [] })} 调用）。` +
          (isLocal
            ? `\n  本地目录源没有备选引擎，请检查 skill-seekers 版本。`
            : `\n  换内置引擎试试：${APP_NAME} crawl run --name ${s.name} --engine node`)
      );
    }

    const files = await listMarkdownFiles(outDir);
    for (const absFile of files) {
      const rel = relative(outDir, absFile).split(sep).join('/');
      // --match 作用在与内置引擎同名空间上：把 rel 补成 `/guide/x.md` 形态再匹配，
      // 于是 `--match '/guide/**'` 在两个引擎下意思一致。
      if (!globMatch(s.include, '/' + rel)) {
        stats.skipped++;
        continue;
      }

      let raw;
      try {
        raw = await fsp.readFile(absFile, 'utf8');
      } catch (err) {
        stats.failed++;
        failures.push({ url: rel, error: String((err && err.message) || err) });
        continue;
      }

      const hash = sha256(raw);
      const target = join(dir, rel);
      const existed = existsSync(target);
      const rec = prev[rel];

      if (rec && rec.hash === hash && existed) {
        stats.unchanged++;
      } else {
        await fsp.mkdir(dirname(target), { recursive: true });
        await fsp.writeFile(target, withFrontmatter(raw, s.url), 'utf8');
        if (existed || rec) stats.updated++;
        else stats.added++;
      }
      next[rel] = { file: rel, hash, title: firstHeading(raw) };
      fresh.add(rel);
    }
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true });
  }

  const produced = stats.added + stats.updated + stats.unchanged;

  // 与内置引擎同一条纪律：一页都没产出且此前也没有 → 绝不建出空内容的源。
  if (produced === 0) {
    const hadContent = Object.keys(prev).length > 0 || existsSync(join(dir, 'SKILL.md'));
    if (!hadContent) {
      throw external(
        `skill-seekers 没有产出任何 markdown（源：${s.url}）\n` +
          (isLocal
            ? `  检查目录里是否有 .md 文件，以及 skill-seekers 版本是否支持本地目录`
            : `  检查地址是否可访问；或用内置引擎对比：${APP_NAME} crawl run --name ${s.name} --engine node`)
      );
    }
  }

  // skill-seekers 不受 --max 约束（它自己决定抓多少页）。超了如实报出来，
  // **不截断**——把已经抓好的内容悄悄丢掉，比多抓几页糟糕得多。
  const max = Number(s.max) || DEFAULT_MAX;
  const note =
    produced > max
      ? `skill-seekers 不受 --max 控制：实际产出 ${produced} 页（登记上限 ${max}，未截断）`
      : null;

  // 清理陈旧产物：与内置引擎同一套判据（远端已删的页面 / 换引擎的残留）。
  const removed = produced > 0 ? await pruneStalePages(dir, manifest, fresh) : [];
  stats.removed = removed.length;

  await writeManifest(dir, {
    name: s.name,
    url: s.url,
    kind: s.kind === 'local' ? 'local' : 'web',
    engine: ENGINE_SS,
    enhanceLevel: level,
    agent: s.agent || null,
    include: s.include,
    max: s.max,
    createdAt: manifest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    via: ENGINE_SS,
    pages: next,
  });

  return { mode: ENGINE_SS, stats, failures, pages: Object.keys(next).length, produced, note, removed };
}

// ================= run：按引擎分派 =================

async function runOne(s, { rebuild, engine }) {
  // 本地目录源：引擎只有 skill-seekers 一条路。add 时已拦过 --engine node，
  // 这里拦 run 时的覆盖（老脚本、面板旧参数都可能带过来），双保险。
  if (s.kind === 'local' && engine !== undefined && engine !== null && engine !== '' && String(engine) !== ENGINE_SS) {
    throw badInput(`本地目录源只支持 skill-seekers 引擎（收到 --engine ${engine}）`);
  }
  const eng = engineOf(s, engine);
  const dir = sourceDirOf(s.name);
  const r =
    eng === ENGINE_SS ? await runOneViaSkillSeekers(s, { rebuild }) : await runOneViaNode(s, { rebuild });

  const now = new Date().toISOString();
  let overlapsWith = null; // 产物与它的源库内容重叠时，记下源库名
  await mutateStore((store) => {
    const rec = store.crawl.sources.find((x) => x.name === s.name);
    if (rec) {
      rec.lastRunAt = now;
      rec.pages = r.pages;
      rec.failed = r.stats.failed;
      rec.via = r.mode;
      rec.engine = eng;
      rec.include = s.include;
      rec.max = s.max;
    }

    const productPath = resolve(dir);
    const existing = store.kb.vaults.find((v) => resolve(String(v.path)) === productPath);

    // 抓下来的目录**自动登记为知识库**（与手动 kb add 的结果完全同构）。
    // 有内容才登记：空目录进列表只会让人困惑。
    if (r.produced > 0) {
      if (!existing) {
        store.kb.vaults.push({
          path: dir,
          name: s.name,
          model: null,
          addedAt: now,
          // 记下「这条是抓取自动登记的」，与用户手动的 'user' 区分开：
          // 本地目录源的产物往往与源目录内容重叠，只有非 'user' 的才可能被自动排除。
          origin: 'crawl',
        });
      } else if (existing.origin !== 'user') {
        // 老数据（当时还没 origin 字段）补记来源。**绝不**改动 origin === 'user'
        // 的记录——那是用户明确要的，把它降级成产物属于篡改用户意图。
        existing.origin = 'crawl';
      }
    }

    // 产物与它的**源目录**是不是同一批内容？（典型：本地目录源 = Obsidian vault，
    // 而那个 vault 本身也是一个登记库）判据与 kb 域解析时用的是同一条：
    // 源的 url 是不是一个登记库。这里只负责**识别并说出来**，
    // 真正的排除发生在解析库列表那一刻（core/store.js 的 standbyVaults）——
    // 采集域无权替检索域做决定，但有权把事实记准。
    const srcPath = s.url ? resolve(String(s.url)) : null;
    if (srcPath && srcPath !== productPath) {
      const srcVault = store.kb.vaults.find((v) => resolve(String(v.path)) === srcPath);
      const product = store.kb.vaults.find((v) => resolve(String(v.path)) === productPath);
      // 用户显式 kb add 过的产物不算「被抑制」——它照样参与检索。
      if (srcVault && product && product.origin !== 'user') {
        overlapsWith = srcVault.name || srcPath;
      }
    }
    return store.crawl.sources;
  });

  // 本次清理掉的陈旧文件（远端已删 / 换引擎残留）——如实报出来，
  // 否则用户只会看到 sources/ 目录悄悄变小而不知道原因。
  const removed = r.removed || [];
  const pruneNote = removed.length
    ? `清理 ${removed.length} 个陈旧文件（远端已删或换引擎残留）：${removed.slice(0, 5).join('、')}` +
      (removed.length > 5 ? ' 等' : '')
    : null;

  // 内容重叠（产物 ←→ 源目录都是登记库）必须当场说清：否则用户只会在检索时
  // 发现「同一篇笔记出两条」，或者反过来「我登记的产物怎么没被索引」。
  const overlapNote = overlapsWith
    ? `产物与源库 [${overlapsWith}] 内容重叠，默认不参与检索` +
      `（要索引它跑 ${APP_NAME} kb add "${dir}"；两者只要一个就够）`
    : null;

  return {
    status: 'ok',
    name: s.name,
    url: s.url,
    dir,
    kind: s.kind === 'local' ? 'local' : 'web',
    engine: eng,
    via: r.mode,
    enhanceLevel: Number.isInteger(s.enhanceLevel) ? s.enhanceLevel : 0,
    pages: r.pages,
    changes: r.stats,
    failed: r.stats.failed,
    failures: r.failures.slice(0, 20),
    removedFiles: removed,
    note: [r.note, pruneNote, overlapNote].filter(Boolean).join('；') || null,
    registered: true,
    // 供面板/CLI 直接判断要不要标一个「未参与检索」的徽标
    standby: !!overlapsWith,
    overlapsWith,
    hint: `跑 ${APP_NAME} index --root "${dir}" 把抓到的内容加进索引`,
  };
}

export async function run({ name, rebuild = false, engine } = {}) {
  if (engine !== undefined && engine !== null && engine !== '' && !ENGINES.includes(String(engine))) {
    throw badInput(`--engine 只能是 ${ENGINES.join(' | ')}，收到: ${engine}`);
  }

  const sources = await storedSources();
  if (!sources.length) {
    throw badInput(`还没有采集源 —— 先跑 ${APP_NAME} crawl add <url> --name <名>`);
  }

  const targets = name ? sources.filter((s) => s.name === String(name)) : sources;
  if (name && !targets.length) {
    throw notFound(`没有名为 ${name} 的采集源（有：${sources.map((s) => s.name).join('、')}）`);
  }

  // 串行：与 index 同样的理由——并发抓同一站点既不礼貌，日志也会交错。
  const results = [];
  for (const s of targets) results.push(await runOne(s, { rebuild: !!rebuild, engine }));

  return {
    status: 'ok',
    rebuild: !!rebuild,
    mode: rebuild ? 'rebuild' : 'incremental',
    count: results.length,
    results,
    totals: {
      pages: results.reduce((n, r) => n + (r.changes.added + r.changes.updated + r.changes.unchanged), 0),
      added: results.reduce((n, r) => n + r.changes.added, 0),
      updated: results.reduce((n, r) => n + r.changes.updated, 0),
      unchanged: results.reduce((n, r) => n + r.changes.unchanged, 0),
      removed: results.reduce((n, r) => n + (r.changes.removed || 0), 0),
      failed: results.reduce((n, r) => n + r.changes.failed, 0),
    },
  };
}

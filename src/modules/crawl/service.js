// crawl 域（资料采集）：把**vault 之外的文档站**抓下来、清洗成 markdown 入知识库。
//
// 设计要点（整个域只有一句话）：**抓取产物落成普通 .md 目录，再当作一个知识库登记。**
// 于是索引（zg）、检索、增量、多库合并、面板展示全部复用 kb 域，一行都不用特化；
// 采集域只负责「URL → 干净 markdown」这一件事。这是它能保持「一丢丢」的原因。
//
// 为什么是纯 Node（不套 Python 子进程，见 docs/plan/stage-5-external-collection-spec.md §1）：
// nx-kn 是发布到 npm 的包，要求用户另外装 Python 3.10+ / venv 直接违背
// 「装上即可用、不需要用户额外手动操作」。抓公开文档站既无登录也无验证码，
// 渲染交给 Node 内置 fetch + cheerio，不需要浏览器。
//
// 命令面（与 kb 域动词对齐）：
//   crawl add <url> [--name n] [--match glob] [--max n]   写：登记一个采集源
//   crawl run [--name n] [--rebuild]                      写：抓取并落成 md（默认增量）
//   crawl list                                            读：源列表 + 上次抓取统计
//   crawl remove <name> [--purge]                         写：解登记（默认保留文件）
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { badInput, conflict, external, notFound } from '../../core/errors/index.js';
import { loadStore, mutateStore } from '../../core/store.js';
import {
  APP_NAME,
  CRAWL_MANIFEST,
  CRAWL_UA,
  assertSafeName,
  crawlDelayMs,
  sourceDirOf,
} from '../../core/paths.js';
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash('sha256').update(String(s)).digest('hex');

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
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

// YAML 标量：标题里可能带冒号、井号、引号、换行。直接塞进 frontmatter 会破坏解析，
// 所以可疑的一律加引号并转义。多行标题压成单行（frontmatter 不支持真正的多行标量）。
function yamlScalar(v) {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '""';
  if (/^[A-Za-z0-9\u4e00-\u9fa5][^:#"'\n]*$/.test(s)) return s; // 简单安全值，裸写
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
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

// ---- store 里的源列表 ----

export async function storedSources() {
  const store = await loadStore();
  return (store.crawl && store.crawl.sources) || [];
}

// ---- add：登记一个采集源 ----

export async function add({ url, name, include, max } = {}) {
  if (!url) throw badInput(`用法: ${APP_NAME} crawl add <url> [--name <名>] [--match <glob>] [--max <n>]`);

  const abs = normalizeUrl(String(url));
  if (!abs) throw badInput(`不是合法的 http(s) 地址: ${url}`);

  const nm = name ? String(name) : deriveName(abs);
  assertSafeName(nm, '采集源名');

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
    include: inc,
    max: mx,
    createdAt: new Date().toISOString(),
    updatedAt: null,
    pages: {},
  });

  await mutateStore((store) => {
    store.crawl.sources.push({
      name: nm,
      url: abs,
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
    dir,
    include: inc,
    max: mx,
    count: (await storedSources()).length,
    hint: `跑 ${APP_NAME} crawl run --name ${nm} 开始抓取`,
  };
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

// ---- 发现：sitemap 优先，回退同域 BFS ----

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

// ---- run：抓取并落成 markdown ----

// 单个源的抓取。**串行 + 节流**（不并发）：既有礼貌，也让日志顺序可读。
async function runOne(s, { rebuild }) {
  const dir = sourceDirOf(s.name);
  await fsp.mkdir(dir, { recursive: true });

  const manifest = (await readManifest(dir)) || {};
  // --rebuild = 无视已存哈希，全部重写。默认增量：内容没变的页面**不落盘**，
  // 从而让后续 zg 增量索引如实报「unchanged」（不动 mtime，就不必重嵌入）。
  const prev = !rebuild && manifest.pages ? manifest.pages : {};
  const next = { ...(manifest.pages || {}) };

  const stats = { added: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0 };
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
          `  检查地址是否可访问、是否为静态 HTML；需要 JS 渲染的站点本版本不支持。`
      );
    }
  }

  await writeManifest(dir, {
    name: s.name,
    url: s.url,
    include: s.include,
    max: s.max,
    createdAt: manifest.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    via: mode,
    pages: next,
  });

  const now = new Date().toISOString();
  await mutateStore((store) => {
    const rec = store.crawl.sources.find((x) => x.name === s.name);
    if (rec) {
      rec.lastRunAt = now;
      rec.pages = Object.keys(next).length;
      rec.failed = stats.failed;
      rec.via = mode;
      rec.include = s.include;
      rec.max = s.max;
    }
    // 抓下来的目录**自动登记为知识库**（与手动 kb add 的结果完全同构）。
    // 有内容才登记：空目录进列表只会让人困惑。
    if (produced > 0 && !store.kb.vaults.some((v) => resolve(String(v.path)) === resolve(dir))) {
      store.kb.vaults.push({ path: dir, name: s.name, model: null, addedAt: now });
    }
    return store.crawl.sources;
  });

  return {
    status: 'ok',
    name: s.name,
    url: s.url,
    dir,
    via: mode,
    pages: Object.keys(next).length,
    changes: { added: stats.added, updated: stats.updated, unchanged: stats.unchanged, skipped: stats.skipped },
    failed: stats.failed,
    failures: failures.slice(0, 20),
    registered: true,
    hint: `跑 ${APP_NAME} index --root "${dir}" 把抓到的内容加进索引`,
  };
}

export async function run({ name, rebuild = false } = {}) {
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
  for (const s of targets) results.push(await runOne(s, { rebuild: !!rebuild }));

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
      failed: results.reduce((n, r) => n + r.failed, 0),
    },
  };
}

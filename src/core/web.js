// 网页解析与清洗：把「一个文档站的 HTML」变成「干净 markdown」。
//
// 分层位置：core（零业务语义）。只回答三件事——
//   1. 一个 URL 是不是我们要的（http(s)、同源、怎么归一）
//   2. 一份 HTML 里的正文在哪、链接有哪些
//   3. 怎么把正文 HTML 转成 markdown
// 「抓哪些页、多久抓一次、存到哪、抓完要不要登记成知识库」属于业务，
// 在 modules/crawl/service.js。
//
// 为什么这些函数**全都要能被单测**：抓取是不可复现的（站点会变），
// 但「HTML → markdown」这一步是纯函数。把不确定性关在网络那一层，
// 解析这一层就必须能在 CI 里用本地 fixture 逐字节断言。
import { load } from 'cheerio';
import TurndownService from 'turndown';
import * as gfmModule from 'turndown-plugin-gfm';

// turndown-plugin-gfm 是 CJS：ESM 下具名导入取决于 cjs 词法分析，
// 不同 Node/打包器表现不一。这里两种形态都兜住，免得因加载方式差异崩在启动期。
const gfm = gfmModule.gfm || (gfmModule.default && gfmModule.default.gfm);

// ---- URL ----

// 归一化：解析成绝对 URL，丢掉 hash（同页锚点不是新页面），只认 http(s)。
// 解析失败或非 http(s)（mailto:、javascript:、ftp:）一律返回 null —— 调用方据此跳过。
export function normalizeUrl(input, base) {
  if (input === undefined || input === null) return null;
  let u;
  try {
    u = base ? new URL(String(input), base) : new URL(String(input));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return u.toString();
}

export function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

// 同源判定：host（含端口）与协议都要一致。跨域链接不抓——
// 文档站常链到外部（GitHub、npm），跟着爬会跑出站点边界。
export function sameOrigin(a, b) {
  const oa = originOf(a);
  const ob = originOf(b);
  return !!oa && !!ob && oa === ob;
}

// sitemap 的常见位置。按 sitemap 协议，它在**站点根**，与起始页的子路径无关。
export function sitemapCandidates(startUrl) {
  const o = originOf(startUrl);
  if (!o) return [];
  return [`${o}/sitemap.xml`];
}

// ---- 内容类型 ----

export function isHtmlContentType(ct) {
  if (!ct) return false;
  const s = String(ct).toLowerCase();
  return s.includes('text/html') || s.includes('application/xhtml+xml');
}

export function isXmlContentType(ct) {
  if (!ct) return false;
  const s = String(ct).toLowerCase();
  return s.includes('xml');
}

// ---- sitemap ----

// 解析 sitemap.xml。两种形态：
//   <urlset>       → <loc> 是**页面** URL
//   <sitemapindex> → <loc> 是**子 sitemap** URL（要递归）
// 有的站点省略根标签或带命名空间前缀，故再用「是否以 .xml 结尾」做一次启发式判断，
// 免得把子 sitemap 当页面去抓（结果是一堆 XML 被转成垃圾 markdown）。
export function parseSitemap(xml) {
  const text = String(xml || '');
  const locs = [...text.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((m) => m[1].trim())
    .filter(Boolean);

  const hasUrlset = /<urlset[\s>]/i.test(text);
  const hasIndex = /<sitemapindex[\s>]/i.test(text);
  const allXml = locs.length > 0 && locs.every((l) => /\.xmlz?($|\?)/i.test(l) || /\.xml/i.test(l));
  const isIndex = hasIndex || (!hasUrlset && allXml);

  return { isIndex, isUrlset: hasUrlset || (!hasIndex && !allXml), locs };
}

// ---- 正文抽取 ----

// 版式噪声：导航、页脚、侧栏、目录树、面包屑、上下页、编辑链接……
// 这些在文档站上占了近半的文本量，全进 markdown 会淹没正文（也污染检索）。
const NOISE_SELECTORS = [
  'script', 'style', 'noscript', 'template', 'link', 'meta',
  'iframe', 'nav', 'footer', 'header', 'aside', 'form', 'button',
  'img', 'svg', 'canvas', // 检索用不到图片；CDN 绝对 URL 纯噪声
  '.sidebar', '.side-bar', '.sidebar-content', '.sidebar-wrapper',
  '.nav', '.navbar', '.nav-bar', '.menu', '.toc', '.table-of-contents',
  '.breadcrumbs', '.breadcrumb', '.pagination', '.pager', '.page-nav',
  '.prev-next', '.next-prev', '.edit-link', '.edit-page-link', '.edit-this-page',
  '.doc-footer', '.page-footer', '.announcement', '.skip-link',
  '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '[role="search"]', '[aria-hidden="true"]',
].join(', ');

// 正文容器候选，按「越具体越优先」排列。文档站（VitePress / Docusaurus /
// mkdocs / VuePress / GitBook）各有各的类名，逐个认一遍比只认 <main> 稳。
const ROOT_SELECTORS = [
  'main',
  'article',
  '[role="main"]',
  '#content',
  '.theme-default-content', // VitePress / VuePress
  '.vp-doc',
  '.markdown-body', // GitHub 系
  '.md-content', // mkdocs-material
  '.doc-content',
  '.content',
];

const MIN_ROOT_TEXT = 200; // 候选容器的正文短于这个数，就认为没选中正文

function absoluteAttrs($, $root, baseUrl) {
  const absolutize = (sel, attr) => {
    $root.find(sel).each((_, el) => {
      const v = $(el).attr(attr);
      if (!v) return;
      const abs = normalizeUrl(v, baseUrl);
      if (abs) $(el).attr(attr, abs);
    });
  };
  absolutize('a[href]', 'href');
  absolutize('img[src]', 'src');
}

function pickRoot($) {
  let best = null;
  let bestLen = -1;
  for (const sel of ROOT_SELECTORS) {
    const $c = $(sel).first();
    if (!$c.length) continue;
    const len = $c.text().trim().length;
    if (len >= MIN_ROOT_TEXT) return $c;
    if (len > bestLen) {
      best = $c;
      bestLen = len;
    }
  }
  return best || $('body');
}

function makeTurndown() {
  const td = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    fence: '```',
    emDelimiter: '*',
    strongDelimiter: '**',
    linkStyle: 'inlined',
  });
  if (typeof gfm === 'function') td.use(gfm);
  // 去空链接（文档站里大量 <a id> 锚点是空的，转出来是 []() 噪声）
  td.addRule('emptyLink', {
    filter: (node) => node.nodeName === 'A' && !node.textContent.trim() && !node.querySelector('img'),
    replacement: () => '',
  });
  return td;
}

let sharedTurndown = null;

/**
 * 把 HTML 转成干净 markdown。
 * @returns {{ title: string|null, markdown: string, links: string[] }}
 */
export function htmlToMarkdown(html, { url } = {}) {
  const $ = load(String(html || ''));
  const title =
    $('title').first().text().trim() ||
    $('h1').first().text().trim() ||
    null;

  // 链接先抽取再删噪声：正文内的同域链接是「BFS 发现」的输入
  const baseUrl = url || undefined;
  const links = new Set();
  $('a[href]').each((_, el) => {
    const abs = normalizeUrl($(el).attr('href'), baseUrl);
    if (abs) links.add(abs);
  });

  $(NOISE_SELECTORS).remove();

  const $root = pickRoot($);
  if (baseUrl) absoluteAttrs($, $root, baseUrl);

  if (!sharedTurndown) sharedTurndown = makeTurndown();
  const rawMd = sharedTurndown.turndown($root.html() || '');

  return {
    title,
    markdown: tidyMarkdown(rawMd),
    links: [...links],
  };
}

// 收敛转义与空白：turndown 会产出连续空行、行尾空格、以及把中文标点转义。
// 这些不影响渲染，但会让「同样的内容两次抓取得到不同字节」——增量判定会因此失真。
export function tidyMarkdown(md) {
  return String(md || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '') // 行尾空白
    .replace(/\n{3,}/g, '\n\n') // 三个以上换行 → 一个空行
    .trim();
}

// ---- glob（`--match` 用）----

// 把 glob 编译成正则。只支持 `**`（跨段）、`*`（段内）、`?`（单字符）三种，
// 够文档站用；引入完整 glob 库不值得（多一个依赖，而为的是十几行逻辑）。
export function globToRegExp(glob) {
  const P = '\u0000'; // 占位符：先把 `**` 摘出来，免得被 `*` 的单段规则吃掉
  const g = String(glob ?? '').split('**').join(P);
  let re = '';
  for (const c of g) {
    if (c === P) re += '\u0001'; // 稍后还原成 .*
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re.split('\u0001').join('.*') + '$');
}

// 空模式 / `**` = 全都匹配（默认口径）。
export function globMatch(pattern, value) {
  if (!pattern || pattern === '**') return true;
  return globToRegExp(pattern).test(String(value ?? ''));
}

// URL 的路径部分（glob 作用在路径上，而不是整条 URL——否则 `**` 会连协议头一起吞）。
export function pathOf(url) {
  try {
    return new URL(String(url)).pathname;
  } catch {
    return String(url ?? '');
  }
}

// ---- 抓取（唯一带网络的一步）----

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

/**
 * 取一个 URL 的文本内容。**永不抛**——返回 { ok, status, contentType, text, finalUrl, error }，
 * 由调用方决定「这是业务结果还是失败」（与 core/zg.js 的 runZg 同一条纪律）。
 */
export async function fetchText(url, { timeoutMs = 20_000, ua, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': ua || 'nx-kn',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    const contentType = res.headers.get('content-type') || '';
    if (!res.ok) {
      return { ok: false, status: res.status, contentType, error: `HTTP ${res.status}` };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes) {
      return { ok: false, status: res.status, contentType, error: `响应过大（${buf.length} 字节 > ${maxBytes}）` };
    }
    return {
      ok: true,
      status: res.status,
      contentType,
      text: buf.toString('utf8'),
      finalUrl: res.url || url,
    };
  } catch (err) {
    const e = err || {};
    const msg = e.name === 'AbortError' ? `超时（${timeoutMs}ms）` : String(e.message || e);
    return { ok: false, status: 0, contentType: '', error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---- URL → 落盘文件路径 ----

// 把页面 URL 映射成源目录内的相对 .md 路径。
//   https://x.com/guide/getting-started  → guide/getting-started.md
//   https://x.com/                     → index.md
//   https://x.com/api/v2/reference.html→ api/v2/reference.md
// baseUrl 是起始 URL：它的目录前缀会被剥掉，否则 <name>/docs/guide/xxx.md 会多一层。
export function pageFileFor(url, baseUrl) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return null;
  }

  let path = decodeURIComponent(u.pathname || '/');
  const base = (() => {
    try {
      return new URL(String(baseUrl || '')).pathname || '/';
    } catch {
      return '/';
    }
  })();

  // 剥掉起始 URL 的目录前缀（只剥目录、不剥文件名）
  const baseDir = base.endsWith('/') ? base : base.replace(/[^/]*$/, '');
  if (baseDir && baseDir !== '/' && path.startsWith(baseDir)) {
    path = path.slice(baseDir.length);
  }

  path = path.replace(/^\/+/, '');
  if (!path || path.endsWith('/')) path += 'index';
  // 去掉扩展名，统一 .md（.html/.htm/.php 等都算；无扩展名也补 .md）
  path = path.replace(/\.(html?|php|aspx?|jsp)$/i, '');
  if (!/\.md$/i.test(path)) path += '.md';

  // 逐段清洗：去掉非法字符、丢弃 . 与 ..（防目录穿越）、限长
  const segs = path
    .split('/')
    .map((s) =>
      s
        .replace(/[<>:"|?*\u0000-\u001f]/g, '-')
        .replace(/^\.+$/, '')
        .trim()
    )
    .filter((s) => s && s !== '.' && s !== '..')
    .map((s) => (s.length > 80 ? s.slice(0, 80) : s));

  if (!segs.length) return 'index.md';
  return segs.join('/');
}

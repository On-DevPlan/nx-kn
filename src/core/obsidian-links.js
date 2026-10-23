// 双链（[[wikilink]]）解析与 frontmatter 生成：纯逻辑，零业务语义。
//
// 分层位置：core。本文件是 kn-obsidian-repair-unresolved-links skill 原先自带的
// 三个 Python 脚本（scan_unresolved.py / gen_frontmatter.py / postcheck.py）的
// **逐条对照移植**——那些脚本的每一处「不严谨」都是被真实 vault 磨出来的
// （全角空格、代码块里的示例链接、模板目录、GBK 编码……）。
// 改一处就可能让「未解析」的口径漂移，而漂移的代价是**误建笔记**：
// 把已存在的笔记当成红链，又在 source 旁边建一份。
//
// 所以这里的规则都写明出处；与 Python 版**有意不同**的地方也在注释里点出来了。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

// ---- 词法常量（逐字照搬 Python 版）----

// 双链正文：`[[` 与 `]]` 之间**至少一个**非 `]` 字符。
// `[^]]+` 而非 `[^]]*` 是有意的：`[[]]` 不算链接。
export const WIKI_RE = /\[\[([^\]]+)\]\]/g;

// 附件扩展名：清洗后的链接以其中之一结尾即视为附件（Obsidian 当附件处理）。
// 注意 `.md` **不在**其中——`[[foo.md]]` 算笔记链接。
export const ATTACHMENT_EXTS = [
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp',
  '.pdf', '.mp4', '.mp3', '.wav', '.mov', '.webm', '.zip',
  '.tar', '.gz', '.rar', '.7z',
];

// 文件名非法字符（Python 版 ILLEGAL）：注意 `,` 与 `.` **不在**其中。
export const ILLEGAL_NAME_RE = /[*"\\/<>:?]/g;

export const DEFAULT_FRONTMATTER_KEYS = ['creatime', 'tags', 'bklink'];

// 键名别名表：Python 版按 key.lower() 匹配，决定这一行生成什么。
const TIME_ALIASES = ['creatime', 'created', 'create_time', 'date'];
const TAG_ALIASES = ['tags', 'tag'];
const BKLINK_ALIASES = ['bklink', 'backlinks', 'backlink', 'aliases'];

// Python 的 str.strip() 认的空白集：含 U+3000 / U+00A0，**不含 U+FEFF**。
// JS 的 String.prototype.trim() 认 U+FEFF —— 直接用它会把带 BOM 的双链误裁，
// 所以这里自写一份。
const PY_SPACE_CODES = new Set([
  9, 10, 11, 12, 13, 32, 0x1c, 0x1d, 0x1e, 0x1f, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006,
  0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

export function pythonTrim(s) {
  let start = 0;
  let end = s.length;
  while (start < end && PY_SPACE_CODES.has(s.charCodeAt(start))) start += 1;
  while (end > start && PY_SPACE_CODES.has(s.charCodeAt(end - 1))) end -= 1;
  return s.slice(start, end);
}

// ---- 文件解码 ----

// 解码链照搬 Python 版：utf-8-sig → utf-8 → cp936 → gbk → utf-8(replace)。
//
// Node 没有 cp936/gbk 编码器，但自带 full-ICU 的 TextDecoder('gbk')
// （Node 18+ 默认带 full-icu）。用 {fatal:true} 复刻「解不了就试下一个编码」的语义：
// 非 fatal 的 TextDecoder 会静默替换成 U+FFFD，那会把 GBK 文件解成乱码而不报错。
export function decodeVaultFile(buf) {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  try {
    // 'utf-8' 会自动剥掉 BOM（ignoreBOM 默认 false）——等价于 Python 的 utf-8-sig 优先。
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    /* 继续试下一个编码 */
  }
  try {
    // cp936 与 gbk 在 ICU 里是同一个编解码器。
    return new TextDecoder('gbk', { fatal: true }).decode(bytes);
  } catch {
    /* 继续 */
  }
  // 最后兜底：解不了的字节替换成 U+FFFD（与 Python 的 errors='replace' 一致）。
  return new TextDecoder('utf-8').decode(bytes);
}

// ---- 双链提取 ----

// 清洗顺序固定：先 `#`（标题）再 `|`（别名），最后 trim。
// 顺序反了结果会不同：`[[a|b#c]]` 先切 `#` 得 "a|b" 再切 `|` 得 "a"。
export function cleanLinkTarget(raw) {
  return pythonTrim(String(raw).split('#')[0].split('|')[0]);
}

// 剔除成对的行内反引号：`[[foo]]` 写在反引号里不算链接。
// 只认成对的（`[^`]*`），落单的反引号不产生匹配。
export function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, '');
}

/**
 * 扫一行，返回本行的链接目标与更新后的代码块状态。
 *
 * 代码围栏状态机照搬 Python 版 `is_code_block_skip`：
 * - 行首（去空白后）是 ``` → 状态翻转
 * - **开围栏那一行被跳过，闭围栏那一行不跳过**（Python 版的不对称行为，原样保留）
 */
export function scanLineForLinks(line, state) {
  const st = state || { inCode: false };
  const stripped = pythonTrim(line);
  if (stripped.startsWith('```')) {
    const skip = !st.inCode;
    st.inCode = !st.inCode;
    if (skip) return { links: [], state: st };
  } else if (st.inCode) {
    return { links: [], state: st };
  }

  const cleaned = stripInlineCode(line);
  const links = [];
  for (const m of cleaned.matchAll(WIKI_RE)) {
    const t = cleanLinkTarget(m[1]);
    if (t) links.push(t);
  }
  return { links, state: st };
}

// Python 版 os.path.splitext：只去掉**最后一个**扩展名，且不处理前导点。
export function splitExt(name) {
  const i = name.lastIndexOf('.');
  if (i <= 0) return [name, ''];
  return [name.slice(0, i), name.slice(i)];
}

// basename（Windows 上同时按 / 与 \ 切）。
export function baseName(p) {
  const s = String(p).replace(/\\/g, '/');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

/**
 * 建索引：by_stem（basename 去扩展名）+ by_path（相对路径去最后一个扩展名）。
 *
 * 相对路径用 `/` 分隔（Python 版把 `\` 换成 `/`）。
 */
export function buildLinkIndex(relFiles) {
  const byStem = new Map();
  const byPath = new Map();
  for (const rel of relFiles) {
    const [stem] = splitExt(baseName(rel));
    if (!byStem.has(stem)) byStem.set(stem, []);
    byStem.get(stem).push(rel);
    const [relNoExt] = splitExt(rel);
    if (!byPath.has(relNoExt)) byPath.set(relNoExt, []);
    byPath.get(relNoExt).push(rel);
  }
  return { byStem, byPath };
}

export function isAttachmentLink(text) {
  const lower = String(text).toLowerCase();
  return ATTACHMENT_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * 判断一个链接目标能否解析到既有笔记。**大小写敏感**（沿用 Python 版）。
 *
 * 已知偏差：Obsidian 本身大小写不敏感，`[[Foo]]` 在 Obsidian 里能跳到 `foo.md`，
 * 这里判为未解析。这是既有行为，本阶段不修（改了会让「未解析」的口径整体漂移）。
 */
export function resolveLinkTarget(link, index) {
  const noExt = link.toLowerCase().endsWith('.md') ? link.slice(0, -3) : link;
  if (index.byPath.has(noExt)) return true;
  if (index.byPath.has(link)) return true;
  const stem = baseName(noExt);
  return index.byStem.has(stem);
}

// ---- 文件名清洗 ----

// FNV-1a（32 位）：替代 Python 版 sanitize() 兜底名用的 hash()。
// Python 的 str.__hash__ 每进程随机化 → 同一个链接两次运行得到不同文件名；
// 移植必须换成确定性哈希，否则「兜底名」在重跑时会漂。
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 清洗成合法文件名。逐条照搬 Python 版：
 *   1. 删掉 `* " \ / < > : | ?`（注意 `,` 与 `.` 不删）
 *   2. 去首尾空白
 *   3. 去首尾的点
 *   4. 把 **2+ 个 ASCII 空格**折成一个（只折 ASCII 空格，全角空格不折）
 *   5. 空则兜底 `unresolved-<0..9999>`
 *
 * 第 3 步在第 4 步之前，所以 " . x . " 的结果是 " x "（前后各留一个空格）——
 * 这是 Python 版的行为，不修。
 */
export function sanitizeName(raw) {
  let name = String(raw).replace(ILLEGAL_NAME_RE, '');
  name = pythonTrim(name);
  name = name.replace(/^\.+/, '').replace(/\.+$/, '');
  name = name.replace(/ {2,}/g, ' ');
  if (!name) name = `unresolved-${fnv1a(String(raw)) % 10000}`;
  return name;
}

// ---- frontmatter 生成 ----

// 本地时区的 YYYY-MM-DD HH:MM:SS（Python 版 datetime.now().strftime）。
// 刻意不用 toISOString()——那是 UTC，会和 vault 里已有的时间戳差几个小时。
export function formatLocalTimestamp(now = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
    `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`
  );
}

/**
 * 生成 frontmatter YAML 段（不含末尾换行）。
 *
 * 形状照搬 Python 版：
 *   ---
 *   creatime: 2026-06-21 14:00:00
 *   tags: []
 *   bklink:
 *     - "[[base_日常]]"
 *   ---
 *
 * bklink 条目按 basename 去重、保持先到先得；空列表时写 `bklink: []`。
 *
 * `extra` 是附加字段（追加在三段之后），如 `{ project: 'D:\\repos\\app' }` ——
 * 项目解读模式用它在 frontmatter 里记录「这篇文档讲的是哪个代码库」，
 * 后续双链拷问时 agent 读它就知道要去读哪份源码。
 */
export function genFrontmatterYaml({
  keys = DEFAULT_FRONTMATTER_KEYS,
  bklink = [],
  now = new Date(),
  extra = null,
} = {}) {
  const ts = formatLocalTimestamp(now);
  const lines = ['---'];
  for (const key of keys) {
    const k = String(key).toLowerCase();
    if (TIME_ALIASES.includes(k)) {
      lines.push(`${key}: ${ts}`);
    } else if (TAG_ALIASES.includes(k)) {
      lines.push(`${key}: []`);
    } else if (BKLINK_ALIASES.includes(k)) {
      if (bklink.length) {
        lines.push(`${key}:`);
        const seen = new Set();
        for (const entry of bklink) {
          // Python 版在**调用方**就 splitext 过了，这里再取一次是为了两种传法
          // （传 stem 或传 '日常/foo.md'）结果一致——否则会生成 [[foo.md]] 这种
          // 带扩展名的链接，和 vault 里既有笔记的写法不一致。
          const [stem] = splitExt(baseName(entry));
          if (seen.has(stem)) continue;
          seen.add(stem);
          lines.push(`  - "[[${stem}]]"`);
        }
      } else {
        lines.push(`${key}: []`);
      }
    } else {
      lines.push(`${key}:`);
    }
  }
  // 附加字段（如 project：这篇文档讲的是哪个代码库）——追加在三段之后。
  // 值含反斜杠的 Windows 路径按 YAML 双引号标量写，避免 `\` 被当转义序列。
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      if (v === undefined || v === null || v === '') continue;
      lines.push(`${k}: "${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

// ---- 目录遍历 ----

// scan 的目录过滤：**只**跳过这三个名字（照搬 Python 版）。
// locate（找引用源）用的是另一套过滤：跳过**所有**点目录 + 整个 ctl/。
// 两套都必须有——它们是不同用途，行为不能混。
export const SCAN_SKIP_DIRS = new Set(['.obsidian', '.git', '.claude']);

// scan 的过滤谓词
export function skipScanDir(name) {
  return SCAN_SKIP_DIRS.has(name);
}

// locate 的过滤谓词：所有点目录 + 整个 ctl/
export function skipLocateDir(name) {
  return name.startsWith('.') || name === 'ctl';
}

/**
 * 递归枚举 vault 下的 .md，返回**相对 vault 根**的路径（`/` 分隔）。
 *
 * 与 Python 版的有意差异：目录与文件都**排序**后遍历。Python 的 os.walk 只排文件、
 * 不排目录，跨目录的顺序取决于文件系统；这里排序是为了让输出可复现
 * （「同样的 vault，两次跑出来的顺序一样」比「和 Python 版顺序一样」更重要）。
 */
export function listVaultMarkdown(vault, { skipDir = skipScanDir } = {}) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (skipDir(e.name)) continue;
        walk(p);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        out.push(p.slice(vault.length + 1).replace(/\\/g, '/'));
      }
    }
  };
  walk(vault);
  return out;
}

// 码点序比较（Python 的 sorted() 是码点序；JS 默认的 UTF-16 码元序在
// 星平面字符上会与它不同——vault 文件名里偶尔有 emoji）。
export function compareCodePoint(a, b) {
  const ca = Array.from(a);
  const cb = Array.from(b);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i += 1) {
    const x = ca[i].codePointAt(0);
    const y = cb[i].codePointAt(0);
    if (x !== y) return x < y ? -1 : 1;
  }
  return ca.length - cb.length;
}

/**
 * 扫出 vault 里**未解析**的双链（Python 版 scan_unresolved.py 的移植）。
 *
 * 返回 `[{ link, sources: [{ file, line }] }]`，按 link 码点序排序。
 *
 * 与 Python 版一致的关键点：
 * - 索引（by_stem / by_path）覆盖**全部** md（含 ctl/tmpl_*）→ 链到模板算已解析
 * - 扫描时跳过 `ctl/tmpl_*`（模板里的占位链接不算）
 * - 自链接（链接 === 当前文件 basename）不算未解析
 * - 附件扩展名忽略
 * - 代码围栏与行内代码里的链接不算
 */
/**
 * 扫出 vault 里**未解析**的双链（Python 版 scan_unresolved.py 的移植）。
 *
 * `scanRoot` = 扫描范围（相对 vault 根，如 `projects/dataweb`）：
 * - **哪些文件里的链接会被收集** 只看这个范围（多项目并发时各自只动自己那份）；
 * - **链接能否解析** 仍对照**全库**索引——否则链到共享笔记 / 别的项目的笔记会被
 *   误报成红链，agent 就会跑去重复建一份（那才是真正破坏隔离的地方）。
 *
 * 返回 `[{ link, sources: [{ file, line }] }]`，按 link 码点序排序。
 */
export function scanVaultUnresolved(vault, { scanRoot = '' } = {}) {
  const files = listVaultMarkdown(vault, { skipDir: skipScanDir });
  const index = buildLinkIndex(files);
  const scope = scanRoot ? scanRoot.replace(/\\/g, '/').replace(/\/+$/, '') : '';
  const scanFiles = scope
    ? files.filter((f) => f === scope || f.startsWith(`${scope}/`))
    : files;
  const unresolved = new Map();

  for (const rel of scanFiles) {
    if (rel.startsWith('ctl/tmpl_')) continue; // 模板占位链接
    const text = readVaultText(join(vault, rel));
    const [selfStem] = splitExt(baseName(rel));
    const state = { inCode: false };
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const { links } = scanLineForLinks(lines[i], state);
      for (const link of links) {
        if (isAttachmentLink(link)) continue;
        if (link === selfStem) continue; // 自链接
        if (resolveLinkTarget(link, index)) continue;
        if (!unresolved.has(link)) unresolved.set(link, []);
        unresolved.get(link).push({ file: rel, line: i + 1 });
      }
    }
  }

  return [...unresolved.entries()]
    .sort((a, b) => compareCodePoint(a[0], b[0]))
    .map(([link, sources]) => ({ link, sources }));
}

/**
 * 找出引用了某个链接的所有位置（Python 版 gen_frontmatter.py 的 find_sources）。
 *
 * 与 scan 的**两处有意不同**（照搬 Python 版 find_sources 的规则）：
 * - 目录过滤更严：跳过所有点目录 + 整个 ctl/
 * - **不做**代码围栏与行内代码剔除（这里只做字面匹配）
 * - 比较目标是 `--link` 的**原值**（不去 # / |、不 trim）
 */
export function findLinkSources(vault, linkText) {
  const files = listVaultMarkdown(vault, { skipDir: skipLocateDir });
  const hits = [];
  for (const rel of files) {
    const text = readVaultText(join(vault, rel));
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      for (const m of line.matchAll(WIKI_RE)) {
        if (cleanLinkTarget(m[1]) === linkText) hits.push({ file: rel, line: i + 1 });
      }
    }
  }
  return hits;
}

// 读一个 vault 内文件并按解码链解出来；读不动返回空串（照搬 Python 版的 except: continue）。
export function readVaultText(path) {
  try {
    return decodeVaultFile(readFileSync(path));
  } catch {
    return '';
  }
}

export function dirExists(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// 从 start 往上找 vault 根（含 .obsidian 的那一层）。
// 找不到返回 null（Python 版是抛 RuntimeError；这里改成返回 null，
// 由调用方决定报「未设置」还是「找不到」——错误文案要分得清这两种情况）。
export function findVaultRoot(start) {
  let p = resolve(start);
  for (;;) {
    try {
      if (statSync(join(p, '.obsidian')).isDirectory()) return p;
    } catch {
      /* 不是 vault 根，继续往上 */
    }
    const parent = dirname(p);
    if (parent === p) return null;
    p = parent;
  }
}

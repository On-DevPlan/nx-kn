// 检索命中高亮：把问句拆成「能在片段里字面匹配的词」，再由视图标黄。
//
// ---- 为什么在前端自己算，而不是让 zg 标 ----
// zg 内部确实有高亮（@zvec/zvec-grep/dist/cli/format/highlight.js），但对我们没用：
//   1. 它只在 TTY 或 --color=always 下生效，输出的是 ANSI 转义（`\x1b[1;33m`）。
//      我们经管道 spawn（runZg），拿到的是**不带任何标记的纯文本**——面板无从得知
//      「哪几个字命中了」。
//   2. 它的中文分词是「整句当一个 term」：问「登录页为什么提示超时」时，term 就是
//      这 10 个字连起来的整串，片段里几乎不可能原样出现 → 一个字都标不出来。
// 于是按检索的通用做法自己切：英文/数字整词，中文按 **2-gram**（bigram）。
//
// ---- 为什么中文用 2-gram ----
// 中文没有词边界，任何「词表 + 分词」都要背一个大词典，且新词（术语、人名的组合）
// 一律切不出。bigram（相邻两字）不需要词典、覆盖所有词，代价是会产生跨词的噪声
// 组合（「页为」）。而这些噪声组合在正文里出现同一相邻关系的概率很低，误标极少；
// 更要紧的是**相邻 bigram 的区间会在合并阶段拼回整串**——原文里真有「登录超时」
// 时，`登录`/`录超`/`超时` 三段命中会并成一个「登录超时」的连续高亮块。
//
// 纯函数、零依赖、不碰 DOM —— 单测逐字钉在 tests/unit/highlight.test.mjs。

// 英文/数字标识符：允许内部出现 `-` 与 `.`（`nx-kn`、`qwen3-embedding-0.6b`、
// `v1.2`），但不允许以它们结尾（否则会把句末的句号吃进词里）。
const WORD_RE = /[A-Za-z_][A-Za-z0-9_]*(?:[.\-][A-Za-z0-9_]+)*/g;
const NUM_RE = /\d+(?:\.\d+)?/g;
// CJK 统一表意文字（含扩展 A）：中日韩混排时只切出汉字串，假名/谚文不参与。
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]+/g;

// 停用词：标黄的目的是「一眼看到命中在哪」，而这些词在正文里遍地都是——
// 让它们一起变黄，真正的命中反而淹没在黄块里。
// 英文部分抄 zg 的表（与召回引擎同一口径，它同样认为这些词不承载语义）；
// 中文部分是 2-gram 形态的疑问/功能词，跳过它们等价于「不给虚词标黄」。
const STOP = new Set([
  // 英文（与 zg highlight.js 的 ignored 表一致）
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'can', 'class', 'do', 'does',
  'enum', 'find', 'for', 'from', 'function', 'how', 'i', 'if', 'in', 'interface',
  'is', 'it', 'method', 'of', 'on', 'or', 'should', 'struct', 'the', 'to', 'type',
  'use', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'why', 'will', 'with',
  // 中文（bigram 形态：疑问、指代、助动词、连词）
  '为什', '什么', '怎么', '如何', '为何', '哪些', '哪个', '这个', '那个', '这些',
  '那些', '是否', '可以', '能够', '我们', '你们', '他们', '它们', '是不', '不是',
  '没有', '需要', '应该', '如果', '因为', '所以', '但是', '而且', '并且', '还是',
  '或者', '就是', '只是', '为了', '以及',
]);

/**
 * 从问句里提取「值得标黄」的词。
 * 返回去重后的词表，长的在前（同位置多候选时优先匹配更长的词）。
 */
export function highlightTerms(query) {
  const text = String(query ?? '');
  if (!text.trim()) return [];
  const terms = new Set();

  for (const m of text.matchAll(WORD_RE)) {
    const t = m[0];
    if (t.length >= 2 && !STOP.has(t.toLowerCase())) terms.add(t);
  }
  for (const m of text.matchAll(NUM_RE)) {
    // 单个数字（「3」「7」）在正文里毫无区分度，至少两位才收。
    if (m[0].length >= 2) terms.add(m[0]);
  }
  for (const m of text.matchAll(CJK_RE)) {
    const s = m[0];
    // 单字不成词：只标一个字的话，半个面板都会是黄的。
    for (let i = 0; i + 2 <= s.length; i++) {
      const gram = s.slice(i, i + 2);
      if (!STOP.has(gram)) terms.add(gram);
    }
  }

  return [...terms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/**
 * 把文本切成 [{ text, hit }] 片段：hit=true 的片段就是该标黄的部分。
 *
 * 匹配一律用 indexOf（先转小写），**不用 RegExp**：问句是用户随手敲的，
 * 里面出现 `(`、`*`、`?`、`.` 是常态——当正则会抛异常，当字面才正确。
 */
export function splitHighlight(text, query, terms) {
  const src = String(text ?? '');
  const list = terms || highlightTerms(query);
  if (!src || !list.length) return [{ text: src, hit: false }];

  const lower = src.toLowerCase();
  const ranges = [];
  for (const term of list) {
    const lt = String(term).toLowerCase();
    if (!lt) continue;
    let from = 0;
    for (;;) {
      const at = lower.indexOf(lt, from);
      if (at < 0) break;
      ranges.push([at, at + lt.length]);
      from = at + lt.length; // 同一词不自我重叠；跨词重叠交给下面的合并
    }
  }
  if (!ranges.length) return [{ text: src, hit: false }];

  // 合并重叠/相接的区间：相邻 bigram（`[7,9)` 与 `[8,10)`）会并成整词的连续块。
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }

  const out = [];
  let cursor = 0;
  for (const [start, end] of merged) {
    if (start > cursor) out.push({ text: src.slice(cursor, start), hit: false });
    out.push({ text: src.slice(start, end), hit: true });
    cursor = end;
  }
  if (cursor < src.length) out.push({ text: src.slice(cursor), hit: false });
  return out;
}

// 文档文本提取：DOCX 与 PDF，零依赖。
//
// 为什么不引库：本仓的依赖观是「解析这类边界活要么零依赖、要么声明外部引擎」
// （见 crawl 的双引擎取舍）。DOCX 本质是 zip + XML（Node 自带 zlib 就能解）；
// PDF 的文本流多数是 FlateDecode，同样 inflate 可得。两个提取器都按「尽力而为」
// 设计：提取不出（加密、扫描件、CID 字体）就返回 null，调用方保留原件、
// 条目照常入库——收件箱的第一承诺是「收进来」，文本化是加分项不是门槛。

import { inflateRawSync, inflateSync } from 'node:zlib';

// ---- zip 读取（只为 DOCX 服务） ----
//
// 走中央目录而不是扫本地文件头：flags 第 3 位（0x08）置位时本地头里的 sizes
// 是 0、真实尺寸在数据描述符里——只扫本地头遇到流式写出的 zip（正是 docx 常见
// 的产出方式）就会读错位置。中央目录里 sizes 永远是准的。
function u16(b, o) {
  return b[o] | (b[o + 1] << 8);
}
function u32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// 返回 [{name, data}]；解析失败抛错（调用方决定降级方式）。
function zipEntries(buf) {
  // EOCD：从尾部往前扫签名。comment 最长 65535，扫太远没意义。
  const minEocd = 22;
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= 0 && i >= buf.length - minEocd - 65536; i--) {
    if (u32(buf, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip（找不到中央目录结尾）');
  const count = u16(buf, eocd + 10);
  let off = u32(buf, eocd + 16);

  const out = [];
  for (let n = 0; n < count; n++) {
    if (off + 46 > buf.length || u32(buf, off) !== 0x02014b50) throw new Error('zip 中央目录损坏');
    const method = u16(buf, off + 10);
    const compressedSize = u32(buf, off + 20);
    const nameLen = u16(buf, off + 28);
    const extraLen = u16(buf, off + 30);
    const commentLen = u16(buf, off + 32);
    const localOff = u32(buf, off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');

    // 跳到本地头取「它自己的」name/extra 长度——两处的 extra 可以不一样长，
    // 数据区起点必须按本地头的来。
    if (localOff + 30 > buf.length || u32(buf, localOff) !== 0x04034b50) {
      throw new Error(`zip 本地头损坏: ${name}`);
    }
    const lNameLen = u16(buf, localOff + 26);
    const lExtraLen = u16(buf, localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compressedSize);
    out.push({ name, data: method === 0 ? raw : inflateRawSync(raw) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// DOCX → 纯文本。段落断行取 </w:p>，制表取 <w:tab/>，其余标签剥掉。
export function extractDocx(buf) {
  const entries = zipEntries(buf);
  const doc = entries.find((e) => e.name === 'word/document.xml');
  if (!doc) throw new Error('docx 里没有 word/document.xml');
  const xml = doc.data.toString('utf8');
  const text = xml
    .replace(/<w:tab\b[^>]*\/>/g, '\t')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<w:br\b[^>]*\/>/g, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeXmlEntities(text).replace(/\n{3,}/g, '\n\n').trim();
}

// ---- PDF（尽力而为） ----
//
// 策略：扫原始字节里的 stream…endstream 段，能 inflate 的 inflate（FlateDecode），
// 不能的按明文处理；再从内容流里抓 (…)Tj 与 […]TJ 的字面量。
// 已知边界（都是「返回 null 或略差」而非「崩溃」）：加密文档（stream 不可解压）、
// 扫描件（没有文本流）、CID/子集字体（十六进制串映射不出 Unicode，直接跳过）。
function decodePdfLiteral(s) {
  return s
    .replace(/\\([nrtbf()\\])/g, (_, c) =>
      c === 'n' ? '\n' : c === 'r' ? '\r' : c === 't' ? '\t' : c === 'b' || c === 'f' ? '' : c
    )
    .replace(/\\([0-7]{1,3})/g, (_, o) => String.fromCharCode(parseInt(o, 8)));
}

function pdfTextFromContent(content) {
  const parts = [];
  // TJ 数组里的字面量要拼接（同一行被拆成多段），Tj 单个直出。
  const re = /\(((?:\\.|[^\\()])*)\)\s*(Tj|TJ|')|\[((?:[^\]\\]|\\.)*)\]\s*TJ/g;
  let m;
  while ((m = re.exec(content))) {
    if (m[2] === 'TJ') {
      // 数组形态：抓数组里所有 (…) 字面量按序拼接
      const inner = m[1].match(/\(((?:\\.|[^\\()])*)\)/g) || [];
      parts.push(inner.map((x) => decodePdfLiteral(x.slice(1, -1))).join(''));
    } else {
      parts.push(decodePdfLiteral(m[1]));
    }
    // 换行操作符跟在取出的文本后面时补一个断行
    const tail = content.slice(re.lastIndex, re.lastIndex + 24);
    if (/^\s*(?:T\*|TD|Td|ET)/.test(tail)) parts.push('\n');
  }
  return parts.join('');
}

function looksLikeText(s) {
  if (!s) return false;
  const printable = (s.match(/[\x20-\x7e一-鿿　-〿＀-￯\n\t]/g) || []).length;
  return printable / s.length > 0.7 && s.replace(/\s+/g, '').length >= 4;
}

export function extractPdf(buf) {
  const latin = buf.toString('latin1');
  const pieces = [];
  let idx = 0;
  for (;;) {
    const s = latin.indexOf('stream', idx);
    if (s < 0) break;
    // 跳过 endstream（否则 stream 里含 "stream" 字样时会自己匹配自己）
    let dataStart = s + 6;
    if (latin[dataStart] === '\r') dataStart++;
    if (latin[dataStart] === '\n') dataStart++;
    const e = latin.indexOf('endstream', dataStart);
    if (e < 0) break;
    idx = e + 9;
    const raw = buf.slice(dataStart, e);
    let content = null;
    try {
      content = inflateSync(raw).toString('latin1');
    } catch {
      try {
        content = inflateRawSync(raw).toString('latin1');
      } catch {
        content = raw.toString('latin1'); // 未压缩的内容流
      }
    }
    if (!content.includes('Tj') && !content.includes('TJ')) continue;
    const t = pdfTextFromContent(content);
    if (t.trim()) pieces.push(t);
  }
  const text = pieces.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return looksLikeText(text) ? text : null;
}

// 统一入口：按扩展名分发；不认识的类型与提取失败都返回 null（原件已落盘，不挡入库）。
export function extractText(ext, buf) {
  try {
    if (ext === 'docx') return extractDocx(buf) || null;
    if (ext === 'pdf') return extractPdf(buf);
    if (ext === 'txt' || ext === 'md') {
      const s = buf.toString('utf8');
      return looksLikeText(s) ? s : null;
    }
    return null;
  } catch {
    return null;
  }
}

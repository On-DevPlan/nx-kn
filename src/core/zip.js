// 最小 ZIP 编解码（只用 store 与 deflate 两种方法），够知识库迁移用。
//
// 为什么不引依赖：这个项目的 dependencies 只有 5 个必需包，而这里只需要
// 「把一批 .md 打成一个包」这一个子集。更重要的是——**导入是安全敏感路径**：
// 条目名要防路径穿越、解压要有单文件与总量上限、CRC 要逐条校验，这些必须由
// 我们完全控制，不能靠第三方库的默认行为（默认往往是「信任压缩包」）。
//
// 明确**不支持**（遇到就报错，绝不静默读错）：
//   - ZIP64（>4GB 或 >65535 条目）
//   - 加密、分卷
//   - 未知压缩方法（只认 0 = store / 8 = deflate）
// 知识库迁移的量级（几百篇 md、几十 MB）远在限额内。
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { badInput } from './errors/index.js';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

// 通用标志位：bit 11 = 文件名是 UTF-8（中文项目名必须置位，否则解出来是乱码）
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const MAX32 = 0xffffffff;

// 默认上限：单文件 64MB、整包解压总量 512MB。
// 迁移场景里最大的文件也不会超过几 MB，这两个数量级足够宽，又能挡住解压炸弹。
export const DEFAULT_MAX_FILE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

// ---- CRC32（表驱动，多项式 0xEDB88320）----
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

// 导出给调用方（与测试）复用：迁移包里逐文件记录哈希时用它对齐 zip 的校验口径。
export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

// ---- DOS 时间（zip 的时间字段是 2 秒精度、1980 起算）----
function dosDateTime(input) {
  const d = input instanceof Date ? input : new Date(input ?? Date.now());
  const valid = !Number.isNaN(d.getTime());
  const at = valid ? d : new Date();
  const year = Math.max(1980, at.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate(),
    time: (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1),
  };
}

function fromDosDateTime(date, time) {
  const year = (date >> 9) + 1980;
  const month = ((date >> 5) & 0x0f) - 1;
  const day = date & 0x1f;
  const hours = time >> 11;
  const minutes = (time >> 5) & 0x3f;
  const seconds = (time & 0x1f) * 2;
  // 月份/日期非法时退回纪元起点，而不是造出一个 Invalid Date——
  // 迁移时 mtime 只是「参考信息」，不该让整个导入失败。
  if (month < 0 || month > 11 || day < 1 || day > 31) return new Date(1980, 0, 1, 0, 0, 0);
  return new Date(year, month, day, hours, minutes, seconds);
}

/**
 * 条目路径规范化 + 安全校验（写、读两侧共用）。
 *
 * 拒绝四类：绝对路径、盘符、`.`/`..` 段、反斜杠（统一成正斜杠后再判）。
 * 这是防 zip-slip 的唯一关口——**解压端不能依赖调用方先校验**。
 */
export function normalizeEntryName(name) {
  const raw = String(name ?? '');
  if (!raw) throw badInput('zip 条目名为空');
  const s = raw.replace(/\\/g, '/');
  if (s.startsWith('/')) throw badInput(`zip 条目名不能是绝对路径: ${raw}`);
  if (/^[a-zA-Z]:/.test(s)) throw badInput(`zip 条目名不能带盘符: ${raw}`);
  if (s.split('/').some((p) => p === '.' || p === '..')) {
    throw badInput(`zip 条目名不能含 . 或 .. 路径段: ${raw}`);
  }
  return s;
}

/**
 * 打包。entries: [{ name, data: Buffer|string, mtime?: Date|number }]
 *
 * 逐条选择压缩方法：deflate 之后**没有变小**就用 store——md 文本通常能压到
 * 30% 左右，但已经压过的内容（或极短文件）用 deflate 反而更大。
 * 不写目录条目：路径本身带层级，解压端按需 mkdir 即可，少一类条目少一处出错。
 */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = normalizeEntryName(entry?.name);
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
    if (raw.length >= MAX32) throw badInput(`单个文件超过 4GB，不支持 ZIP64: ${name}`);

    const sum = crc32(raw);
    const deflated = deflateRawSync(raw);
    const method = deflated.length < raw.length ? METHOD_DEFLATE : METHOD_STORE;
    const body = method === METHOD_DEFLATE ? deflated : raw;

    const nameBuf = Buffer.from(name, 'utf8');
    const { date, time } = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4); // version needed to extract
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra field length

    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(sum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);

    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + body.length;
  }

  if (centrals.length / 2 > 0xffff) throw badInput('条目数超过 65535，不支持 ZIP64');

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // disk with central dir
  eocd.writeUInt16LE(centrals.length / 2, 8);
  eocd.writeUInt16LE(centrals.length / 2, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralBuf, eocd]);
}

function findEocd(buf) {
  // EOCD 在末尾，后面只可能跟注释（≤65535 字节）
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  throw badInput('不是合法的 zip：找不到中央目录结尾记录（可能不是 zip 文件，或文件被截断）');
}

/**
 * 解包。返回 [{ name, data, mtime }]，**不含目录条目**。
 *
 * 校验顺序刻意是「先结构、再安全、后内容」：结构坏了直接判非 zip；
 * 条目名非法在**解压之前**就拒绝（否则炸弹已经解完了）；最后才逐条 CRC。
 */
export function readZip(
  input,
  { maxFileBytes = DEFAULT_MAX_FILE_BYTES, maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES } = {}
) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  const eocd = findEocd(buf);

  const disk = buf.readUInt16LE(eocd + 4);
  const cdDisk = buf.readUInt16LE(eocd + 6);
  const count = buf.readUInt16LE(eocd + 8);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  if (disk !== 0 || cdDisk !== 0) throw badInput('不支持分卷 zip');
  if (count === 0xffff || cdSize === MAX32 || cdOffset === MAX32) {
    throw badInput('不支持 ZIP64（条目数 ≥65535 或包体 ≥4GB）');
  }
  if (cdOffset + cdSize > buf.length) throw badInput('不是合法的 zip：中央目录超出文件范围');

  const out = [];
  let total = 0;
  let p = cdOffset;

  for (let i = 0; i < count; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw badInput(`不是合法的 zip：第 ${i + 1} 条中央目录记录损坏`);
    }
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const sum = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const rawSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (compSize === MAX32 || rawSize === MAX32) throw badInput(`不支持 ZIP64 条目: ${name}`);
    if (name.endsWith('/')) continue; // 目录条目：路径自带层级，不需要

    const safeName = normalizeEntryName(name);
    if (rawSize > maxFileBytes) {
      throw badInput(`zip 内单个文件超过上限 ${maxFileBytes} 字节: ${safeName}（${rawSize}）`);
    }
    total += rawSize;
    if (total > maxTotalBytes) {
      throw badInput(`zip 解压总量超过上限 ${maxTotalBytes} 字节——已拒绝，避免解压炸弹`);
    }

    if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL_SIG) {
      throw badInput(`不是合法的 zip：${safeName} 的本地头损坏`);
    }
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + localNameLen + localExtraLen;
    const end = start + compSize;
    if (end > buf.length) throw badInput(`不是合法的 zip：${safeName} 的数据超出文件范围`);
    const body = buf.subarray(start, end);

    let data;
    if (method === METHOD_STORE) {
      data = Buffer.from(body);
    } else if (method === METHOD_DEFLATE) {
      try {
        // maxOutputLength 让 zlib 自己守住解压上限（声明的大小可能是假的）
        data = inflateRawSync(body, { maxOutputLength: maxFileBytes });
      } catch (e) {
        throw badInput(`解压失败: ${safeName} —— ${(e && e.message) || e}`);
      }
    } else {
      throw badInput(`不支持的压缩方法 ${method}: ${safeName}（只支持 store / deflate）`);
    }

    if (data.length !== rawSize) {
      throw badInput(`解压后大小与记录不符: ${safeName}（记录 ${rawSize}，实际 ${data.length}）`);
    }
    if (crc32(data) !== sum) throw badInput(`CRC 校验失败（文件内容已损坏）: ${safeName}`);

    out.push({ name: safeName, data, mtime: fromDosDateTime(date, time) });
  }

  return out;
}

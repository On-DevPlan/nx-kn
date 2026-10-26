// core/zip.js：最小 ZIP 编解码。
//
// 这个模块是**安全边界**，不是格式玩具。测试必须钉住三件事：
//   1. 往返无损（含中文名、子目录、空文件、二进制）；
//   2. 恶意/损坏的包被**拒绝**而不是被「尽量解出来」——zip-slip、CRC 不符、
//      截断、解压超限，任何一条放过去都可能写坏用户的 vault；
//   3. 不支持的东西（ZIP64 / 未知压缩方法）明确报错，不静默读错。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { buildZip, readZip, crc32, normalizeEntryName } from '../../src/core/zip.js';

// 手工拼一个「不受 name 校验约束」的 zip：用来构造恶意条目（buildZip 会拒绝它们）
function craftZip({ name, data, method = 0, crc = null, rawSize = null }) {
  const raw = Buffer.from(data);
  const nameBuf = Buffer.from(name, 'utf8');
  const sum = crc === null ? crc32(raw) : crc;
  const body = method === 8 ? deflateRawSync(raw) : raw;

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6);
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0x5021, 12); // date
  local.writeUInt32LE(sum, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(rawSize === null ? raw.length : rawSize, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0x5021, 14);
  central.writeUInt32LE(sum, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(rawSize === null ? raw.length : rawSize, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);

  const cdSize = 46 + nameBuf.length;
  const cdOffset = 30 + nameBuf.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}

test('往返：中文名 / 子目录 / 空文件 / 二进制全部无损', () => {
  const bin = Buffer.from([0, 1, 2, 255, 254, 0, 65]);
  const entries = [
    { name: 'manifest.json', data: '{"a":1}' },
    { name: 'projects/主题系统-总纲.md', data: '---\nbklink: []\n---\n\n# 标题\n' },
    { name: 'projects/nested/deep/note.md', data: '深一层' },
    { name: 'projects/empty.md', data: '' },
    { name: 'projects/blob.bin', data: bin },
  ];

  const zip = buildZip(entries);
  const back = readZip(zip);

  assert.deepEqual(
    back.map((e) => e.name),
    entries.map((e) => e.name),
    '条目顺序与名字必须原样保留（UTF-8 标志位生效，中文不乱码）'
  );
  for (const [i, e] of entries.entries()) {
    const expect = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    assert.deepEqual(back[i].data, expect, `${e.name} 内容不一致`);
  }
  assert.ok(back.every((e) => e.mtime instanceof Date && !Number.isNaN(e.mtime.getTime())));
});

test('压缩生效：重复文本被 deflate 压小（不是原样存进去）', () => {
  const text = '# 标题\n\n重复的正文段落。\n'.repeat(500);
  const zip = buildZip([{ name: 'big.md', data: text }]);
  assert.ok(zip.length < Buffer.byteLength(text) / 5, `zip 应该显著小于原文（实际 ${zip.length}）`);
  assert.equal(readZip(zip)[0].data.toString('utf8'), text);
});

test('空文件走 store（deflate 反而更大时不用它）', () => {
  const zip = buildZip([{ name: 'empty.md', data: '' }]);
  const back = readZip(zip);
  assert.equal(back[0].data.length, 0);
});

test('不是 zip → 报错，不是返回空列表', () => {
  assert.throws(() => readZip(Buffer.from('这只是一段文本，不是压缩包')), /找不到中央目录结尾记录/);
});

test('被截断的 zip → 报错', () => {
  const zip = buildZip([{ name: 'a.md', data: 'hello' }]);
  assert.throws(() => readZip(zip.subarray(0, zip.length - 10)), /找不到中央目录结尾记录/);
});

test('zip-slip：条目名带 .. 一律拒绝（写侧与读侧都拦）', () => {
  // 写侧：buildZip 直接拒绝
  assert.throws(() => buildZip([{ name: '../evil.md', data: 'x' }]), /不能含 \. 或 \.\./);
  // 读侧：手工构造的恶意包也拒绝
  assert.throws(() => readZip(craftZip({ name: '../../etc/passwd', data: 'x' })), /不能含 \. 或 \.\./);
  assert.throws(() => readZip(craftZip({ name: '/abs/evil.md', data: 'x' })), /绝对路径/);
  assert.throws(() => readZip(craftZip({ name: 'C:/evil.md', data: 'x' })), /盘符/);
});

test('normalizeEntryName：反斜杠统一成正斜杠', () => {
  assert.equal(normalizeEntryName('projects\\a\\b.md'), 'projects/a/b.md');
});

test('CRC 不符 → 报错（内容被改过/传输损坏）', () => {
  const good = buildZip([{ name: 'a.md', data: '正确内容' }]);
  // 找到 deflate 数据段并翻一个字节
  const broken = Buffer.from(good);
  broken[35] = broken[35] ^ 0xff; // 本地头 30 + 名字 4 = 34，35 落在数据段
  assert.throws(() => readZip(broken), /CRC 校验失败|解压失败|大小与记录不符/);
});

test('未知压缩方法 → 明确报错（不静默返回空内容）', () => {
  const zip = craftZip({ name: 'a.md', data: 'x', method: 99 });
  assert.throws(() => readZip(zip), /不支持的压缩方法 99/);
});

test('解压上限：单文件超限直接拒绝（防解压炸弹）', () => {
  const zip = buildZip([{ name: 'big.md', data: 'x'.repeat(5000) }]);
  assert.throws(() => readZip(zip, { maxFileBytes: 100 }), /超过上限/);
});

test('解压上限：总量超限直接拒绝', () => {
  const zip = buildZip([
    { name: 'a.md', data: 'x'.repeat(400) },
    { name: 'b.md', data: 'x'.repeat(400) },
  ]);
  assert.throws(() => readZip(zip, { maxTotalBytes: 500 }), /解压总量超过上限/);
});

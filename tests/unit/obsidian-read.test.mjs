// obsidian read：「内容获取走指令」的回归闸门。
//
// read 是 skill 内容获取的唯一入口（替代 agent 直接 Read/Grep），错在两处最伤：
//   1. 行号 clamp——把 agent 算错的行号变成「读到了」的假象
//   2. 解码链换掉——GBK/BOM 文件读出乱码，而 scan 那边说的是正常文本（口径分叉）
// 所以这两条各有一根钉子。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-obsidian-read-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function fakeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-read-'));
  mkdirSync(join(dir, '.obsidian'));
  return dir;
}

// 多行样例：10 行正文（第 3 行含双链，模拟 scan 报来的位置）。
function sampleNote(vault, rel) {
  const lines = [];
  for (let i = 1; i <= 10; i += 1) lines.push(`第${i}行` + (i === 3 ? ' [[未解析链接]]' : ''));
  const abs = join(vault, ...rel.split('/'));
  mkdirSync(abs.slice(0, abs.lastIndexOf('\\')), { recursive: true });
  writeFileSync(abs, lines.join('\n') + '\n', 'utf8');
  return lines;
}

test('read: vault 未设置是业务结果（configured:false），不是错误', async () => {
  tmpData();
  const r = await obsidian.read({ file: '日常/foo.md' });
  assert.equal(r.configured, false);
  assert.ok(Array.isArray(r.hints) && r.hints.length > 0);
});

test('read: 全文读取——行号 1 起、total 与文件行数一致、行文本原样', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  const lines = sampleNote(vault, '日常/foo.md');
  const r = await obsidian.read({ file: '日常/foo.md' });
  assert.equal(r.configured, true);
  assert.equal(r.file, '日常/foo.md');
  assert.equal(r.total, lines.length + 1, '末尾换行算多一个空行（与 split 口径一致）');
  assert.equal(r.from, 1);
  assert.equal(r.to, r.total);
  assert.equal(r.lines[2].n, 3);
  assert.equal(r.lines[2].text, lines[2], '第 3 行（含双链）逐字一致——scan/read 同口径');
});

test('read: --from/--to 区间切片含端点，n 从 from 续起', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  sampleNote(vault, '日常/foo.md');
  const r = await obsidian.read({ file: '日常/foo.md', from: 2, to: 4 });
  assert.deepEqual(
    r.lines.map((l) => l.n),
    [2, 3, 4]
  );
  assert.equal(r.lines[1].text, '第3行 [[未解析链接]]');
});

test('read: 文件不存在报 NOT_FOUND 且**回显原路径**（便于 agent 对出笔误）', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  await assert.rejects(
    () => obsidian.read({ file: '日常/没有这篇.md' }),
    (err) => err.code === 'NOT_FOUND' && err.message.includes('日常/没有这篇.md')
  );
});

test('read: 绝对路径与 .. 被拒（不许借 read 探出 vault 外的文件）', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  for (const bad of ['C:\\Windows\\win.ini', '../outside.md', '日常/../../x.md']) {
    await assert.rejects(
      () => obsidian.read({ file: bad }),
      (err) => err.code === 'INVALID_INPUT',
      `应拒绝: ${bad}`
    );
  }
});

test('read: 行号非法是报错**不是 clamp**——越界/非整数/区间反了都如实报', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  sampleNote(vault, '日常/foo.md');
  await assert.rejects(() => obsidian.read({ file: '日常/foo.md', from: 0 }), { code: 'INVALID_INPUT' });
  await assert.rejects(() => obsidian.read({ file: '日常/foo.md', from: 3.5 }), { code: 'INVALID_INPUT' });
  await assert.rejects(
    () => obsidian.read({ file: '日常/foo.md', to: 999 }),
    (err) => err.code === 'INVALID_INPUT' && err.message.includes('共 11 行')
  );
  await assert.rejects(() => obsidian.read({ file: '日常/foo.md', from: 5, to: 2 }), {
    code: 'INVALID_INPUT',
  });
});

test('read: GBK 文件读出的是正常文本（解码链与 scan 同一条，不许在 read 这里分叉）', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  // 「第1行 [[测试]]」的 GBK 编码（Node 无 gbk 编码器，手工给字节）。
  const iconv = Buffer.from([
    0xb5, 0xda, 0x31, 0xd0, 0xd0, 0x20, 0x5b, 0x5b, 0xb2, 0xe2, 0xca, 0xd4, 0x5d, 0x5d,
  ]);
  writeFileSync(join(vault, 'gbk.md'), iconv, 'binary');
  const r = await obsidian.read({ file: 'gbk.md' });
  assert.equal(r.lines[0].text, '第1行 [[测试]]');
});

test('read: file 缺失 / 空串直接报用法', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  await assert.rejects(() => obsidian.read({}), { code: 'INVALID_INPUT' });
  await assert.rejects(() => obsidian.read({ file: '' }), { code: 'INVALID_INPUT' });
});

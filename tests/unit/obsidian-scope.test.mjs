// obsidian 域：scan / check 的**项目范围**（多项目并发时的隔离边界）。
//
// 隔离的形状：
//   - 哪些文件里的链接会被收集 → 只看 projects/<项目名>/
//   - 链接能否解析             → 仍对照全库（否则链到共享笔记会被误报成红链，
//                                agent 就会跑去重复建一份——那才是破坏隔离的地方）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-scope-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function fakeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-scope-vault-'));
  mkdirSync(join(dir, '.obsidian'));
  return dir;
}

function fakeProject(name) {
  const dir = mkdtempSync(join(tmpdir(), `nx-kn-${name}-`));
  writeFileSync(join(dir, 'package.json'), `{ "name": "${name}" }\n`, 'utf8');
  return dir;
}

function write(vault, rel, content) {
  const p = join(vault, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content, 'utf8');
}

// 一个装好两个项目的库
async function setup() {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const alpha = fakeProject('alpha');
  const beta = fakeProject('beta');
  write(vault, 'projects/alpha/a.md', 'A 的红链 [[只剩A缺]]\n链到共享笔记 [[共享笔记]]\n');
  write(vault, 'projects/beta/b.md', 'B 的红链 [[只剩B缺]]\n');
  write(vault, '共享笔记.md', '# 共享\n');
  write(vault, '日常/杂项.md', '不在任何项目里的红链 [[全局缺]]\n');
  return { vault, alpha, beta };
}

test('scan 不带 --project：扫全库', async () => {
  await setup();
  const r = await obsidian.scan({});
  assert.equal(r.scope, null);
  assert.equal(r.count, 3);
  assert.deepEqual(r.links.map((x) => x.link).sort(), ['只剩A缺', '只剩B缺', '全局缺'].sort());
});

test('scan --project：只看自己项目目录下的红链（多项目互不干扰）', async () => {
  const { alpha, beta } = await setup();

  const a = await obsidian.scan({ project: alpha });
  assert.equal(a.scope, 'projects/alpha');
  assert.equal(a.count, 1);
  assert.equal(a.links[0].link, '只剩A缺');
  assert.equal(a.links[0].sources[0].file, 'projects/alpha/a.md');

  const b = await obsidian.scan({ project: beta });
  assert.equal(b.scope, 'projects/beta');
  assert.equal(b.count, 1);
  assert.equal(b.links[0].link, '只剩B缺');
});

test('scan --project：链到项目外的笔记不算红链（解析对照全库）', async () => {
  const { alpha } = await setup();
  const r = await obsidian.scan({ project: alpha });
  assert.ok(!r.links.some((x) => x.link === '共享笔记'), '共享笔记能解析，不该报红链');
  assert.ok(!r.links.some((x) => x.link === '全局缺'), '别的目录里的红链不在范围内');
});

test('scan --project：项目目录还没初始化时如实提示（不报错）', async () => {
  await setup();
  const ghost = fakeProject('gamma');
  const r = await obsidian.scan({ project: ghost });
  assert.equal(r.count, 0);
  assert.equal(r.scopeExists, false);
  assert.ok(r.hints.some((h) => h.includes('还没初始化')));
});

test('check --project：只 check 自己项目目录下的红链', async () => {
  const { vault, alpha } = await setup();

  await obsidian.check({ snapshot: 'snap.json', project: alpha });
  // 项目外新写一篇带红链的笔记 —— 不该被算进本项目的差分
  write(vault, 'projects/beta/new.md', 'B 的新红链 [[B新缺]]\n');
  // 本项目内新写一篇带红链的笔记 —— 该被算进来
  write(vault, 'projects/alpha/new.md', 'A 的新红链 [[A新缺]]\n');

  const diff = await obsidian.check({ snapshotBefore: 'snap.json', newFile: 'projects/alpha/new.md', project: alpha });
  assert.equal(diff.passed, false);
  assert.deepEqual(diff.newUnresolved.map((x) => x.link), ['A新缺'], '只报本项目的红链');
});

test('scan --project：项目目录不存在时报错（不静默扫全库）', async () => {
  await setup();
  const missing = join(tmpdir(), 'nx-kn-no-such-project-scope');
  await assert.rejects(() => obsidian.scan({ project: missing }), /项目目录不存在/);
});

// hasIndex 的单测：**「建过索引」的判据必须比「目录存在」更严**。
//
// 为什么值得单独钉住：这个函数的返回值决定两件事——
//   1. status/list 上显示「已建」还是「未建 —— 跑 nx-kn index」
//   2. query 时该库算不算 usable（不算就进 skipped[]）
// 判据太松（只看 `.zvec-grep` 在不在）时，一个「建到一半失败」留下的空壳目录
// 会被当成可用的索引：query 失败 → 该库进 skipped[] → hits 为空 →
// CLI 渲染成「（无命中）」。用户读到的意思是「库里没这内容」，
// 而真相是「索引坏了，重建一次就好」——两件事，必须区分开。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INDEX_DIR, hasIndex, indexDirOf } from '../../src/core/zg.js';

function freshDir() {
  const root = mkdtempSync(join(tmpdir(), 'nx-kn-idx-'));
  mkdirSync(join(root, 'notes'), { recursive: true });
  return root;
}

// 照本机 zg 0.2.2 实测的形状造一份索引目录：
// manifest.json + files.zvec/（另有 index.zvec/、locks/、*.sst，这里不必全造）
function writeIndex(root) {
  const dir = indexDirOf(root);
  mkdirSync(join(dir, 'files.zvec'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{"version":1}\n', 'utf8');
  return dir;
}

test('indexDirOf：索引目录就是 <root>/.zvec-grep（由 zg 拥有，我们只判断）', () => {
  assert.equal(INDEX_DIR, '.zvec-grep');
  assert.equal(indexDirOf('/tmp/x'), join('/tmp/x', '.zvec-grep'));
});

test('没建过索引（目录不存在 / .zvec-grep 不存在）→ false', () => {
  const root = freshDir();
  assert.equal(hasIndex(root), false);
  assert.equal(hasIndex(join(root, '根本没有这个目录')), false, '不存在的根不该抛，只回 false');
});

test('⚠️ 空壳 .zvec-grep（建到一半失败）→ false，不能当成可用索引', () => {
  const root = freshDir();
  mkdirSync(indexDirOf(root), { recursive: true });
  assert.equal(hasIndex(root), false, '目录在 ≠ 索引可用');
});

test('只有 manifest.json、没有 files.zvec（半成品）→ false', () => {
  const root = freshDir();
  const dir = indexDirOf(root);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '{"version":1}\n', 'utf8');
  assert.equal(hasIndex(root), false, '数据目录不在，说明初始化没走完');
});

test('manifest.json 是空文件 → false（截断的清单不算数）', () => {
  const root = freshDir();
  const dir = indexDirOf(root);
  mkdirSync(join(dir, 'files.zvec'), { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), '', 'utf8');
  assert.equal(hasIndex(root), false);
});

test('manifest.json 存在且非空 + files.zvec 在 → true', () => {
  const root = freshDir();
  writeIndex(root);
  assert.equal(hasIndex(root), true);
});

test('manifest.json 被换成同名目录 → false（不抛）', () => {
  const root = freshDir();
  mkdirSync(join(indexDirOf(root), 'manifest.json'), { recursive: true });
  mkdirSync(join(indexDirOf(root), 'files.zvec'), { recursive: true });
  assert.equal(hasIndex(root), false);
});

test('有笔记但没有索引时仍为 false（判据只看索引，不看内容）', () => {
  const root = freshDir();
  writeFileSync(join(root, 'notes', 'a.md'), '# 笔记\n', 'utf8');
  assert.equal(hasIndex(root), false);
});

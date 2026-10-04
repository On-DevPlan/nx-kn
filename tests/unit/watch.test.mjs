// core/watch.js 的单测：过滤判定 + 事件合并。
//
// 这两件都是**纯逻辑**，也正是守护唯一容易出错的地方：
// 过滤漏了 → 索引自己写盘触发自己（回环），或者 Obsidian 每敲一个键就重建索引；
// 合并漏了 → 一次编辑触发好几次 zg 子进程。所以它们必须有测试钉住，
// 而「监听到底跑没跑起来」交给流水线里的真实守护测试（tests/pipeline.mjs P14）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  WATCH_ANY,
  WATCH_IGNORED_DIRS,
  createBatcher,
  shouldWatchRelPath,
  watchTree,
} from '../../src/core/watch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 路径过滤 ----

test('只认 markdown：其它扩展名与「看着像 md」的都不算', () => {
  assert.equal(shouldWatchRelPath('a.md'), true);
  assert.equal(shouldWatchRelPath('notes/子目录/a.md'), true);
  assert.equal(shouldWatchRelPath('A.MD'), true, '大小写不敏感');

  assert.equal(shouldWatchRelPath('a.txt'), false);
  assert.equal(shouldWatchRelPath('a.md.bak'), false, '备份文件不是笔记');
  assert.equal(shouldWatchRelPath('a'), false);
  assert.equal(shouldWatchRelPath('a.md.tmp'), false, '编辑器临时文件');
});

test('隐藏目录整棵不看（.obsidian / .trash / .git / 任意 .xxx）', () => {
  // 本机 .obsidian 里有 325 篇 md（占全部 md 的 59%），Obsidian 每次切笔记都在写——
  // 漏了这条，光是打开 Obsidian 就会把索引重建一遍。
  assert.equal(shouldWatchRelPath('.obsidian/workspace.json'), false);
  assert.equal(shouldWatchRelPath('.obsidian/plugins/x.md'), false);
  assert.equal(shouldWatchRelPath('.trash/old.md'), false);
  assert.equal(shouldWatchRelPath('.git/objects/ab/cdef'), false);
  assert.equal(shouldWatchRelPath('sub/.hidden/deep.md'), false, '任意隐藏目录都不看');
});

test('zg 的索引目录不看（否则索引写盘 → 触发 → 再索引，形成回环）', () => {
  assert.equal(shouldWatchRelPath('.zvec-grep/files.zvec'), false);
  assert.equal(shouldWatchRelPath('.zvec-grep/nested/anything.md'), false);
  assert.ok(WATCH_IGNORED_DIRS.includes('.zvec-grep'), '索引目录必须在显式名单里');
  assert.ok(WATCH_IGNORED_DIRS.includes('.obsidian'));
  assert.ok(WATCH_IGNORED_DIRS.includes('.trash'));
});

test('隐藏文件名不看；Windows 反斜杠路径同样判定', () => {
  assert.equal(shouldWatchRelPath('.draft.md'), false, '以点开头的文件是编辑器/系统的临时产物');
  // fs.watch 在 Windows 上给的是反斜杠路径，不能只按 '/' 切
  assert.equal(shouldWatchRelPath('notes\\a.md'), true);
  assert.equal(shouldWatchRelPath('.obsidian\\x.md'), false);
  assert.equal(shouldWatchRelPath('guide\\api\\ref.md'), true);
});

test('空值 / 得到名字 → 一律不看（交给 watchTree 的保守分支处理）', () => {
  assert.equal(shouldWatchRelPath(''), false);
  assert.equal(shouldWatchRelPath(null), false);
  assert.equal(shouldWatchRelPath(undefined), false);
  assert.equal(shouldWatchRelPath('./'), false);
});

// ---- 事件合并 ----

test('createBatcher：窗口内的多次变化合并成一批、并去重', async () => {
  const batches = [];
  const b = createBatcher({ delayMs: 40, onFlush: (files) => batches.push(files) });

  b.push('a.md');
  b.push('b.md');
  b.push('a.md'); // 同一条重复到达（一次保存会连发多个事件）
  assert.equal(b.pendingCount(), 2, '重复的应被去重');
  assert.equal(batches.length, 0, '窗口没到点，不该结算');

  await sleep(90);
  assert.equal(batches.length, 1, '一批只回调一次');
  assert.deepEqual(batches[0].sort(), ['a.md', 'b.md']);
});

test('createBatcher：新事件重置窗口（以最后一次变化为起点）', async () => {
  const batches = [];
  const b = createBatcher({ delayMs: 60, onFlush: (f) => batches.push(f) });

  b.push('a.md');
  await sleep(40);
  b.push('b.md'); // 窗口应从这里重新计时
  await sleep(40);
  assert.equal(batches.length, 0, '还没到「最后一次变化 + delayMs」');
  await sleep(60);
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].sort(), ['a.md', 'b.md']);
});

test('createBatcher：flushNow 立即结算；dispose 之后不再回调', async () => {
  const batches = [];
  const b = createBatcher({ delayMs: 10_000, onFlush: (f) => batches.push(f) });

  b.push('a.md');
  b.flushNow();
  assert.deepEqual(batches, [['a.md']], 'flushNow 不等窗口');
  assert.equal(b.pendingCount(), 0);

  b.push('b.md');
  b.dispose();
  await sleep(20);
  assert.equal(batches.length, 1, 'dispose 后不该再有回调');
});

// ---- fs.watch 封装 ----

test('watchTree：无关事件被挡在合并之前，只回调可关心的变化', async () => {
  let handler = null;
  const impl = () => ({
    close() {
      handler = null;
    },
  });
  // 注入一个假的 fs.watch：把回调抓出来手动触发，不碰真实文件系统
  const fakeWatch = (_dir, _opts, cb) => {
    handler = cb;
    return impl();
  };

  const got = [];
  const h = watchTree('/not/real', { delayMs: 20, onBatch: (f) => got.push(f), watchImpl: fakeWatch });

  handler('change', 'notes/a.md'); // 唯一值得响应的
  handler('change', '.obsidian/workspace.json');
  handler('change', '.obsidian/notes-in-vault/x.md');
  handler('change', '.zvec-grep/files.zvec');
  handler('change', 'README.txt');
  handler('change', 'notes/b.md');

  await sleep(60);
  assert.equal(got.length, 1, '一批只回调一次');
  assert.deepEqual(got[0].sort(), ['notes/a.md', 'notes/b.md'], '无关路径必须被挡掉');

  h.close();
  assert.equal(handler, null, 'close 之后不该还挂着回调');
});

test('watchTree：拿不到文件名时保守触发一次（宁可多重索引，不可漏改动）', async () => {
  let handler = null;
  const fakeWatch = (_dir, _opts, cb) => {
    handler = cb;
    return { close() {} };
  };
  const got = [];
  const h = watchTree('/not/real', { delayMs: 20, onBatch: (f) => got.push(f), watchImpl: fakeWatch });

  handler('change', null); // 个别平台/事件会给 null
  await sleep(60);
  assert.equal(got.length, 1, '拿不到名字时应当保守触发');
  assert.deepEqual(got[0], [WATCH_ANY]);
  h.close();
});

test('watchTree：监听起不来时返回 error 而不是抛（交给上层展示）', () => {
  const boom = () => {
    throw new Error('ENOSPC: inotify watch limit reached');
  };
  const h = watchTree('/not/real', { delayMs: 10, onBatch: () => {}, watchImpl: boom });
  assert.ok(h.error, '应把错误带回来');
  assert.match(String(h.error.message), /inotify/);
  h.close(); // 即使起不来，close 也必须可调用（上层会无脑调）
});

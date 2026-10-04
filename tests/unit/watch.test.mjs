// core/watch.js 的单测：过滤判定 + 事件合并 + 逐目录监听。
//
// 这三件都是**纯逻辑**，也正是守护唯一容易出错的地方：
// 过滤漏了 → 索引自己写盘触发自己（回环），或者 Obsidian 每敲一个键就重建索引；
// 合并漏了 → 一次编辑触发好几次 zg 子进程；
// 监听方式错了 → Linux 上递归 watch 会走进 `.zvec-grep/` 并因 ENOENT 把守护进程崩掉
//   （真实事故，见 file 头注释）。所以「哪些目录会被挂 watcher」「watcher 出错会不会
//   掀翻进程」必须在这里钉死 —— 那个 ENOENT 是竞态、没法稳定复现，测「排除」比测「崩溃」可靠。
// 「监听真的跑起来了吗」交给流水线里的真实守护测试（tests/pipeline.mjs P14）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import {
  WATCH_ANY,
  WATCH_IGNORED_DIRS,
  createBatcher,
  shouldSkipDirName,
  shouldWatchRelPath,
  watchTree,
} from '../../src/core/watch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- 假文件系统（不碰真实磁盘）----
//
// dirs: { 绝对路径: [条目...] }，条目为 '文件名'（文件）或 { dir: '子目录名' }。
// 目录**不在表里**就当作不存在（readdir 抛 ENOENT）—— 这样如果 watchTree 误闯
// `.zvec-grep/` 之类的排除目录，就会立刻报错，测试能抓住。
const ROOT = resolve('/vault');
const at = (...p) => join(ROOT, ...p);

function makeFakeFs(dirs) {
  const opened = []; // 挂过 watcher 的顺序（含重复挂）
  const live = new Map(); // abs -> FakeWatcher

  const readdirImpl = (abs) => {
    const entries = dirs[abs];
    if (!entries) {
      const e = new Error(`ENOENT: no such file or directory, scandir '${abs}'`);
      e.code = 'ENOENT';
      throw e;
    }
    return entries.map((it) => {
      const isDir = typeof it !== 'string';
      return {
        name: isDir ? it.dir : it,
        isDirectory: () => isDir,
        isFile: () => !isDir,
        isSymbolicLink: () => false,
      };
    });
  };

  const watchImpl = (abs, opts, cb) => {
    const w = new EventEmitter();
    w.cb = cb;
    w.opts = opts;
    w.closed = false;
    w.close = () => {
      w.closed = true;
    };
    live.set(abs, w);
    opened.push(abs);
    return w;
  };

  return {
    dirs,
    readdirImpl,
    watchImpl,
    opened,
    fire: (abs, type, name) => live.get(abs)?.cb(type, name),
    fail: (abs, err) => live.get(abs)?.emit('error', err),
    live: (abs) => live.get(abs),
    closed: (abs) => live.get(abs)?.closed === true,
  };
}

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

// ---- 目录级排除（决定「哪些目录会被挂 watcher」）----

test('shouldSkipDirName：隐藏目录与显式名单整棵不下钻', () => {
  // 这条是 Linux 崩溃事故的第一道闸：被跳过的目录**不会**被 readdir、不会被挂 watcher，
  // 于是索引重建 `.zvec-grep/` 时那串 ENOENT 根本没有机会发生。
  assert.equal(shouldSkipDirName('.zvec-grep'), true, '索引目录：进去就会自激 + 崩');
  assert.equal(shouldSkipDirName('.obsidian'), true);
  assert.equal(shouldSkipDirName('.trash'), true);
  assert.equal(shouldSkipDirName('.git'), true);
  assert.equal(shouldSkipDirName('.any-hidden'), true, '任意隐藏目录都不下钻');

  assert.equal(shouldSkipDirName('notes'), false);
  assert.equal(shouldSkipDirName('Base-面试'), false, '名字里有点不算隐藏');
  assert.equal(shouldSkipDirName('a.md'), false, '文件名不是目录名，这里不做扩展名判断');
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

// ---- 逐目录监听（watchTree 的实现方式）----

test('watchTree：只给非排除目录挂 watcher —— .zvec-grep/.obsidian 根本不进监听范围', () => {
  // 真实事故的回归闸门：Linux 上 fs.watch({recursive:true}) 会自己 readdir 整棵树，
  // 走进 `.zvec-grep/` 撞上索引重建的 RocksDB 分片段目录 → ENOENT → 进程崩。
  // 现在改成逐目录监听 + 跳过排除目录，**排除目录连读都不该被读到**。
  // 下面故意不把这些目录登记进假 fs：只要 watchTree 试图 readdir 它们，就会报 ENOENT。
  const bad = ['.obsidian', '.zvec-grep', '.trash', '.git'];
  const fs = makeFakeFs({
    [ROOT]: [{ dir: 'notes' }, ...bad.map((d) => ({ dir: d })), 'a.md'],
    [at('notes')]: [{ dir: 'deep' }, 'n.md'],
    [at('notes', 'deep')]: ['d.md'],
  });

  const errs = [];
  const h = watchTree(ROOT, {
    delayMs: 10,
    onBatch: () => {},
    onError: (e) => errs.push(e),
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
  });

  assert.deepEqual(h.dirs(), [ROOT, at('notes'), at('notes', 'deep')].sort(), '只挂真实笔记目录');
  for (const d of bad) {
    assert.ok(!h.dirs().includes(at(d)), `${d} 绝不能被监听`);
  }
  assert.equal(errs.length, 0, '排除目录连 readdir 都不该发生');
  assert.equal(fs.live(at('notes')).opts.recursive, false, '必须是非递归 watcher');
  h.close();
});

test('watchTree：无关事件被挡在合并之前，只回调可关心的变化', async () => {
  const fs = makeFakeFs({
    [ROOT]: [{ dir: 'notes' }, { dir: '.obsidian' }, { dir: '.zvec-grep' }],
    [at('notes')]: [],
  });
  const got = [];
  const h = watchTree(ROOT, {
    delayMs: 20,
    onBatch: (f) => got.push(f),
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 5,
  });

  fs.fire(ROOT, 'change', 'a.md'); // 根目录的笔记
  fs.fire(at('notes'), 'change', 'b.md'); // 子目录的笔记（每个目录各自的 watcher 都能上报）
  fs.fire(at('notes'), 'change', 'skip.txt');
  fs.fire(ROOT, 'change', 'x.md.tmp');

  await sleep(70);
  assert.equal(got.length, 1, '一批只回调一次');
  // 注意：上报的是**平台原生分隔符**（Windows 上是 `notes\b.md`），所以用 join 拼期望值
  assert.deepEqual(got[0].sort(), ['a.md', join('notes', 'b.md')].sort(), '无关路径必须被挡掉');
  h.close();
});

test('watchTree：拿不到文件名时保守触发一次（宁可多重索引，不可漏改动）', async () => {
  const fs = makeFakeFs({ [ROOT]: [] });
  const got = [];
  const h = watchTree(ROOT, {
    delayMs: 20,
    onBatch: (f) => got.push(f),
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 5,
  });

  fs.fire(ROOT, 'change', null);
  await sleep(70);
  assert.equal(got.length, 1, '拿不到名字时应当保守触发');
  assert.deepEqual(got[0], [WATCH_ANY]);
  h.close();
});

test('watchTree：watcher 异步 error 不抛（不掀翻进程），报告后重挂自愈', async () => {
  // 事故现场就是这条：ENOENT 以 FSWatcher 的异步 'error' 事件抛出，
  // 没人监听 → Unhandled 'error' event → 守护进程当场退出。
  const fs = makeFakeFs({ [ROOT]: [{ dir: 'notes' }], [at('notes')]: [] });
  const errs = [];
  const h = watchTree(ROOT, {
    delayMs: 10,
    onBatch: () => {},
    onError: (e) => errs.push(e),
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 10,
  });

  const boom = Object.assign(new Error("ENOENT: no such file or directory, scandir '…/index.zvec/3'"), {
    code: 'ENOENT',
  });

  // emit('error') 在**没有监听者**时是直接 throw 的 —— 所以这一句本身就是回归断言
  assert.doesNotThrow(() => fs.fail(at('notes'), boom), '不能变成 Unhandled error');
  assert.equal(errs.length, 1, '应报告一次');
  assert.equal(errs[0].dir, at('notes'));
  assert.equal(fs.closed(at('notes')), true, '出错的 watcher 应被摘掉');

  await sleep(50); // 等重扫把它挂回来
  assert.ok(h.dirs().includes(at('notes')), '重扫应重新挂上');
  assert.equal(fs.live(at('notes')).closed, false, '重挂的 watcher 是活的');
  h.close();
});

test('watchTree：同一目录持续出错不刷屏（恢复后才允许再报）', () => {
  const fs = makeFakeFs({ [ROOT]: [{ dir: 'notes' }], [at('notes')]: [] });
  const errs = [];
  const h = watchTree(ROOT, {
    delayMs: 10,
    onBatch: () => {},
    onError: (e) => errs.push(e),
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 5,
  });
  const boom = () => fs.fail(at('notes'), new Error('EACCES: permission denied'));

  boom();
  boom();
  boom();
  assert.equal(errs.length, 1, '同一目录只报一次');
  h.close();
});

test('watchTree：目录新增会被挂上、删除会被摘掉（rename 触发重扫）', async () => {
  const dirs = { [ROOT]: [{ dir: 'notes' }], [at('notes')]: [] };
  const fs = makeFakeFs(dirs);
  const h = watchTree(ROOT, {
    delayMs: 10,
    onBatch: () => {},
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 10,
  });
  assert.deepEqual(h.dirs(), [ROOT, at('notes')].sort());

  // 新建一个子目录
  dirs[ROOT] = [{ dir: 'notes' }, { dir: 'inbox' }];
  dirs[at('inbox')] = [];
  fs.fire(ROOT, 'rename', 'inbox');
  await sleep(50);
  assert.ok(h.dirs().includes(at('inbox')), '新目录应被挂上');

  // 删掉它
  delete dirs[at('inbox')];
  dirs[ROOT] = [{ dir: 'notes' }];
  fs.fire(ROOT, 'rename', 'inbox');
  await sleep(50);
  assert.ok(!h.dirs().includes(at('inbox')), '消失的目录应被摘掉');
  h.close();
});

test('watchTree：监听起不来时返回 error 而不是抛（交给上层展示）', () => {
  const boom = () => {
    throw new Error('ENOSPC: inotify watch limit reached');
  };
  const fs = makeFakeFs({ [ROOT]: [] });
  const h = watchTree(ROOT, {
    delayMs: 10,
    onBatch: () => {},
    watchImpl: boom,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 5,
  });
  assert.ok(h.error, '应把错误带回来');
  assert.match(String(h.error.message), /inotify/);
  h.close(); // 即使起不来，close 也必须可调用（上层会无脑调）
});

test('watchTree：close 摘掉全部 watcher，不留句柄', () => {
  const fs = makeFakeFs({ [ROOT]: [{ dir: 'notes' }, 'a.md'], [at('notes')]: ['n.md'] });
  const h = watchTree(ROOT, {
    delayMs: 10,
    onBatch: () => {},
    watchImpl: fs.watchImpl,
    readdirImpl: fs.readdirImpl,
    rescanDelayMs: 5,
  });
  const before = h.dirs();
  assert.ok(before.length >= 2, '先确认真的挂上了几个');

  h.close();
  assert.deepEqual(h.dirs(), [], '关掉后不该还留着');
  for (const abs of before) assert.equal(fs.closed(abs), true, `${abs} 应被 close`);
});

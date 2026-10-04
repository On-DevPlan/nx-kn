// 文件监听基元：路径过滤 + 事件合并（防抖）+ fs.watch 封装。
//
// 分层位置：core（零业务语义）。这里只回答三件事——
//   1. 哪些变化算「值得看一眼的变化」（shouldWatchRelPath）
//   2. 一串密集事件怎么并成一批（createBatcher）
//   3. 怎么把 fs.watch 包成「一批变化回调一次」（watchTree）
// 「哪个库、用什么模型、索引怎么建」属于业务，在 modules/kb/watch.js。
//
// ---- 为什么过滤是必需品，不是优化 ----
//
// 监听一棵 vault，最吵的三类都不是「笔记」：
//   1. `.obsidian/`——Obsidian 每次切笔记、改配置、装插件都在写。本机实测该目录
//      里有 325 篇 md（占全部 md 的 59%）。不管它，光是打开 Obsidian 就会触发索引。
//   2. `.trash/`——删一篇笔记就动一次，不该因为它重建索引。
//   3. `.zvec-grep/`——**我们自己**的索引目录。zg 建索引时会往里写文件，
//      不过滤就会形成回环：索引写盘 → 事件 → 再索引 → 再写盘。
//
// 前两类是「噪声」，第三类是「自激」。只做防抖挡不住它们（防抖只合并密集事件，
// 不改变「该不该响应」），所以要在事件入口过滤（shouldWatchRelPath）。
//
// ---- 但「只在事件入口过滤」在 Linux 上不够：会崩（实测踩过）----
//
// `fs.watch(dir, { recursive: true })` 在 Linux 是**用户态实现**
// （`node:internal/fs/recursive_watch` 自己 readdirSync 遍历整棵树）。
// 也就是说，即便我们丢掉了 `.zvec-grep/` 的事件，**Node 自己仍然会走进那个目录**。
// 而那里恰恰是索引时不断重建 RocksDB 分片段目录的地方——父目录 readdir 与子目录
// readdir 之间目录被换掉，就抛 ENOENT：
//
//   Error: ENOENT: no such file or directory, scandir '.../index.zvec/3/scalar.index.1.rocksdb'
//       at readdirSync (node:fs:1590:26)
//       at #watchFolder (node:internal/fs/recursive_watch:111:21)
//
// 更糟的是它以 FSWatcher 的**异步 'error' 事件**抛出，try/catch 包不住同步调用 ——
// 于是变成 Unhandled 'error' event，**守护进程当场崩掉**（表现是 `nx-kn watch` 悄悄退出、
// 或 serve 的守护没了，而索引 churn 正是守护自己触发索引造成的，属于自毁回环）。
// macOS 的 recursive 是原生 FSEvents、不走这条 scandir 路径，**所以在 macOS 上试不出来**。
//
// 因此 watchTree **不再用 recursive**，改成「自己递归 + 每个目录一个非递归 watcher」：
// 排除目录**根本不进监听范围**，从根上既没有回环、也没有那条会崩的 scandir 路径，
// 顺带让 Linux / macOS / Windows 三平台行为一致。
import { watch as fsWatch, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { VAULT_EXCLUDES } from './paths.js';
import { INDEX_DIR } from './zg.js';

// 目录段一旦命中就整棵不看。刻意复用 kb 域的排除名单与 zg 的索引目录名，
// 而不是各写一份——两处名单一旦漂移，就会出现「索引排除它、守护却盯着它」。
export const WATCH_IGNORED_DIRS = [...VAULT_EXCLUDES, INDEX_DIR];

const MD_RE = /\.md$/i;

// 相对路径是否值得响应。规则：
//   * 必须是 `.md`（zg 侧我们也固定 `-t md`，两边口径一致）
//   * 路径中任何**目录段**以 `.` 开头（隐藏目录）→ 不看：涵盖 `.git`、`.obsidian`、
//     `.trash`、`.zvec-grep` 以及任何用户自建的隐藏目录
//   * 文件名本身以 `.` 开头 → 不看（编辑器/系统写的临时隐藏文件）
// 传入 `null`/空 → false（拿不到名字时**不**据此触发，见 watchTree 的保守处理）。
export function shouldWatchRelPath(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  const segs = rel.split(/[\\/]+/).filter((s) => s && s !== '.');
  if (!segs.length) return false;

  for (const dir of segs.slice(0, -1)) {
    if (dir.startsWith('.') || WATCH_IGNORED_DIRS.includes(dir)) return false;
  }
  const file = segs[segs.length - 1];
  if (file.startsWith('.')) return false;
  return MD_RE.test(file);
}

// 事件合并器（防抖）：delayMs 内的变化攒成一批，只回调一次，回调收到去重后的文件列表。
//
// 为什么不「来一个事件跑一次索引」：Obsidian 保存一篇笔记会连发好几个事件
// （写临时文件 → rename 覆盖），键盘停下之前的每次自动保存也都是独立事件。
// 不合并的话，改一篇笔记可能触发 3~5 次索引，每次都要起一个 zg 子进程。
export function createBatcher({ delayMs = 1500, onFlush, timers } = {}) {
  const t = timers || { setTimeout, clearTimeout };
  let pending = new Set();
  let handle = null;

  const flush = () => {
    handle = null;
    if (!pending.size) return;
    const files = [...pending];
    pending = new Set();
    onFlush?.(files);
  };

  return {
    push(name) {
      pending.add(String(name));
      // 重新计时：以「最后一次性变化」为起点，而不是第一次。
      if (handle) t.clearTimeout(handle);
      handle = t.setTimeout(flush, delayMs);
    },
    // 立刻结算（测试与「退出前把最后的改动落下去」用）
    flushNow() {
      if (handle) {
        t.clearTimeout(handle);
        handle = null;
      }
      flush();
    },
    pendingCount: () => pending.size,
    dispose() {
      if (handle) t.clearTimeout(handle);
      handle = null;
      pending = new Set();
    },
  };
}

// 拿不到变化文件名时的占位。fs.watch 在个别平台/个别事件上会给 null filename，
// 此时**无法判断**变的是不是我们关心的东西。选择「保守触发一次」而不是「静默丢弃」：
// 漏掉一次真实改动（检索不到刚写的内容）比多重索引一次（zg 是增量的，代价很小）更糟。
export const WATCH_ANY = '*';

// 目录名是否整棵跳过：隐藏目录（`.git` / `.obsidian` / `.trash` / 任意 `.xxx`）
// 加上显式名单。刻意与 shouldWatchRelPath 共用同一份名单，避免两处漂移。
export function shouldSkipDirName(name) {
  return String(name).startsWith('.') || WATCH_IGNORED_DIRS.includes(name);
}

// 目录增删后重扫的延迟。rename 事件与「目录真的建好/删干净」之间有个窗口，
// 立刻重扫容易扫到中间态；顺便起节流作用（一次批量操作只重扫一次）。
const RESCAN_DELAY_MS = 200;

// 把「监听一棵树」包成「一批可关心的变化回调一次」。
//
// 实现要点（对应文件头那两个坑）：
//   * 逐个目录挂**非递归** watcher，`shouldSkipDirName` 的目录整个不进去
//     —— `.zvec-grep/` 既不产生事件，也不会被 scandir（回环与 ENOENT 都没了）
//   * 每个 watcher 都挂 'error'：异步错误**只报告不抛**，并摘掉出错的 watcher、
//     稍后重扫把它重新挂上（自愈）
//
// onBatch(relPaths) —— 仅在过滤后仍有可关心的变化时被调用
// onError({ dir, error }) —— watcher 级故障（读不到目录、句柄耗尽…）；不掀掉监听
// 返回 { close(), dirs(), rescan(), error }；`error` 只在**启动阶段**就失败时有值
// （不抛，交给上层展示），运行期故障一律走 onError。
export function watchTree(
  dir,
  { delayMs = 1500, onBatch, onError, watchImpl, readdirImpl, rescanDelayMs = RESCAN_DELAY_MS } = {},
) {
  const w = watchImpl || fsWatch;
  const read = readdirImpl || readdirSync;
  const rootAbs = resolve(dir);
  const batch = createBatcher({ delayMs, onFlush: (files) => onBatch?.(files) });

  const watchers = new Map(); // absDir -> FSWatcher
  const errorDirs = new Set(); // 已报过错的目录，恢复前不重复报（免刷屏）
  let firstError = null;
  let closed = false;
  let rescanHandle = null;

  function report(absDir, err) {
    if (!firstError) firstError = err;
    if (errorDirs.has(absDir)) return;
    errorDirs.add(absDir);
    try {
      onError?.({ dir: absDir, error: err });
    } catch {
      /* 回调自己出错不该影响监听 */
    }
  }

  function drop(absDir) {
    const watcher = watchers.get(absDir);
    if (!watcher) return;
    watchers.delete(absDir);
    try {
      watcher.close();
    } catch {
      /* 已经关过了 */
    }
  }

  function add(absDir) {
    if (closed || watchers.has(absDir)) return;
    let watcher;
    try {
      watcher = w(absDir, { recursive: false }, (eventType, filename) => onEvent(absDir, eventType, filename));
      // 这条是**防崩的关键**：没有它，一个异步 ENOENT 就能掀翻整个进程。
      watcher.on?.('error', (err) => {
        report(absDir, err);
        drop(absDir);
        scheduleRescan(); // 目录可能只是被替换了，稍后重扫重挂
      });
    } catch (err) {
      report(absDir, err);
      return;
    }
    watchers.set(absDir, watcher);
    errorDirs.delete(absDir); // 挂上了就算恢复，之后可以再报
  }

  function onEvent(absDir, eventType, filename) {
    if (closed) return;
    // 只有 rename 会带来结构变化（目录增/删/改名）→ 稍后重扫以挂上/摘掉目录 watcher。
    if (eventType === 'rename') scheduleRescan();
    if (filename == null) {
      batch.push(WATCH_ANY);
      return;
    }
    // 每个 watcher 报的是「相对自己那个目录」的名字，要拼成相对 root 的路径再过滤
    const rel = relative(rootAbs, join(absDir, String(filename)));
    if (shouldWatchRelPath(rel)) batch.push(rel);
  }

  function scheduleRescan() {
    if (closed || rescanHandle) return; // 已排一次就够（节流）
    rescanHandle = setTimeout(() => {
      rescanHandle = null;
      scan();
    }, rescanDelayMs);
    rescanHandle.unref?.();
  }

  // 从根开始枚举目录：跳过排除目录，给每个目录挂 watcher，摘掉已消失的。
  function scan() {
    if (closed) return;
    const seen = new Set();
    const stack = [rootAbs];
    while (stack.length) {
      const cur = stack.pop();
      if (seen.has(cur)) continue;
      seen.add(cur);

      let entries;
      try {
        entries = read(cur, { withFileTypes: true });
      } catch (err) {
        // 读不到的目录（被删/无权限）：报告并摘掉，不能让它拖垮整棵树
        report(cur, err);
        drop(cur);
        continue;
      }

      add(cur);
      for (const e of entries || []) {
        // 只下钻真目录。符号链接不算 —— 跟着走可能成环，也可能指到 vault 外面去
        if (!e?.isDirectory?.()) continue;
        if (shouldSkipDirName(e.name)) continue;
        stack.push(join(cur, e.name));
      }
    }

    for (const absDir of [...watchers.keys()]) {
      if (!seen.has(absDir)) drop(absDir);
    }
  }

  scan();

  return {
    dirs: () => [...watchers.keys()].sort(),
    rescan: scan,
    close() {
      closed = true;
      if (rescanHandle) clearTimeout(rescanHandle);
      rescanHandle = null;
      batch.dispose();
      for (const absDir of [...watchers.keys()]) drop(absDir);
      watchers.clear();
    },
    error: firstError || null,
  };
}

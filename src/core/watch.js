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
// `fs.watch(dir, { recursive: true })` 会把**整棵树**的变化都报上来，
// 包括我们完全不关心的三类，而它们恰恰是最吵的：
//   1. `.obsidian/`——Obsidian 每次切笔记、改配置、装插件都在写。本机实测该目录
//      里有 325 篇 md（占全部 md 的 59%）。不管它，光是打开 Obsidian 就会触发索引。
//   2. `.trash/`——删一篇笔记就动一次，不该因为它重建索引。
//   3. `.zvec-grep/`——**我们自己**的索引目录。zg 建索引时会往里写文件，
//      不过滤就会形成回环：索引写盘 → 事件 → 再索引 → 再写盘。
//
// 前两类是「噪声」，第三类是「自激」。只做防抖挡不住它们（防抖只合并密集事件，
// 不改变「该不该响应」），所以过滤必须发生在**事件入口**，早于合并。
import { watch as fsWatch } from 'node:fs';
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

// 把 fs.watch(dir, { recursive }) 包成「一批可关心的变化回调一次」。
//   onBatch(relPaths) —— 只在过滤后仍有可关心的变化时被调用
// 返回 { close() }；若监听起不来，返回里的 error 说明原因（不抛，交给上层展示）。
export function watchTree(dir, { delayMs = 1500, onBatch, watchImpl } = {}) {
  const w = watchImpl || fsWatch;
  const batch = createBatcher({ delayMs, onFlush: (files) => onBatch?.(files) });

  let watcher;
  try {
    watcher = w(dir, { recursive: true }, (_event, filename) => {
      if (filename == null) {
        batch.push(WATCH_ANY);
        return;
      }
      const rel = String(filename);
      if (shouldWatchRelPath(rel)) batch.push(rel);
    });
  } catch (err) {
    batch.dispose();
    return { close() {}, error: err };
  }

  return {
    close() {
      batch.dispose();
      try {
        watcher.close();
      } catch {
        /* 已经关过了 */
      }
    },
  };
}

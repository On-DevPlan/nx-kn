// kb 域的「守护」：监听已登记的库，笔记一变就自动跑增量索引。
//
// 两处入口共用同一个引擎：
//   * CLI 前台常驻 —— `nx-kn watch`，占住一个终端，Ctrl+C 停
//   * serve 进程内后台 —— 面板上「守护」开关控制它（见 runtime/cli.js 的 cmdServe）
//
// 为什么它只做「在正确的时机触发」而不自己实现增量：
// zg 的 `index` 本来就是增量的（未变向量原样保留，实测见 references/10 §四），
// 所以守护要做的只有一件事——把 `service.index({ root })` 在对的时刻叫起来。
// 「索引怎么建、模型怎么选、要不要 --rebuild」全部归 kb/service.js，与手动路径一字不差。
// 这跟采集域「只负责 URL → markdown，索引复用 kb」是同一个思路：
// 新能力只补它独有的那一环，不复制已有的一环。
//
// 三个必须自己处理的点（都不是「顺手优化」而是正确性）：
//   1. **排除目录根本不挂 watcher**（见 core/watch.js：逐个目录挂非递归 watcher，
//      跳过 `.zvec-grep/` 等）。若只做事件过滤，Linux 上 Node 的递归实现仍会走进
//      `.zvec-grep/`，撞上索引重建的 RocksDB 目录 → ENOENT → 守护进程崩（实测踩过）
//   2. **串行 + 不重入**：zg 同时跑两个 workspace 会抢模型与磁盘（service.index 的注释里
//      记了这个坑），且同一库并排跑两次索引毫无意义
//   3. **合并而非排队**：索引期间来的变化只置一个 dirty 位，跑完再补一轮，
//      避免「改了 20 次 → 排 20 次索引」
import * as service from './service.js';
import { APP_NAME, watchDebounceMs } from '../../core/paths.js';
import { badInput } from '../../core/errors/index.js';
import { WATCH_ANY, watchTree } from '../../core/watch.js';

// 最近事件留多少条。面板要的是「最近发生了什么」，不是完整审计日志。
const MAX_EVENTS = 20;

// 会话单例。null = 没在跑。刻意是模块级而不是导出可变对象——
// 调用方只能通过 startWatch / stopWatch 改变它，拿不到半途的状态。
let session = null;

function nowIso() {
  return new Date().toISOString();
}

function pushEvent(ev) {
  if (!session) return;
  session.events.unshift(ev);
  if (session.events.length > MAX_EVENTS) session.events.length = MAX_EVENTS;
  session.onEvent?.(ev);
}

export function isWatching() {
  return !!session && !session.stopped;
}

// 给面板/CLI 看的状态快照。没在跑时也返回同形状的「空态」，
// 免得消费方到处写 `watch && watch.running`。
export function watchState() {
  if (!session) {
    return { running: false, startedAt: null, source: null, debounceMs: null, vaults: [], events: [], runs: 0, errors: 0 };
  }
  return {
    running: !session.stopped,
    startedAt: session.startedAt,
    source: session.source,
    debounceMs: session.debounceMs,
    vaults: [...session.targets.values()].map((t) => ({
      path: t.path,
      name: t.name,
      busy: t.busy,
      lastAt: t.lastAt,
      lastChanges: t.lastChanges,
      error: t.error || null,
    })),
    events: session.events,
    runs: session.runs,
    errors: session.errors,
  };
}

// 起守护。幂等：已经在跑就原样返回当前状态（重复调用不会起第二个会话）。
export async function startWatch({ debounceMs, source = 'serve', onEvent } = {}) {
  if (isWatching()) return watchState();

  const delayMs = debounceMs == null ? watchDebounceMs() : Number(debounceMs);
  const { vaults } = await service.resolveVaults({});
  const usable = vaults.filter((v) => !v.missing);
  if (!usable.length) {
    throw badInput(`没有可守护的知识库目录：先跑 ${APP_NAME} kb add <vault路径>`);
  }

  session = {
    startedAt: nowIso(),
    source,
    debounceMs: delayMs,
    targets: new Map(),
    events: [],
    runs: 0,
    errors: 0,
    stopped: false,
    queue: Promise.resolve(),
    onEvent,
  };

  for (const v of usable) {
    const t = {
      path: v.path,
      name: v.name || v.path,
      busy: false,
      dirty: false,
      lastAt: null,
      lastChanges: null,
      error: null,
      close: null,
    };
    const h = watchTree(v.path, {
      delayMs,
      onBatch: (files) => onChange(t, files),
      // watcher 级故障（目录被删/无权限/句柄耗尽）只记进状态并继续 ——
      // 与「索引失败不掀掉守护」同一条原则。watchTree 会自己把它重挂上。
      onError: ({ error }) => onWatchError(t, error),
    });
    t.close = h.close;
    t.error = h.error ? String(h.error.message || h.error) : null;
    session.targets.set(v.path, t);
    if (t.error) {
      session.errors++;
      pushEvent({ type: 'error', at: nowIso(), vault: t.path, vaultName: t.name, error: `监听失败：${t.error}` });
    }
  }

  return watchState();
}

export function stopWatch() {
  if (!session) return watchState();
  for (const t of session.targets.values()) t.close?.();
  session.stopped = true;
  const snap = watchState();
  session = null;
  return { ...snap, running: false };
}

// watcher 级故障：记状态 + 报一条事件，**不**停止守护。
// 文案刻意写「已自动重挂」——watchTree 会摘掉出错的 watcher 并在重扫时重新挂上，
// 所以这通常是一次性的抖动（目录被替换、编辑器原子保存换了 inode）。
function onWatchError(t, err) {
  const s = session;
  if (!s || s.stopped) return;
  t.error = String((err && err.message) || err);
  s.errors++;
  pushEvent({
    type: 'error',
    at: nowIso(),
    vault: t.path,
    vaultName: t.name,
    error: `监听出错（已自动重挂，若持续出现请检查该目录权限）：${t.error}`,
  });
}

// 一批可关心的变化到了。
function onChange(t, files) {
  const s = session;
  if (!s || s.stopped) return;

  // 能收到变化就说明 watcher 是活的 —— 把之前那次 watcher 级故障的标记清掉，
  // 免得面板一直挂着一条已经自愈的错误。
  t.error = null;

  const known = files.filter((f) => f !== WATCH_ANY);
  pushEvent({
    type: 'detected',
    at: nowIso(),
    vault: t.path,
    vaultName: t.name,
    count: known.length,
    files: known.slice(0, 8),
    unknown: files.includes(WATCH_ANY),
  });

  // 正在索引：只置 dirty，跑完补一轮。**不**入队 N 次——
  // 否则一次批量编辑（Obsidian 同步、git checkout）会把队列塞满重复索引。
  if (t.busy) {
    t.dirty = true;
    return;
  }
  runIndex(t);
}

// 跑一轮该库的增量索引。挂在会话的串行队列上（跨库也串行——
// service.index 本身串行跑多库，zg 同时开两个 workspace 会抢模型与磁盘）。
function runIndex(t) {
  const s = session;
  if (!s) return;
  t.busy = true;
  s.queue = s.queue.then(async () => {
    if (s.stopped) {
      t.busy = false;
      return;
    }
    try {
      const r = await service.index({ root: t.path });
      const one = (r.results || [])[0] || null;
      t.lastAt = nowIso();
      t.lastChanges = one?.changes || null;
      s.runs++;
      pushEvent({
        type: 'indexed',
        at: t.lastAt,
        vault: t.path,
        vaultName: t.name,
        changes: t.lastChanges,
        elapsedMs: one?.elapsedMs ?? null,
      });
    } catch (err) {
      // 索引失败**不能**掀掉守护：一个是磁盘/模型偶发问题，
      // 让整个监听退出会让用户以为「守护坏了」，而其实下一笔改动就好了。
      s.errors++;
      pushEvent({ type: 'error', at: nowIso(), vault: t.path, vaultName: t.name, error: String((err && err.message) || err) });
    } finally {
      t.busy = false;
      if (t.dirty && !s.stopped) {
        t.dirty = false;
        runIndex(t);
      }
    }
  });
  return s.queue;
}

// 事件 → 一行人类可读文本。CLI 前台与 serve 的控制台共用，保证两处说法一致。
export function formatEvent(ev) {
  const ts = new Date(ev.at).toLocaleTimeString('zh-CN', { hour12: false });
  const who = `[${ev.vaultName}]`;
  if (ev.type === 'detected') {
    return `[${ts}] ${who} 检测到变化：${ev.count ? `${ev.count} 个文件` : '未知文件名'}`;
  }
  if (ev.type === 'indexed') {
    const c = ev.changes;
    const ch = c
      ? `新增 ${c.added ?? 0} / 改动 ${c.modified ?? 0} / 删除 ${c.deleted ?? 0} / 未变 ${c.unchanged ?? 0}`
      : '（zg 未给出统计）';
    return `[${ts}] ${who} 已增量更新：${ch}（${((ev.elapsedMs || 0) / 1000).toFixed(1)}s）`;
  }
  return `[${ts}] ${who} 出错：${ev.error}`;
}

// CLI 前台常驻：占住终端直到 Ctrl+C。
// 只打「结果」与「错误」，不打「检测到变化」——前台看的是「索引刷了没有」，
// 每笔变化都报两行会把有用信息淹掉（面板里两者都留着，供回看）。
export async function runWatchForeground({ debounceMs, log = console.log } = {}) {
  const st = await startWatch({
    debounceMs,
    source: 'cli',
    onEvent: (ev) => {
      if (ev.type === 'detected') return;
      log(formatEvent(ev));
    },
  });

  log(`${APP_NAME} 守护已启动 —— 监听 ${st.vaults.length} 个知识库，笔记一变就自动增量索引`);
  for (const v of st.vaults) {
    log(`  [${v.name}] ${v.path}${v.error ? `   ⚠ 监听失败：${v.error}` : ''}`);
  }
  log(`防抖 ${st.debounceMs}ms · 按 Ctrl+C 停止`);

  await new Promise((resolveForever) => {
    const bye = () => {
      stopWatch();
      log('\n守护已停止');
      resolveForever();
    };
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  });
}

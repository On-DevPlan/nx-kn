// 跨视图刷新事件：轻量 pub/sub，只服务一个场景——
// 嵌入在同一 tab 里的两个视图（kb 列表 ← crawl 采集动作）需要互相通知。
// 不引入全局状态管理：kb 列表只在收到事件时多做一次 /api/kb/status，
// 没有事件就零开销，维持「知识库列表不轮询 zg」的既有约束（起子进程是秒级开销）。
export const KB_CHANGED = 'nx-kn:kb-changed';

export function emitKbChanged() {
  window.dispatchEvent(new CustomEvent(KB_CHANGED));
}

export function onKbChanged(handler) {
  window.addEventListener(KB_CHANGED, handler);
  return () => window.removeEventListener(KB_CHANGED, handler);
}

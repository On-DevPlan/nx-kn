// 编程入口：供其他工具 / agent 以库方式调用。
// 导出的是各模块的 service（业务真相源），不是 CLI/HTTP 壳——库用方自己组织 I/O。
export * as store from './core/store.js';
export * as errors from './core/errors/index.js';

export * as home from './modules/home/service.js';
export * as kb from './modules/kb/service.js';
export * as crawl from './modules/crawl/service.js';

// core/web.js 的纯函数（HTML→markdown、sitemap 解析、URL 归一）也对外导出：
// 库用方想复用「抓一个页面并清洗」时不必自己重写一遍。
export * as web from './core/web.js';

// Skill Seekers 的进程驱动（候选命令解析 + spawn + 可用性探测）同样导出：
// 库用方要自己编排这个外部引擎时，不必重新踩一遍「URL 里的 % 不能过 shell」这些坑。
export * as skillSeekers from './core/skill-seekers.js';

export { ACTIONS, MODULES } from './runtime/registry.js';
export { startServer } from './runtime/server.js';
export { runCli } from './runtime/cli.js';

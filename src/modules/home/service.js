// home 域的 service：业务真相源。CLI 与 Web 面板共用这一层。
//
// 这是模板自带的最小示例域——它示范了 service 的三种返回形态：
//   throw        失败（调用方无从处理）
//   { status }   业务结果（调用方要拿它做决策）
//   普通对象     数据（调用方直接展示）
import { readFileSync } from 'node:fs';
import { APP_NAME, APP_DESC, APP_TITLE, STORE_PATH, storePathFromEnv } from '../../core/paths.js';

const VERSION = JSON.parse(
  readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
).version;

// 一次拿齐面板启动所需的上下文。
// 面板用它渲染标题、版本、存储路径与「CLI 等价」提示——
// 各视图不自己拼这些字符串，否则迟早与实际不符。
export async function bootstrap() {
  const { commandTable } = await import('./commands.js');
  return {
    app: { name: APP_NAME, title: APP_TITLE, description: APP_DESC, version: VERSION },
    storePath: storePathFromEnv(),
    storeDefault: STORE_PATH,
    commands: await commandTable(),
  };
}

// 大整数的可读化，供展示
export function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n) || 0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// 一键流水线：抓取采集源（crawl run）→ 更新索引（kb index）。
// 这两步是**前后关系**，不是选择关系——产物落盘后必须进索引才能被检索到。
// CLI 的 `pipeline` 命令与首页的「一键跑流水线」按钮共用这一层。
//
// 每步独立容错：抓取失败不阻断索引（上一次的产物可能还在，索引照样有价值），
// 步骤结果如实体现在返回值里，整体 status 只有在全部成功/跳过时才是 ok。
export async function pipeline({ rebuild } = {}) {
  const crawlSvc = await import('../crawl/service.js');
  const kbSvc = await import('../kb/service.js');
  const started = Date.now();
  const steps = [];

  // ① 抓取：没有采集源就跳过，不算失败
  const list = await crawlSvc.list();
  if (!list.count) {
    steps.push({ id: 'crawl', status: 'skipped', note: '没有采集源' });
  } else {
    try {
      steps.push({ id: 'crawl', status: 'ok', result: await crawlSvc.run({ rebuild: !!rebuild }) });
    } catch (e) {
      steps.push({ id: 'crawl', status: 'failed', error: e.message, code: e.code });
    }
  }

  // ② 索引：没有知识库就跳过
  const st = await kbSvc.status({});
  if (!st.configured || !st.totals || !st.totals.vaults) {
    steps.push({ id: 'index', status: 'skipped', note: '没有知识库' });
  } else {
    try {
      steps.push({ id: 'index', status: 'ok', result: await kbSvc.index({ rebuild: !!rebuild }) });
    } catch (e) {
      steps.push({ id: 'index', status: 'failed', error: e.message, code: e.code });
    }
  }

  const failed = steps.filter((s) => s.status === 'failed');
  return {
    status: failed.length ? 'failed' : 'ok',
    steps,
    elapsedMs: Date.now() - started,
    hint: `检索：${APP_NAME} query "问题"`,
  };
}

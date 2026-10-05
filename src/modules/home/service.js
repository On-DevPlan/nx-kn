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
// 可选 target（本地目录 / 文档站 URL / 已有源名）：**提供目录就直接抓取该目录**——
// 未登记自动登记，已登记复用现源（幂等：重复提供同目录 = 增量重跑，不是报冲突）。
// name 与 target 等价但只认源名（面板添加本地源后直达用）。
//
// 每步独立容错：抓取失败不阻断索引（上一次的产物可能还在，索引照样有价值），
// 步骤结果如实体现在返回值里，整体 status 只有在全部成功/跳过时才是 ok。
export async function pipeline({ rebuild, target, name } = {}) {
  const crawlSvc = await import('../crawl/service.js');
  const kbSvc = await import('../kb/service.js');
  const started = Date.now();
  const steps = [];

  // ⓪ 定位采集范围：不指定 = 全部源；name = 按源名；target = 目录/URL/源名（未登记自动登记）
  let scope = name ? String(name) : null;
  if (!scope && target !== undefined && target !== null && target !== '') {
    const t = String(target);
    // 先按源名匹配——名字永远比路径短，用户敲 `pipeline obsidian-vault` 应当直接命中
    const byName = (await crawlSvc.storedSources()).find((s) => s.name === t);
    if (byName) {
      scope = byName.name;
      steps.push({ id: 'register', status: 'ok', result: { name: byName.name, added: false } });
    } else {
      try {
        const reg = await crawlSvc.ensureSource({ url: t });
        scope = reg.name;
        steps.push({ id: 'register', status: 'ok', result: reg });
      } catch (e) {
        steps.push({ id: 'register', status: 'failed', error: e.message, code: e.code });
      }
    }
  }
  const registerFailed = steps.some((s) => s.id === 'register' && s.status === 'failed');

  // ① 抓取：登记失败时无从抓起；没有采集源就跳过，都不算失败
  const list = await crawlSvc.list();
  if (registerFailed) {
    steps.push({ id: 'crawl', status: 'skipped', note: '登记失败，跳过抓取' });
  } else if (!list.count) {
    steps.push({ id: 'crawl', status: 'skipped', note: '没有采集源' });
  } else {
    try {
      steps.push({ id: 'crawl', status: 'ok', result: await crawlSvc.run({ name: scope || undefined, rebuild: !!rebuild }) });
    } catch (e) {
      steps.push({ id: 'crawl', status: 'failed', error: e.message, code: e.code });
    }
  }

  // ② 索引：没有知识库就跳过（始终全量范围——增量索引本来就只碰有变化的库）
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

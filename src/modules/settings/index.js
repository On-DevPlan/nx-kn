// settings 域：action 声明。写法照 home/index.js —— 一条 action 同时声明
// cli 与 http，两侧自动同源。这里的形态刻意与 home 形成对照：
// home 全是只读 action，这里有 mutation（POST /api/settings + settings set），
// 两个示例域加起来把「读」与「写」两条链路都示范完了。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';

const APP_NAME_HINT = APP_NAME + ' settings';

export default {
  id: 'settings',
  title: '设置',
  order: 5,
  actions: [
    {
      id: 'settings.get',
      cli: ['settings', 'get'],
      http: ['GET', '/api/settings'],
      summary: '读取全部设置（store.json 的 settings 键）',
      run: () => service.get(),
      render: (r) => {
        const entries = Object.entries(r.settings || {});
        if (!entries.length) return '（settings 为空——用 settings set 写入）';
        const width = Math.max(...entries.map(([k]) => k.length));
        return entries.map(([k, v]) => `${k.padEnd(width + 2)}${JSON.stringify(v)}`).join('\n');
      },
    },
    {
      id: 'settings.set',
      cli: ['settings', 'set'],
      http: ['POST', '/api/settings'],
      summary: '写入设置（k=v 形式，可多个；白名单外的键会被拒绝）',
      args: [{ name: 'pairs', rest: true, required: false }],
      run: (ctx) => {
        const patch = {};
        for (const p of ctx.pairs || []) {
          const i = String(p).indexOf('=');
          if (i <= 0) {
            const err = new Error(`设置项需形如 k=v，收到: ${p}（如: ${APP_NAME_HINT} set theme=dark）`);
            err.code = 'INVALID_INPUT';
            return Promise.reject(err);
          }
          patch[String(p).slice(0, i)] = String(p).slice(i + 1);
        }
        return service.set({ patch });
      },
      render: (r) =>
        r.skipped
          ? '没有要写的键（k=v 形式至少一条）'
          : `已写入（mutateStore 原子落盘）:\n` +
            Object.entries(r.settings || {})
              .map(([k, v]) => `  ${k} = ${JSON.stringify(v)}`)
              .join('\n'),
    },
  ],
};

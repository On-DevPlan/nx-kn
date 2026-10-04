// crawl 域：action 声明。写法照 kb/index.js —— 一条 action 同时声明 cli 与 http，
// 命令表、路由表、help 文本全部由这一处派生。
//
// 命令名取舍：与 kb 域动词对齐（add / list / remove，`run` 对应 kb 的 index），
// 这样「登记 → 抓取 → 建索引 → 检索」四步的命令读起来是一条线。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';

function hint(cmd) {
  return `${APP_NAME} ${cmd}`;
}

function changesLine(c) {
  if (!c) return null;
  const parts = [];
  if (c.added) parts.push(`新增 ${c.added}`);
  if (c.updated) parts.push(`更新 ${c.updated}`);
  parts.push(`未变 ${c.unchanged}`);
  if (c.skipped) parts.push(`跳过空页 ${c.skipped}`);
  return parts.join(' / ');
}

export default {
  id: 'crawl',
  title: '资料采集',
  order: 20,
  actions: [
    {
      id: 'crawl.add',
      cli: [['crawl', 'add']],
      http: ['POST', '/api/crawl/add'],
      summary: '登记一个文档站采集源（抓取产物落成 markdown 目录并自动登记为知识库）',
      args: [{ name: 'url' }],
      flags: {
        name: { type: 'string' },
        match: { type: 'string', hint: 'glob', default: '**' },
        max: { type: 'number', default: 200 },
      },
      run: (ctx) => service.add({ url: ctx.url, name: ctx.name, include: ctx.match, max: ctx.max }),
      render: (r) =>
        [
          `采集源: ${r.name}`,
          `  地址   ${r.url}`,
          `  落盘   ${r.dir}`,
          `  范围   ${r.include}（最多 ${r.max} 页）`,
          `  共     ${r.count} 个采集源`,
          r.hint,
        ].join('\n'),
    },
    {
      id: 'crawl.run',
      cli: [['crawl', 'run']],
      http: ['POST', '/api/crawl/run'],
      summary: '抓取采集源并落成 markdown（默认全部源；默认增量，只重写内容变更的页面）',
      flags: { name: { type: 'string' }, rebuild: { type: 'boolean' } },
      run: (ctx) => service.run({ name: ctx.name, rebuild: ctx.rebuild }),
      render: (r) => {
        const lines = [
          r.rebuild ? `已全量重抓 ${r.count} 个采集源` : `已增量抓取 ${r.count} 个采集源`,
          '',
        ];
        for (const x of r.results) {
          lines.push(`[${x.name}] ${x.url}`);
          lines.push(`    方式 ${x.via === 'sitemap' ? 'sitemap' : '同域 BFS'} · 共 ${x.pages} 页 · ${changesLine(x.changes)}`);
          if (x.failed) {
            lines.push(`    失败 ${x.failed} 页：`);
            for (const f of x.failures.slice(0, 5)) lines.push(`      ${f.url} —— ${f.error}`);
          }
          lines.push(`    已登记为知识库：${x.dir}`);
        }
        lines.push('', `共写入 ${r.totals.pages} 页（新增 ${r.totals.added} / 更新 ${r.totals.updated} / 未变 ${r.totals.unchanged}）`);
        if (r.totals.failed) lines.push(`失败 ${r.totals.failed} 页（见上）`);
        if (r.results[0]) lines.push('', `继续：${hint('index')} 把抓到的内容加进索引`);
        return lines.join('\n');
      },
    },
    {
      id: 'crawl.list',
      cli: [['crawl', 'list']],
      http: ['GET', '/api/crawl/list'],
      summary: '列出采集源、上次抓取时间与页数',
      run: () => service.list(),
      render: (r) => {
        if (!r.count) return `还没有采集源 —— 跑 ${hint('crawl add <url> --name <名>')}`;
        const lines = [`共 ${r.count} 个采集源`, ''];
        for (const s of r.sources) {
          lines.push(`[${s.name}] ${s.url}`);
          lines.push(
            `    ${s.pages} 页` +
              (s.failed ? ` · 失败 ${s.failed}` : '') +
              ` · 方式 ${s.via || '—'}` +
              ` · 上次抓取 ${s.lastRunAt || '（未抓取）'}` +
              ` · ${s.registered ? '已登记为知识库' : '未登记'}`
          );
          lines.push(`    ${s.dir}`);
        }
        return lines.join('\n');
      },
    },
    {
      id: 'crawl.remove',
      cli: [['crawl', 'remove'], ['crawl', 'rm']],
      http: ['POST', '/api/crawl/remove'],
      summary: '解登记一个采集源（默认保留抓下来的文件与索引；--purge 连文件一起删）',
      args: [{ name: 'name' }],
      flags: { purge: { type: 'boolean' } },
      run: (ctx) => service.remove({ name: ctx.name, purge: ctx.purge }),
      render: (r) =>
        [`已移除采集源: ${r.removed}`, `  剩余 ${r.count} 个采集源`, r.note ? `  ${r.note}` : null]
          .filter(Boolean)
          .join('\n'),
    },
  ],
};

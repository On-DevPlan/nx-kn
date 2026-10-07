// crawl 域：action 声明。写法照 kb/index.js —— 一条 action 同时声明 cli 与 http，
// 命令表、路由表、help 文本全部由这一处派生。
//
// 命令名取舍：与 kb 域动词对齐（add / list / remove，`run` 对应 kb 的 index），
// 这样「登记 → 抓取 → 建索引 → 检索」四步的命令读起来是一条线。
//
// 抓取引擎（--engine）是 2026-10-04 新增的维度：默认 skill-seekers（外部 Python 引擎），
// 可切 node（内置零依赖）。枚举从 service 取，保证声明与实现不会分叉。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';

function hint(cmd) {
  return `${APP_NAME} ${cmd}`;
}

function engineLabel(e) {
  return e === 'skill-seekers' ? 'Skill Seekers（外部）' : '内置 Node';
}

function changesLine(c) {
  if (!c) return null;
  const parts = [];
  if (c.added) parts.push(`新增 ${c.added}`);
  if (c.updated) parts.push(`更新 ${c.updated}`);
  parts.push(`未变 ${c.unchanged}`);
  if (c.skipped) parts.push(`跳过空页 ${c.skipped}`);
  // 清理数单独报：它是「目录变小了」的唯一解释，混进 other 里就没人看得见
  if (c.removed) parts.push(`清理 ${c.removed}`);
  return parts.join(' / ');
}

// 一行的「怎么抓的」摘要。内置引擎才有「发现方式」（sitemap / 同域 BFS），
// 外部引擎的发现与分类在它自己内部完成，报个 sitemap 只会误导。
// 本地目录源把引擎一栏换成「本地目录整理」——它不抓网页，语义是整理本地文件。
function howLine(x) {
  const local = x.kind === 'local';
  const bits = [local ? '本地目录整理' : `引擎 ${engineLabel(x.engine)}`];
  if (!local && x.engine !== 'skill-seekers') bits.push(`方式 ${x.via === 'sitemap' ? 'sitemap' : '同域 BFS'}`);
  bits.push(`共 ${x.pages} 页`);
  return bits.join(' · ');
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
      summary:
        '登记一个采集源：文档站 URL 或本地目录（如 Obsidian vault；产物落成 markdown 目录并自动登记为知识库）',
      args: [{ name: 'url', hint: 'http(s) 地址或本地目录路径' }],
      flags: {
        name: { type: 'string' },
        engine: { type: 'string', enum: service.ENGINES, default: service.DEFAULT_ENGINE },
        'enhance-level': { type: 'number', default: 0, hint: '0-3' },
        agent: { type: 'string' },
        match: { type: 'string', hint: 'glob', default: '**' },
        max: { type: 'number', default: 200 },
      },
      run: (ctx) =>
        service.add({
          url: ctx.url,
          name: ctx.name,
          engine: ctx.engine,
          enhanceLevel: ctx['enhance-level'],
          agent: ctx.agent,
          include: ctx.match,
          max: ctx.max,
        }),
      render: (r) =>
        [
          `采集源: ${r.name}`,
          r.kind === 'local' ? `  本地   ${r.url}` : `  地址   ${r.url}`,
          `  引擎   ${engineLabel(r.engine)}` +
            (r.engine === 'skill-seekers'
              ? `（增强级别 ${r.enhanceLevel}${r.agent ? ` · agent ${r.agent}` : ''}）`
              : ''),
          `  落盘   ${r.dir}`,
          `  范围   ${r.include}（最多 ${r.max} 页${r.engine === 'skill-seekers' ? '；Skill Seekers 不受此上限约束' : ''}）`,
          `  共     ${r.count} 个采集源`,
          r.hint,
        ].join('\n'),
    },
    {
      id: 'crawl.run',
      cli: [['crawl', 'run']],
      http: ['POST', '/api/crawl/run'],
      summary: '抓取采集源并落成 markdown（默认全部源；默认增量，只重写内容变更的页面）',
      flags: {
        name: { type: 'string' },
        engine: { type: 'string', enum: service.ENGINES, hint: '覆盖源的既定引擎' },
        rebuild: { type: 'boolean' },
      },
      run: (ctx) => service.run({ name: ctx.name, engine: ctx.engine, rebuild: ctx.rebuild }),
      render: (r) => {
        const lines = [
          r.rebuild ? `已全量重抓 ${r.count} 个采集源` : `已增量抓取 ${r.count} 个采集源`,
          '',
        ];
        for (const x of r.results) {
          lines.push(`[${x.name}] ${x.url}`);
          lines.push(`    ${howLine(x)} · ${changesLine(x.changes)}`);
          if (x.note) lines.push(`    注意 ${x.note}`);
          if (x.failed) {
            lines.push(`    失败 ${x.failed} 页：`);
            for (const f of x.failures.slice(0, 5)) lines.push(`      ${f.url} —— ${f.error}`);
          }
          lines.push(`    已登记为知识库：${x.dir}`);
        }
        lines.push(
          '',
          `共写入 ${r.totals.pages} 页（新增 ${r.totals.added} / 更新 ${r.totals.updated} / 未变 ${r.totals.unchanged}）`
        );
        if (r.totals.failed) lines.push(`失败 ${r.totals.failed} 页（见上）`);
        if (r.totals.removed) {
          lines.push(`清理 ${r.totals.removed} 个陈旧文件（远端已删 / 换引擎残留；手放进去的文件不受影响）`);
        }
        if (r.results[0]) lines.push('', `继续：${hint('index')} 把抓到的内容加进索引`);
        return lines.join('\n');
      },
    },
    {
      id: 'crawl.list',
      cli: [['crawl', 'list']],
      http: ['GET', '/api/crawl/list'],
      summary: '列出采集源、引擎、上次抓取时间与页数',
      run: () => service.list(),
      render: (r) => {
        if (!r.count) return `还没有采集源 —— 跑 ${hint('crawl add <url> --name <名>')}`;
        const lines = [`共 ${r.count} 个采集源`, ''];
        for (const s of r.sources) {
          lines.push(`[${s.name}] ${s.url}${s.kind === 'local' ? '（本地目录）' : ''}`);
          lines.push(
            `    ${s.pages} 页` +
              (s.failed ? ` · 失败 ${s.failed}` : '') +
              ` · 引擎 ${engineLabel(s.engine)}` +
              (s.engine === 'skill-seekers' ? `（增强 ${s.enhanceLevel}）` : '') +
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

// needdo 域：action 声明。写法照 crawl/index.js —— 一条 action 同时声明 cli 与 http，
// 命令表、路由表、help 文本全部由这一处派生。
//
// 命令名与动词取向：add / list / show / remove / process —— 与 kb、crawl 的动词
// 对齐（show 对应「单条详情」，kb 的 query 是检索语义，这里不检索只是读一条）。
// 四种输入（粘贴文字 / 链接 / 本地文件 / 面板上传）收在一条 `needdo add` 里：
// 收件箱的心智模型是「一个口子全收」，拆成四条命令反而逼用户先想清楚类型。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';

function hint(cmd) {
  return `${APP_NAME} ${cmd}`;
}

function kindLabel(it) {
  if (it.kind === 'text') return '文字';
  if (it.kind === 'link') return '链接';
  return (it.ext || '').toUpperCase();
}

function statusLabel(it) {
  return it.status === 'done' ? '已归档' : '收件箱';
}

export default {
  id: 'needdo',
  title: 'NeedDo',
  order: 15,
  actions: [
    {
      id: 'needdo.add',
      cli: [['needdo', 'add']],
      http: ['POST', '/api/needdo/add'],
      summary:
        '收进一条混乱输入：<text> 直接贴文字；--link 收网址；--file 收本地文档（pdf/docx/txt/md）；面板上传走 --data(base64)+--name',
      args: [{ name: 'text', required: false, rest: true, hint: '要收进来的文字（可多词）' }],
      flags: {
        link: { type: 'string', hint: 'http(s) 地址' },
        file: { type: 'string', hint: '本地文档路径' },
        data: { type: 'string', hint: '文件内容 base64（面板上传通道）' },
        name: { type: 'string', hint: '原始文件名（配合 --data）' },
        title: { type: 'string', hint: '自定义标题（默认自动取首行/文件名/网址）' },
      },
      run: async (ctx) => {
        const item = await service.add(ctx);
        const all = await service.list({});
        return { item, count: all.total, inbox: all.inbox };
      },
      render: (r) => {
        const it = r.item;
        return [
          `已收进收件箱: ${it.title}`,
          `  类型   ${kindLabel(it)}${it.kind === 'file' ? `（${it.textFile ? '已提取文本' : '未提取出文本，原件已保留'}）` : ''}`,
          `  编号   ${it.id}`,
          `  共     ${r.count} 条条目（收件箱 ${r.inbox}）`,
          `继续：${hint('needdo process')} 按主题整理并归档`,
        ].join('\n');
      },
    },
    {
      id: 'needdo.list',
      cli: [['needdo', 'list']],
      http: ['GET', '/api/needdo/list'],
      summary: '列出收件箱条目（默认全部；--status inbox|done、--topic 可过滤）',
      flags: {
        status: { type: 'string', enum: ['inbox', 'done'], hint: '按状态过滤' },
        topic: { type: 'string', hint: '按主题过滤（待办事项/公告通知/文档资料/链接收藏/杂项收集）' },
      },
      run: (ctx) => service.list({ status: ctx.status, topic: ctx.topic }),
      render: (r) => {
        if (!r.count) {
          return r.total
            ? `过滤条件下没有条目（共 ${r.total} 条，收件箱 ${r.inbox}）`
            : `收件箱是空的 —— 丢一句话进来：${hint('needdo add 明天下午3点开会')}`;
        }
        const filtered = r.status || r.topic ? `（过滤自 ${r.total} 条）` : '';
        const lines = [`共 ${r.count} 条${filtered}（收件箱 ${r.inbox}）`, ''];
        for (const it of r.items) {
          const time = String(it.addedAt || '').replace('T', ' ').slice(5, 16);
          lines.push(`  [${it.id}] ${kindLabel(it)} · ${it.title}`);
          lines.push(
            `      ${time} · ${statusLabel(it)}` +
              (it.topic ? ` · ${it.topic}` : '') +
              (it.size ? ` · ${(it.size / 1024).toFixed(1)}KB` : '')
          );
          if (it.excerpt && it.excerpt !== it.title) lines.push(`      ${it.excerpt}`);
        }
        return lines.join('\n');
      },
    },
    {
      id: 'needdo.show',
      cli: [['needdo', 'show']],
      http: ['GET', '/api/needdo/show'],
      summary: '看一条条目的完整内容（文字给全文；文档给提取文本；链接给网址）',
      args: [{ name: 'id' }],
      run: (ctx) => service.show({ id: ctx.id }),
      render: (r) => {
        const it = r.item;
        const head = [
          `[${it.id}] ${kindLabel(it)} · ${it.title}`,
          `  ${String(it.addedAt).replace('T', ' ').slice(0, 16)} · ${statusLabel(it)}${it.topic ? ` · ${it.topic}` : ''}`,
        ];
        if (it.file) head.push(`  原件   ${service.filePathOf(it)}`);
        if (it.kind === 'link') head.push(`  ${it.content}`);
        else if (r.text) head.push('', r.text);
        else head.push('  （没有可展示的文本——原件在上面路径里）');
        return head.join('\n');
      },
    },
    {
      id: 'needdo.archive',
      cli: [['needdo', 'archive']],
      http: ['POST', '/api/needdo/archive'],
      summary: '归档一条条目（移出收件箱视野，数据保留）；--undo 还原回收件箱',
      args: [{ name: 'id' }],
      flags: { undo: { type: 'boolean' } },
      run: (ctx) => service.archive({ id: ctx.id, undo: ctx.undo }),
      render: (r) => (r.status === 'done' ? `已归档: ${r.id}` : `已还原到收件箱: ${r.id}`),
    },
    {
      id: 'needdo.remove',
      cli: [['needdo', 'remove'], ['needdo', 'rm']],
      http: ['POST', '/api/needdo/remove'],
      summary: '删一条条目（连同它的原件与提取文本）；--all 清空收件箱（整理报告不受影响）',
      args: [{ name: 'id', required: false }],
      flags: { all: { type: 'boolean' } },
      run: (ctx) => service.remove({ id: ctx.id, all: ctx.all }),
      render: (r) =>
        r.removed > 1
          ? `已清空收件箱（${r.removed} 条）`
          : `已移除: ${r.ids[0]}`,
    },
    {
      id: 'needdo.process',
      cli: [['needdo', 'process']],
      http: ['POST', '/api/needdo/process'],
      summary:
        '整理收件箱：按主题归类（待办/公告/文档/链接/杂项）、写整理报告并归档条目；--agent 预留 AI 整理接入点',
      flags: { agent: { type: 'string', hint: 'agent 名（记录在案；AI 深度整理待接入）' } },
      run: (ctx) => service.process({ agent: ctx.agent }),
      render: (r) => {
        if (!r.processed) return `收件箱已是空的（没有待整理条目）—— 收点东西进来：${hint('needdo add <text>')}`;
        const lines = [
          `已整理 ${r.processed} 条并归档:`,
          ...r.byTopic.map((x) => `  ${x.topic} ${x.count} 条`),
          '',
          `报告: ${r.report}`,
        ];
        if (r.agent) lines.push(`（--agent ${r.agent} 已记录；AI 深度整理待接入，本次为确定性主题分类）`);
        return lines.join('\n');
      },
    },
  ],
};

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
          `  ${String(it.addedAt).replace('T', ' ').slice(0, 16)} · ${statusLabel(it)}${it.topic ? ` · ${it.topic}` : ''}` +
            (it.topicSource === 'ai' ? '（主题来自 AI）' : ''),
        ];
        if (it.file) head.push(`  原件   ${service.filePathOf(it)}`);
        if (it.ai) {
          head.push(
            `  AI     ${it.ai.status} · ${it.ai.agent || 'agent'} · 级别 ${it.ai.level}` +
              (it.ai.confidence != null ? ` · 置信 ${it.ai.confidence}` : '') +
              (it.ai.topic ? ` · 建议主题 ${it.ai.topic}` : ''),
            it.ai.summary ? `         摘要 ${it.ai.summary}` : null,
            it.ai.tags && it.ai.tags.length ? `         标签 ${it.ai.tags.join(', ')}` : null
          );
        }
        if (it.kind === 'link') head.push(`  ${it.content}`);
        else if (r.text) head.push('', r.text);
        else head.push('  （没有可展示的文本——原件在上面路径里）');
        return head.filter(Boolean).join('\n');
      },
    },
    {
      id: 'needdo.archive',
      cli: [['needdo', 'archive']],
      http: ['POST', '/api/needdo/archive'],
      summary: '归档条目（移出收件箱视野，数据保留）；--undo 还原；--ids 批量（逗号分隔）',
      args: [{ name: 'id', required: false }],
      flags: { undo: { type: 'boolean' }, ids: { type: 'array', hint: '批量归档/还原这些条目' } },
      run: (ctx) => service.archive({ id: ctx.id, ids: ctx.ids, undo: ctx.undo }),
      render: (r) =>
        [
          r.status === 'done' ? `已归档 ${r.count} 条` : `已还原 ${r.count} 条`,
          r.missing && r.missing.length ? `  跳过（不存在）: ${r.missing.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
    },
    {
      id: 'needdo.file',
      cli: [['needdo', 'file']],
      http: ['GET', '/api/needdo/file'],
      summary: '取一条文件条目的原件（CLI 打印路径与尺寸；面板用同一接口以 base64 过境下载）',
      args: [{ name: 'id' }],
      run: (ctx) => service.fileData({ id: ctx.id }),
      render: (r) =>
        [
          `原件: ${r.name}`,
          `  类型   ${(r.ext || '').toUpperCase()} · ${(r.size / 1024).toFixed(1)}KB`,
          `  位置   ${r.path}`,
        ].join('\n'),
    },
    {
      id: 'needdo.remove',
      cli: [['needdo', 'remove'], ['needdo', 'rm']],
      http: ['POST', '/api/needdo/remove'],
      summary:
        '删条目（连同原件与提取文本）：单条给 <id>、批量给 --ids a,b、--all 清空收件箱（整理报告不受影响）',
      args: [{ name: 'id', required: false }],
      flags: { all: { type: 'boolean' }, ids: { type: 'array', hint: '批量删除这些条目' } },
      run: (ctx) => service.remove({ id: ctx.id, ids: ctx.ids, all: ctx.all }),
      render: (r) =>
        [
          r.removed > 1 ? `已删除 ${r.removed} 条` : `已删除: ${r.ids[0] || '(无)'}`,
          r.missing && r.missing.length ? `跳过（不存在）: ${r.missing.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
    },
    {
      id: 'needdo.process',
      cli: [['needdo', 'process']],
      http: ['POST', '/api/needdo/process'],
      summary:
        '整理收件箱：按主题归类（待办/公告/文档/链接/杂项）、写整理报告并归档条目；--ids 只整理指定条目；--enhance-level ≥1 时同时把条目排进 AI 复核队列',
      flags: {
        agent: { type: 'string', hint: 'agent 名（记录在案）' },
        ids: { type: 'array', hint: '只整理这些条目（逗号分隔）' },
        'enhance-level': { type: 'number', default: 0, hint: '0-3，0 = 纯规则不调 AI；≥1 排队等 brief' },
      },
      run: (ctx) =>
        service.process({ agent: ctx.agent, ids: ctx.ids, level: ctx['enhance-level'] }),
      render: (r) => {
        if (!r.processed) return `收件箱已是空的（没有待整理条目）—— 收点东西进来：${hint('needdo add <text>')}`;
        const lines = [
          `已整理 ${r.processed} 条并归档:`,
          ...r.byTopic.map((x) => `  ${x.topic} ${x.count} 条`),
          '',
          `报告: ${r.report}`,
        ];
        if (r.pendingAi) {
          lines.push(
            `已排队等 AI 复核（级别 ${r.level}）：${r.pendingAi} 条`,
            `继续：${hint(`brief --level ${r.level} --json > brief.json`)} 把简报交给 agent`
          );
        }
        return lines.join('\n');
      },
    },
    {
      id: 'needdo.brief',
      cli: [['needdo', 'brief']],
      http: ['GET', '/api/needdo/brief'],
      summary:
        '导出 agent 简报（一次拿全的自足 JSON：条目全文/夹链接/规则预判主题/内容指纹；配合 --json 得到机器形态）',
      flags: {
        ids: { type: 'array', hint: '只导出这些条目（逗号分隔）' },
        level: { type: 'number', default: 1, hint: '1-3：1 主题修正 / 2 +摘要 / 3 +标签' },
        redo: { type: 'boolean', hint: '已有 AI 建议的也带上（重跑）' },
      },
      run: (ctx) => service.brief({ ids: ctx.ids, level: ctx.level, redo: ctx.redo }),
      render: (r) => {
        if (!r.count) {
          return `没有需要导出的条目（都处理过了？加 --redo 连已建议的一起重跑，或 --ids 指定）`;
        }
        const lines = [
          `共 ${r.count} 条待 AI 复核 · 批次 ${r.batchId} · 级别 ${r.level}`,
          `任务：${r.task}`,
          '',
        ];
        for (const it of r.items) {
          lines.push(`  [${it.id}] ${it.kind} · ${it.title} —— 规则预判 ${it.ruleTopic}`);
        }
        lines.push('', `把简报交给 agent：${hint(`brief --json --level ${r.level} > brief.json`)}`);
        return lines.join('\n');
      },
    },
    {
      id: 'needdo.apply',
      cli: [['needdo', 'apply']],
      http: ['POST', '/api/needdo/apply'],
      summary:
        '写回 agent 的计划文件（只追加 ai 附注，绝不覆盖原文/主题/状态；同一份计划重放 = no-op；内容变过的条目跳过并回报）',
      flags: {
        plan: { type: 'string', hint: '计划文件路径（CLI）；HTTP 走 body.planData' },
        agent: { type: 'string', hint: 'agent 名（计划里没写时的兜底）' },
      },
      run: (ctx) => service.apply({ plan: ctx.planData, planPath: ctx.plan, agent: ctx.agent }),
      render: (r) => {
        const lines = [`已写入 ${r.applied} 条 AI 建议（待复核）`];
        const bits = [];
        if (r.unchanged) bits.push(`已是最新 ${r.unchanged}`);
        if (r.stale) bits.push(`跳过过期 ${r.stale}（内容变过：${r.staleIds.slice(0, 3).join(', ')}${r.staleIds.length > 3 ? '…' : ''}）`);
        if (r.missing) bits.push(`不存在 ${r.missing}`);
        if (bits.length) lines.push(`  ${bits.join(' · ')}`);
        if (r.applied) lines.push('', `继续：${hint('needdo review --ids ' + 'a,b')} 逐条接受（或加 --reject 拒绝）`);
        return lines.join('\n');
      },
    },
    {
      id: 'needdo.review',
      cli: [['needdo', 'review']],
      http: ['POST', '/api/needdo/review'],
      summary:
        '复核 AI 建议：默认接受（写主题并记 topicSource=ai），--reject 拒绝（只清状态）；支持 --ids 批量',
      args: [{ name: 'id', required: false }],
      flags: { ids: { type: 'array', hint: '批量复核这些条目' }, reject: { type: 'boolean' } },
      run: (ctx) => service.review({ id: ctx.id, ids: ctx.ids, reject: ctx.reject }),
      render: (r) => {
        const lines = [
          r.rejected ? `已拒绝 ${r.rejected} 条 AI 建议` : `已接受 ${r.accepted} 条 AI 建议（主题按建议更新）`,
        ];
        if (r.accepted && r.rejected) lines[0] = `已接受 ${r.accepted} 条 · 已拒绝 ${r.rejected} 条`;
        if (r.noSuggestion.length) lines.push(`  跳过（没有待复核的建议）: ${r.noSuggestion.join(', ')}`);
        if (r.missing.length) lines.push(`  跳过（不存在）: ${r.missing.join(', ')}`);
        // 说清后果：主题是**就地**更新的；条目若已归档，不会被 process 再收一遍
        // （process 只动 inbox），要重新进报告得先还原。
        if (r.accepted) {
          lines.push(
            '',
            `主题已更新并标注来源 ai（再见它时显示「主题来自 AI」）`,
            `已归档的条目不会被 process 再收——要让它进新报告：先 ${hint('needdo archive <id> --undo')} 再 process`
          );
        }
        return lines.join('\n');
      },
    },
  ],
};

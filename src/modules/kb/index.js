// kb 域：action 声明。写法照 home/index.js —— 一条 action 同时声明 cli 与 http，
// 命令表、路由表、help 文本全部由这一处派生。
//
// 命令名取舍：`index` / `query` / `status` 用**顶层命令**（不加 kb 前缀），
// 因为这个工具本身就是「知识库检索」，敲 `nx-kn query "问题"` 才是日常用法；
// 同时保留 `kb xxx` 别名，跟模块名对得上，与其他域的命名也不会撞。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';

function kbHint(cmd) {
  return `${APP_NAME} ${cmd}`;
}

export default {
  id: 'kb',
  title: '知识库',
  order: 10,
  actions: [
    {
      id: 'kb.use',
      cli: ['kb', 'use'],
      http: ['POST', '/api/kb/use'],
      summary: '设定 Obsidian vault 路径（写入 store.json，之后 index/query 都用它）',
      args: [{ name: 'path' }],
      run: (ctx) => service.use({ path: ctx.path }),
      render: (r) =>
        [
          `知识库: ${r.vault}`,
          `  笔记   ${r.notes} 篇${r.notesTruncated ? '（已截断计数）' : ''}`,
          `  形态   ${r.obsidian ? 'Obsidian vault（含 .obsidian/）' : '普通目录（无 .obsidian/）'}`,
          `  索引   ${r.indexed ? '已建（' + r.indexPath + '）' : '未建 —— 跑 ' + kbHint('index')}`,
        ].join('\n'),
    },
    {
      id: 'kb.index',
      cli: [['index'], ['kb', 'index']],
      http: ['POST', '/api/kb/index'],
      summary: '对 vault 建索引（默认只收 md；--rebuild 重建，换模型必须叠加 --rebuild）',
      flags: {
        root: { type: 'string' },
        rebuild: { type: 'boolean' },
        model: { type: 'string' },
        types: { type: 'array' },
      },
      run: (ctx) =>
        service.index({ root: ctx.root, rebuild: ctx.rebuild, model: ctx.model, types: ctx.types }),
      render: (r) =>
        [
          `${r.rebuild ? '已重建' : '已更新'}索引（${(r.elapsedMs / 1000).toFixed(1)}s）`,
          r.summary,
          '',
          `  覆盖   ${r.index?.files ?? '?'} / ${r.index?.filesTotal ?? '?'} 文件 · ${r.index?.entities ?? '?'} 片段`,
          `  模型   ${r.index?.embedding?.model || '（未知）'}`,
          `  索引   ${r.indexPath}`,
        ].join('\n'),
    },
    {
      id: 'kb.query',
      cli: [['query'], ['kb', 'query']],
      http: ['GET', '/api/kb/query'],
      summary: '混合检索（rg 精确 + 关键词 + 语义），返回 vault 内相对路径与行号',
      args: [{ name: 'q' }],
      flags: {
        limit: { type: 'number', default: 7 },
        preview: { type: 'string', enum: ['none', 'short', 'full'], default: 'short' },
        root: { type: 'string' },
      },
      run: (ctx) => service.query({ q: ctx.q, root: ctx.root, limit: ctx.limit, preview: ctx.preview }),
      render: (r) => {
        if (r.needIndex) return `知识库: ${r.vault}\n${r.hint}`;
        if (!r.hits.length) {
          return `${r.header}（无命中）\n原样输出:\n${r.text}`;
        }
        const lines = [r.header.trimEnd(), ''];
        for (const h of r.hits) {
          lines.push(
            `#${h.n} ${h.path}:${h.start}-${h.end}   [${h.matchedBy.join('+')}]` +
              (h.heading ? `   ${h.heading}` : '')
          );
          for (const s of h.snippet.split('\n')) lines.push('    ' + s);
        }
        if (r.notes.length) lines.push('', ...r.notes.map((n) => '  ' + n));
        return lines.join('\n');
      },
    },
    {
      id: 'kb.status',
      cli: [['status'], ['kb', 'status']],
      http: ['GET', '/api/kb/status'],
      summary: '知识库与索引状态（zg 可用性、笔记数、模型、覆盖度）',
      flags: { root: { type: 'string' } },
      run: (ctx) => service.status({ root: ctx.root }),
      render: (r) => {
        const lines = [
          `zg        ${r.zg.installed ? r.zg.version || '已安装' : '未安装（npm install -g @zvec/zvec-grep）'}`,
        ];
        if (!r.configured) {
          lines.push(`知识库    未设定 —— 跑 ${kbHint('kb use <vault路径>')}`);
          if (r.hint) lines.push(`          ${r.hint}`);
          return lines.join('\n');
        }
        lines.push(`知识库    ${r.vault}（${r.notes} 篇 md${r.obsidian ? ' · Obsidian' : ''}）`);
        lines.push(
          `索引      ${r.indexed ? (r.index?.stale ? '待更新（有新增/改动）' : '已建') : '未建'}`
        );
        if (r.index) {
          lines.push(
            `覆盖      ${r.index.coveragePercent ?? '?'}%  ${r.index.files ?? '?'} / ${r.index.filesTotal ?? '?'} 文件 · ${r.index.entities ?? '?'} 片段`
          );
        }
        lines.push(`模型      ${r.model || '（未记录）'}`);
        if (r.hint) lines.push(`提示      ${r.hint}`);
        return lines.join('\n');
      },
    },
  ],
};

// kb 域：action 声明。写法照 home/index.js —— 一条 action 同时声明 cli 与 http，
// 命令表、路由表、help 文本全部由这一处派生。
//
// 命令名取舍：`index` / `query` / `status` 用**顶层命令**（不加 kb 前缀），
// 因为这个工具本身就是「知识库检索」，敲 `nx-kn query "问题"` 才是日常用法；
// 同时保留 `kb xxx` 别名，跟模块名对得上，与其他域的命名也不会撞。
//
// 多库下的命令面：kb add / kb remove / kb list 管「有哪些库」，
// index / query / status 管「对全部库做一件事」（--root 可缩到单个库）。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';

function kbHint(cmd) {
  return `${APP_NAME} ${cmd}`;
}

function indexLine(r) {
  return r.indexed
    ? `已建 · ${r.index?.files ?? '?'}/${r.index?.filesTotal ?? '?'} 文件 · ${r.index?.entities ?? '?'} 片段`
    : `未建 —— 跑 ${kbHint('index')}`;
}

function changesLine(c) {
  if (!c) return null;
  const parts = [];
  if (c.added != null) parts.push(`新增 ${c.added}`);
  if (c.modified != null) parts.push(`改动 ${c.modified}`);
  if (c.deleted != null) parts.push(`删除 ${c.deleted}`);
  if (c.unchanged != null) parts.push(`未变 ${c.unchanged}`);
  if (c.failed != null && c.failed > 0) parts.push(`失败 ${c.failed}`);
  return parts.length ? parts.join(' / ') : null;
}

export default {
  id: 'kb',
  title: '知识库',
  order: 10,
  actions: [
    {
      id: 'kb.add',
      // kb use 保留为别名：它原本就是「设定知识库」的入口，多库后语义变成「追加」——
      // 直接删掉会让老用户敲了个陌生错误，留着并在文档里写明等价关系更省事。
      cli: [['kb', 'add'], ['kb', 'use']],
      http: ['POST', '/api/kb/add'],
      summary: '把一个 vault 加进知识库列表（按绝对路径去重；可加多个，检索时一起搜）',
      args: [{ name: 'path' }],
      flags: { model: { type: 'string' } },
      run: (ctx) => service.add({ path: ctx.path, model: ctx.model }),
      render: (r) =>
        [
          `知识库: ${r.vault}${r.added ? '（已新增）' : '（已在列表中，未重复添加）'}`,
          `  笔记   ${r.notes} 篇${r.notesTruncated ? '（已截断计数）' : ''}`,
          `  形态   ${r.obsidian ? 'Obsidian vault（含 .obsidian/）' : '普通目录（无 .obsidian/）'}`,
          `  索引   ${indexLine(r)}`,
          r.plannedModel && !r.indexed ? `  模型   建索引时将使用 ${r.plannedModel}` : null,
          `  共     ${r.count} 个知识库`,
        ]
          .filter(Boolean)
          .join('\n'),
    },
    {
      id: 'kb.remove',
      cli: [['kb', 'remove'], ['kb', 'rm']],
      http: ['POST', '/api/kb/remove'],
      summary: '从知识库列表移除一个目录（只解除登记，不删磁盘上的索引）',
      args: [{ name: 'path' }],
      run: (ctx) => service.remove({ path: ctx.path }),
      render: (r) =>
        [`已移除: ${r.removed}`, `  剩余 ${r.count} 个知识库`, r.note ? `  ${r.note}` : null]
          .filter(Boolean)
          .join('\n'),
    },
    {
      id: 'kb.list',
      cli: [['kb', 'list']],
      http: ['GET', '/api/kb/list'],
      summary: '列出已登记的知识库目录及其索引状态',
      run: () => service.list(),
      render: (r) => {
        if (!r.count) return `还没有添加知识库目录 —— 跑 ${kbHint('kb add <vault路径>')}`;
        const lines = [`共 ${r.count} 个知识库`, ''];
        for (const v of r.vaults) {
          lines.push(`[${v.name}] ${v.path}`);
          const model = v.model
            ? v.model
            : v.plannedModel
              ? `（未建索引，建时计划用 ${v.plannedModel}）`
              : '（未记录）';
          lines.push(
            `    ${v.missing ? '目录不存在' : `${v.notes} 篇 md${v.obsidian ? ' · Obsidian' : ''}`}` +
              `  索引 ${v.missing ? '—' : indexLine(v)}` +
              `  模型 ${model}`
          );
        }
        return lines.join('\n');
      },
    },
    {
      id: 'kb.index',
      cli: [['index'], ['kb', 'index']],
      http: ['POST', '/api/kb/index'],
      summary:
        '对知识库建/增索引（默认全部库；默认只收 md。不带 --rebuild 就是增量，换模型必须 --rebuild）',
      flags: {
        root: { type: 'string' },
        rebuild: { type: 'boolean' },
        model: { type: 'string' },
        types: { type: 'array' },
      },
      run: (ctx) =>
        service.index({ root: ctx.root, rebuild: ctx.rebuild, model: ctx.model, types: ctx.types }),
      render: (r) => {
        const lines = [
          r.rebuild ? `已全量重建 ${r.count} 个库的索引` : `已增量更新 ${r.count} 个库的索引`,
          '',
        ];
        for (const x of r.results) {
          const ch = changesLine(x.changes);
          lines.push(`[${x.name}] ${x.path}`);
          lines.push(
            `    ${x.rebuild ? '全量重建' : '增量更新'}（${((x.elapsedMs || 0) / 1000).toFixed(1)}s）` +
              (ch ? `  ${ch}` : '')
          );
          lines.push(
            `    覆盖 ${x.index?.files ?? '?'} / ${x.index?.filesTotal ?? '?'} 文件 · ${x.index?.entities ?? '?'} 片段` +
              `  模型 ${x.index?.embedding?.model || x.model || '（未知）'}`
          );
        }
        if (r.missing?.length) lines.push('', `跳过（目录不存在）: ${r.missing.join('、')}`);
        return lines.join('\n');
      },
    },
    {
      id: 'kb.query',
      cli: [['query'], ['kb', 'query']],
      http: ['GET', '/api/kb/query'],
      summary: '混合检索（rg 精确 + 关键词 + 语义），跨全部库召回后按融合分合并',
      args: [{ name: 'q' }],
      flags: {
        limit: { type: 'number', default: 7 },
        preview: { type: 'string', enum: ['none', 'short', 'full'], default: 'short' },
        root: { type: 'string' },
      },
      run: (ctx) => service.query({ q: ctx.q, root: ctx.root, limit: ctx.limit, preview: ctx.preview }),
      render: (r) => {
        if (r.needIndex) {
          const where = r.vaults?.length ? `\n已登记: ${r.vaults.map((v) => v.path).join('、')}` : '';
          return `知识库${where}\n${r.hint}`;
        }
        const multi = (r.searched?.length || 0) > 1;
        if (!r.hits.length) {
          return `${r.header}（无命中）\n已检索: ${r.searched.map((v) => `[${v.name}] ${v.path}`).join('、')}`;
        }
        const lines = [r.header.trimEnd(), ''];
        for (const h of r.hits) {
          // 多库时必须标出「哪一个库」：单看相对路径无法定位磁盘文件
          const tag = multi ? `[${h.vaultName}] ` : '';
          lines.push(
            `#${h.n} ${tag}${h.path}:${h.start}-${h.end}   [${h.matchedBy.join('+')}]` +
              (h.score != null ? `   score ${h.score.toFixed(4)}` : '') +
              (h.heading ? `   ${h.heading}` : '')
          );
          for (const s of h.snippet.split('\n')) lines.push('    ' + s);
        }
        const meta = [
          `命中 ${r.hits.length}/${r.totalHits} 条`,
          `${(r.elapsedMs / 1000).toFixed(1)}s`,
          `检索了 ${r.searched.length} 个库`,
          ...r.notes,
        ];
        lines.push('', '  ' + meta.join(' · '));
        if (r.skipped?.length) {
          lines.push('  ' + r.skipped.map((s) => `跳过 [${s.name}] ${s.reason}`).join(' · '));
        }
        return lines.join('\n');
      },
    },
    {
      id: 'kb.status',
      cli: [['status'], ['kb', 'status']],
      http: ['GET', '/api/kb/status'],
      summary: '知识库与索引状态（zg 可用性、各库笔记数、索引覆盖度、生效模型）',
      flags: { root: { type: 'string' } },
      run: (ctx) => service.status({ root: ctx.root }),
      render: (r) => {
        const lines = [
          `zg        ${r.zg.installed ? r.zg.version || '已安装' : '未安装（npm install -g @zvec/zvec-grep）'}`,
        ];
        if (!r.configured) {
          lines.push(`知识库    未添加 —— 跑 ${kbHint('kb add <vault路径>')}`);
          if (r.hint) lines.push(`          ${r.hint}`);
          return lines.join('\n');
        }
        lines.push(`知识库    ${r.totals.vaults} 个（索引 ${r.totals.indexed} 个${r.totals.stale ? ` · 待更新 ${r.totals.stale} 个` : ''} · 共 ${r.totals.notes} 篇 md）`);
        lines.push('');
        for (const v of r.vaults) {
          lines.push(`[${v.name}] ${v.path}`);
          if (v.missing) {
            lines.push('    目录不存在');
            continue;
          }
          const idx = v.index
            ? `${v.index.stale ? '待更新' : '已建'} · ${v.index.coveragePercent ?? '?'}% ${v.index.files ?? '?'}/${v.index.filesTotal ?? '?'} 文件 · ${v.index.entities ?? '?'} 片段`
            : '未建';
          lines.push(`    ${v.notes} 篇 md${v.obsidian ? ' · Obsidian' : ''}   索引 ${idx}   模型 ${v.model || '（未记录）'}`);
          if (v.hint) lines.push(`    ${v.hint}`);
        }
        if (r.hint) lines.push('', `提示      ${r.hint}`);
        return lines.join('\n');
      },
    },
  ],
};

// 首页域：最小示例，同时承担「把 bootstrap 与命令表暴露给面板」的职责。
// 新增功能域时照着这个文件的形状写即可。
import * as service from './service.js';

export default {
  id: 'home',
  title: '首页',
  order: 1,
  actions: [
    {
      id: 'home.bootstrap',
      cli: ['bootstrap', 'show'],
      http: ['GET', '/api/bootstrap'],
      summary: '一次取齐面板启动所需的全部上下文',
      run: () => service.bootstrap(),
    },
    {
      id: 'home.routes',
      cli: ['routes'],
      http: ['GET', '/api/routes'],
      summary: '列出 CLI 命令与 HTTP 路由的对照表',
      run: async () => {
        const { commandTable } = await import('./commands.js');
        const table = await commandTable();
        return {
          status: 'ok',
          count: table.length,
          routes: table.map((c) => ({
            id: c.id,
            module: c.module,
            cli: c.command,
            http: c.http ? `${c.http.method} ${c.http.path}` : null,
            summary: c.summary,
          })),
        };
      },
      render: (r) => {
        const lines = [`共 ${r.count} 条命令（CLI ↔ HTTP 对照）`, ''];
        const width = Math.max(...r.routes.map((x) => x.cli.length));
        for (const x of r.routes) {
          lines.push('  ' + x.cli.padEnd(width + 2) + (x.http || '(仅 CLI)') + '   ' + (x.summary || ''));
        }
        return lines.join('\n');
      },
    },
    {
      id: 'home.health',
      cli: ['health'],
      http: ['GET', '/api/health'],
      summary: '自检：存储可读、命令表可生成',
      run: async () => {
        const { commandTable } = await import('./commands.js');
        const { loadStore, storeRecovery } = await import('../../core/store.js');
        const table = await commandTable();
        const b = await service.bootstrap();
        // **真的读一次存储**——summary 里「存储可读」这句得是真的。
        // 顺带触发 core/store.js 的损坏隔离：文件不是合法 JSON 时会被挪成备份，
        // 这里把结果报出来（否则那次隔离只存在于 stderr 里，很容易漏掉）。
        const store = await loadStore();
        return {
          status: 'ok',
          app: b.app.name,
          version: b.app.version,
          storePath: b.storePath,
          commands: table.length,
          vaults: store.kb.vaults.length,
          sources: store.crawl.sources.length,
          storeRecovery: storeRecovery() || null,
        };
      },
      render: (r) =>
        [
          `正常 · ${r.app} v${r.version} · ${r.commands} 条命令`,
          `存储: ${r.storePath}（知识库 ${r.vaults} 个 · 采集源 ${r.sources} 个）`,
          r.storeRecovery
            ? `⚠ 存储文件曾被隔离：备份在 ${r.storeRecovery.backup}\n` +
              `  原因 ${r.storeRecovery.reason}\n` +
              `  确认备份内容无误后改回原路径；否则本次运行会以空结构继续，下次写入即覆盖`
            : null,
        ]
          .filter(Boolean)
          .join('\n'),
    },
    {
      id: 'home.pipeline',
      cli: ['pipeline'],
      http: ['POST', '/api/pipeline/run'],
      summary:
        '一键流水线：抓取 → 更新索引（两步串联）。传目录/URL 未登记会自动登记；传源名只抓该源，索引仍是全局增量',
      args: [{ name: 'target', required: false, hint: '本地目录、文档站 URL 或已有源名（可省略 = 全部源）' }],
      flags: {
        rebuild: { type: 'boolean', hint: '全量重抓 + 全量重建索引（默认都走增量）' },
        name: { type: 'string', hint: '只抓这个源（索引步骤不受它影响）' },
      },
      run: (ctx) => service.pipeline({ rebuild: ctx.rebuild, target: ctx.target, name: ctx.name }),
      render: (r) => {
        const lines = [];
        for (const s of r.steps) {
          if (s.id === 'register') {
            if (s.status === 'failed') lines.push(`⓪ 登记：失败 —— ${s.error}`);
            else {
              lines.push(`⓪ 登记：[${s.result.name}] ${s.result.added ? '新登记' : '已存在，复用现源'}`);
            }
          } else if (s.id === 'crawl') {
            if (s.status === 'skipped') lines.push(`① 抓取：跳过（${s.note}）`);
            else if (s.status === 'failed') lines.push(`① 抓取：失败 —— ${s.error}`);
            else {
              const t = s.result.totals || {};
              lines.push(
                `① 抓取：${s.result.count} 个源 · 新增 ${t.added} / 更新 ${t.updated} / 未变 ${t.unchanged}` +
                  (t.failed ? ` · 失败 ${t.failed} 页` : '')
              );
            }
          } else if (s.id === 'index') {
            if (s.status === 'skipped') lines.push(`② 索引：跳过（${s.note}）`);
            else if (s.status === 'failed') lines.push(`② 索引：失败 —— ${s.error}`);
            else {
              const rs = s.result.results || [];
              const files = rs.reduce((a, v) => a + (v.index?.files ?? 0), 0);
              const filesTotal = rs.reduce((a, v) => a + (v.index?.filesTotal ?? 0), 0);
              const entities = rs.reduce((a, v) => a + (v.index?.entities ?? 0), 0);
              lines.push(`② 索引：${s.result.count} 个库 · 覆盖 ${files}/${filesTotal} 文件 · ${entities} 片段`);
            }
          }
        }
        lines.push('', `用时 ${((r.elapsedMs || 0) / 1000).toFixed(1)}s · ${r.hint}`);
        if (r.status === 'failed') lines.push('（有步骤失败——细节见上；索引步骤基于抓取结果重跑一次往往无益，先修抓取）');
        return lines.join('\n');
      },
    },
    {
      id: 'home.store',
      cli: ['store', 'path'],
      http: ['GET', '/api/store'],
      summary: '显示存储路径（可用环境变量覆盖）',
      run: async () => {
        const b = await service.bootstrap();
        return { status: 'ok', path: b.storePath, default: b.storeDefault };
      },
      render: (r) => `${r.path}    （默认 ${r.default}）`,
    },
    {
      id: 'home.skillInstall',
      cli: ['skill', 'install'],
      http: ['POST', '/api/skill/install'],
      summary: '把随包 skill 装到 ~/.claude/skills（让本机 agent 学会用法）',
      flags: {
        name: { type: 'string' },
        to: { type: 'string' },
        force: { type: 'boolean' },
      },
      run: async (ctx) => {
        const { installBundledSkill } = await import('../../runtime/skill.js');
        return installBundledSkill({ name: ctx.name, to: ctx.to, force: ctx.force });
      },
      render: (r) => {
        if (r.skipped) return `已是最新: ${r.path}`;
        if (r.status === 'conflict')
          return `冲突: ${r.path}（${r.count} 个文件不同；确认覆盖加 --force）`;
        return `${r.replaced ? '已替换' : '已安装'}: ${r.path}（${r.files} 个文件）`;
      },
    },
    {
      id: 'home.skillGet',
      cli: ['skill', 'get'],
      http: null, // 纯 stdout 契约：三段拼接给外部 agent，无 HTTP 形态
      summary: '导出 skill 上下文（prefix + 文档 + install 状态，供外部 agent 复制）',
      args: [{ name: 'ref', required: false }],
      flags: { name: { type: 'string' }, to: { type: 'string' }, force: { type: 'boolean' } },
      run: async (ctx) => {
        const { getSkill } = await import('../../runtime/skill.js');
        return getSkill({ ref: ctx.ref, name: ctx.name, to: ctx.to, force: ctx.force });
      },
      render: async (r) => {
        // --json 由 emit 走序列化（不含 prefix）；人读模式走三段拼接
        const { skillGetPrefix, skillGetInstallStatus } = await import('../../runtime/skill.js');
        return [
          skillGetPrefix(r.skillName, r.ref),
          r.content,
          '',
          skillGetInstallStatus(r.install),
        ].join('\n');
      },
    },
  ],
};

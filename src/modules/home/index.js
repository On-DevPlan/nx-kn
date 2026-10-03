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
        const table = await commandTable();
        const b = await service.bootstrap();
        return {
          status: 'ok',
          app: b.app.name,
          version: b.app.version,
          storePath: b.storePath,
          commands: table.length,
        };
      },
      render: (r) =>
        `正常 · ${r.app} v${r.version} · ${r.commands} 条命令\n存储: ${r.storePath}`,
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

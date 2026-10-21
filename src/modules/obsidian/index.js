// obsidian 域：action 声明。写法照 settings/index.js —— 一条 action 同时声明
// cli 与 http，两侧自动同源（CLI / HTTP / 面板提示都从这一份声明派生）。
//
// 本域与 settings 有一处**刻意的不同**（别照抄 settings）：
// run() 同时吃两种输入 —— CLI 的 k=v 位置参数（ctx.pairs）与 HTTP body 的裸键
// （ctx.vault / ctx.specDir / ...）。settings.set 只认 pairs，而它的面板 POST 的是
// 裸键 —— 于是面板保存恒为空 patch，「已保存」的 toast 是假的。
// 本域两侧都接，别把这个坑复制过来。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';
import { badInput } from '../../core/errors/index.js';

const USAGE_HINT = `${APP_NAME} obsidian set vault=<绝对路径>`;

export default {
  id: 'obsidian',
  title: 'Obsidian',
  order: 6,
  actions: [
    {
      id: 'obsidian.get',
      cli: ['obsidian', 'get'],
      http: ['GET', '/api/obsidian'],
      summary: '读取 obsidian 配置与解析后的路径（vault 来源、规范目录、文档存在性）',
      run: () => service.get(),
      render: (r) => lines(r).join('\n'),
    },
    {
      id: 'obsidian.set',
      cli: ['obsidian', 'set'],
      http: ['POST', '/api/obsidian'],
      summary:
        '写入 obsidian 配置（vault=<绝对路径> / specDir=<vault内相对路径> / contentDoc= / questionnaireDoc=，可多个；空值=复位；白名单外的键被拒绝）',
      args: [{ name: 'pairs', rest: true, required: false }],
      run: (ctx) => service.set({ patch: patchOf(ctx) }),
      render: (r) =>
        r.skipped
          ? '没有要写的键（k=v 形式至少一条）'
          : ['已写入（mutateStore 原子落盘）:', ...lines(r)].join('\n'),
    },
    {
      id: 'obsidian.spec',
      cli: ['obsidian', 'spec'],
      http: ['GET', '/api/obsidian/spec'],
      summary:
        '解析内容规范文档的位置（skill 消费契约：content / questionnaire 两份文档的绝对路径与存在性）',
      run: () => service.spec(),
      render: (r) => {
        if (!r.configured) {
          return ['规范文档位置无法解析（vault 未设置）', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        const out = [`vault: ${r.vault}`, `规范目录: ${r.specDir}`];
        for (const d of r.docs || []) out.push(`  ${d.key}: ${d.path}${d.exists ? '' : '（缺失）'}`);
        for (const h of r.hints || []) out.push(`提示: ${h}`);
        return out.join('\n');
      },
    },
  ],
};

// CLI 的 k=v 与 HTTP 的裸键汇成同一个 patch。
function patchOf(ctx) {
  const patch = {};
  if (Array.isArray(ctx.pairs) && ctx.pairs.length) {
    for (const p of ctx.pairs) {
      const i = String(p).indexOf('=');
      if (i <= 0) {
        throw badInput(`用法: ${USAGE_HINT} —— 配置项需形如 k=v，收到: ${p}`);
      }
      patch[String(p).slice(0, i)] = String(p).slice(i + 1);
    }
    return patch;
  }
  for (const k of service.OBSIDIAN_KEYS) {
    if (ctx[k] !== undefined) patch[k] = ctx[k];
  }
  return patch;
}

const SOURCE_LABEL = {
  store: 'store 配置',
  env: '环境变量 NX_OBSIDIAN_VAULT',
  kb: 'kb 登记库兜底',
};

function lines(r) {
  if (!r.configured) {
    return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)];
  }
  const out = [
    `vault      ${r.vault}（来源: ${SOURCE_LABEL[r.source] || r.source || '未知'}）`,
    `  .obsidian  ${r.hasObsidianMarker ? '存在' : '未发现（不像 Obsidian vault）'}`,
    `规范目录    ${r.specDir}${r.specDirExists ? '' : '（不存在）'}`,
  ];
  for (const d of r.docs || []) {
    out.push(`  ${d.doc.padEnd(22)} ${d.path}【${d.exists ? '存在' : '缺失'}】`);
  }
  for (const h of r.hints || []) out.push(`提示        ${h}`);
  return out;
}

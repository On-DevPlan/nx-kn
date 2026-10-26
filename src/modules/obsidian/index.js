// obsidian 域：action 声明。写法照 settings/index.js —— 一条 action 同时声明
// cli 与 http，两侧自动同源（CLI / HTTP / 面板提示都从这一份声明派生）。
//
// 本域与 settings 有一处**刻意的不同**（别照抄 settings）：
// run() 同时吃两种输入 —— CLI 的 k=v 位置参数（ctx.pairs）与 HTTP body 的裸键。
// settings.set 只认 pairs，而它的面板 POST 的是裸键 —— 于是面板保存恒为空 patch，
// 「已保存」的 toast 是假的。本域两侧都接，不复制这个坑。
import * as service from './service.js';
import { APP_NAME } from '../../core/paths.js';
import { badInput } from '../../core/errors/index.js';

const USAGE_HINT = `${APP_NAME} obsidian set vault=<绝对路径>`;

// 6 条根因诊断（照搬原 postcheck.py 的文案，顺序按发生概率）。
// 第 1 条里真的有不可见字符（U+3000 / U+00A0）——照抄原样，别"清理"成可见字符，
// 那会让排查的人看不到问题在哪。
const ROOT_CAUSES = [
  '双链含不可见字符：半角空格 / 全角空格（　）/ NBSP（ ）/ 中文空格（　）',
  '双链首尾多了标点：`[[foo]]、` 被记成 `foo、` 找不到',
  '双链用了全角括号：`【foo】` 不是 `[[foo]]`',
  '目标文件名带空格但双链写成下划线/无空格（反之亦然）',
  '目标文件实际未创建（先确认新文件落地）',
  '目标文件在另一个目录但双链用了 basename（应改 [[path/file]] 或确保同目录唯一 basename）',
];

export default {
  id: 'obsidian',
  title: 'Obsidian',
  order: 6,
  actions: [
    {
      id: 'obsidian.get',
      cli: ['obsidian', 'get'],
      http: ['GET', '/api/obsidian'],
      summary: '读取 obsidian 配置与解析后的路径（vault 来源、规范文档登记表、文档存在性）',
      run: (ctx) => service.get({ flagVault: ctx.vault }),
      render: (r) => lines(r).join('\n'),
    },
    {
      id: 'obsidian.set',
      cli: ['obsidian', 'set'],
      http: ['POST', '/api/obsidian'],
      summary:
        '写入 obsidian 配置（vault=<绝对路径> / docs.<key>=<相对vault根的路径>，可多个；空值=注销该登记项；白名单外的键被拒绝）',
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
        '取内容规范文档：不给 --doc 列出登记项；给了 --doc 直接输出该文档全文（skill 靠它拿「内容要求」）',
      flags: {
        doc: { type: 'string', hint: '登记项的 key（content / questionnaire …）' },
        vault: { type: 'string', hint: 'vault 绝对路径（覆盖配置）' },
      },
      run: (ctx) => service.spec({ doc: ctx.doc, flagVault: ctx.vault }),
      render: (r) => {
        if (r.configured === false) {
          return ['规范文档位置无法解析（vault 未设置）', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        if (r.content !== undefined) return r.content; // 全文原样输出——agent 直接读这段
        const out = [`vault: ${r.vault}`, `规范文档登记项（${r.docs.length}）:`];
        for (const d of r.docs) out.push(`  ${d.key.padEnd(16)} ${d.rel}  ${d.exists ? '【存在】' : '【缺失】'}`);
        for (const h of r.hints || []) out.push(`提示: ${h}`);
        return out.join('\n');
      },
    },
    {
      id: 'obsidian.read',
      cli: ['obsidian', 'read'],
      http: ['GET', '/api/obsidian/read'],
      summary:
        '读一篇 vault 笔记的内容（走与 scan 同一条解码链，GBK/BOM 免乱码；--from/--to 取行区间，行号可直接用于「文件:行号」引用）',
      flags: {
        file: { type: 'string', required: true, hint: '笔记路径（相对 vault 根）' },
        from: { type: 'number', hint: '起始行（1 起，含端点；缺省 = 1）' },
        to: { type: 'number', hint: '结束行（含端点；缺省 = 最后一行）' },
        vault: { type: 'string', hint: 'vault 绝对路径（覆盖配置）' },
      },
      run: (ctx) => service.read({ file: ctx.file, from: ctx.from, to: ctx.to, flagVault: ctx.vault }),
      render: (r) => {
        if (r.configured === false) {
          return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        return [
          `${r.file} · 第 ${r.from}-${r.to} 行 / 共 ${r.total} 行 · vault: ${r.vault}`,
          ...r.lines.map((l) => `${String(l.n).padStart(5)}  ${l.text}`),
        ].join('\n');
      },
    },
    {
      id: 'obsidian.scan',
      cli: ['obsidian', 'scan'],
      http: ['POST', '/api/obsidian/scan'],
      summary:
        '扫未解析双链（--project <项目根> 时只扫该项目的目录，多项目并发互不干扰；不带则扫全库）',
      flags: {
        project: { type: 'string', hint: '只扫这个项目的目录（vault 的 projects/<项目名>/）' },
        vault: { type: 'string', hint: 'vault 绝对路径（覆盖配置）' },
        out: { type: 'string', hint: '把结果写成 JSON 文件（相对 vault 根）' },
      },
      run: (ctx) => service.scan({ flagVault: ctx.vault, out: ctx.out, project: ctx.project }),
      render: (r) => {
        if (r.configured === false) {
          return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        const scopeLine = r.scope ? `范围: ${r.scope}（本项目）` : '范围: 全库';
        const out = [
          `vault: ${r.vault}`,
          `来源: ${r.via === 'cli' ? 'obsidian CLI' : '内置解析'}`,
          scopeLine,
          `未解析双链: ${r.count}`,
        ];
        for (const item of r.links) {
          const where = item.sources.map((s) => `${s.file}:${s.line}`).join(', ');
          out.push(`  [[${item.link}]]  ← ${where}`);
        }
        for (const h of r.hints || []) out.push(`提示: ${h}`);
        if (r.out) out.push(`已写出: ${r.out}`);
        return out.join('\n');
      },
    },
    {
      id: 'obsidian.frontmatter',
      cli: ['obsidian', 'frontmatter'],
      http: ['GET', '/api/obsidian/frontmatter'],
      summary:
        '生成新笔记的 frontmatter YAML 段（creatime / tags / bklink，可加 project=<项目根> 绑定代码库），可直接当 Write content 开头',
      flags: {
        link: { type: 'string', required: true, hint: '笔记名（双链文本）' },
        source: { type: 'string', hint: '引用了这个链接的源文件（相对 vault 根）' },
        locate: { type: 'boolean', hint: '扫全库找出所有引用源' },
        project: { type: 'string', hint: '项目解读模式：这篇文档讲的是哪个代码库（绝对路径）' },
        vault: { type: 'string', hint: 'vault 绝对路径（覆盖配置）' },
      },
      run: (ctx) =>
        service.frontmatter({
          link: ctx.link,
          source: ctx.source,
          locate: ctx.locate,
          project: ctx.project,
          flagVault: ctx.vault,
        }),
      render: (r) => {
        if (r.configured === false) {
          return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        return r.yaml;
      },
    },
    {
      id: 'obsidian.check',
      cli: [['obsidian', 'check'], ['obsidian', 'postcheck']],
      http: ['POST', '/api/obsidian/check'],
      summary:
        '校验新笔记有没有引入新的未解析双链（--snapshot 存快照；--snapshot-before + --new-file 做差分；--project 只 check 自己项目目录下的）',
      flags: {
        snapshot: { type: 'string', hint: '把当前未解析链接存到这个文件（相对 vault 根）' },
        'snapshot-before': { type: 'string', hint: '与这个快照文件比对' },
        'new-file': { type: 'string', hint: '刚写完的新文件（相对 vault 根，仅用于文案）' },
        project: { type: 'string', hint: '只 check 这个项目的目录（vault 的 projects/<项目名>/）' },
        vault: { type: 'string', hint: 'vault 绝对路径（覆盖配置）' },
      },
      run: (ctx) =>
        service.check({
          snapshot: ctx.snapshot,
          snapshotBefore: ctx['snapshot-before'],
          newFile: ctx['new-file'],
          flagVault: ctx.vault,
          project: ctx.project,
        }),
      render: (r) => {
        if (r.configured === false) {
          return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        if (r.mode === 'snapshot') {
          return `[SNAPSHOT] ${r.count} 个未解析双链已存到 ${r.snapshot}`;
        }
        if (r.passed) {
          return `[OK] 新文件 ${r.newFile} 未引入新的未解析双链`;
        }
        const out = [
          `[FAIL] 新文件 ${r.newFile} 引入了 ${r.newUnresolved.length} 个未解析双链：`,
          ...r.newUnresolved.map((x) => `  - [[${x.link}]]  (sources: ${JSON.stringify(x.sources)})`),
          '',
          '常见根因（按发生概率排序）：',
          ...ROOT_CAUSES.map((c, i) => `  ${i + 1}. ${c}`),
          '',
          '修复方式：用 Edit 把新文件里 [[<坏>]] 改成 [[<好>]]，然后再跑一次 check',
        ];
        return out.join('\n');
      },
    },
    {
      id: 'obsidian.ask',
      cli: ['obsidian', 'ask'],
      http: ['POST', '/api/obsidian/ask'],
      summary:
        '项目域提问的位置入口：定位/首次初始化 projects/<项目名>/Base-<项目名>.md，把提问清洗后以 [[…]] 追加到根文档末尾（幂等），并返回目标笔记的 frontmatter（bklink = 根文档 + 问题链接，project 绑定项目根）；除根文档外不创建任何树/索引/清单',
      flags: {
        question: { type: 'string', hint: '原始提问（不带 = 仅初始化根文档，项目解读首次建树用）' },
        project: { type: 'string', hint: '项目根绝对路径（缺省用当前目录）' },
        source: { type: 'string', hint: '问题出处（vault 内相对路径）——核对那篇文档里确实有这个双链' },
        vault: { type: 'string', hint: 'vault 绝对路径（覆盖配置）' },
      },
      run: (ctx) =>
        service.ask({ question: ctx.question, project: ctx.project, source: ctx.source, flagVault: ctx.vault }),
      render: (r) => {
        if (r.configured === false) {
          return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)].join('\n');
        }
        const baseState = r.base.created ? '（本次新建）' : '（已存在，原样使用）';
        const askLine = !r.question
          ? '提问       （未带 --question：仅初始化根文档）'
          : r.appended
            ? `提问       [[${r.question.link}]]  ← 追加到第 ${r.line} 行${r.question.rewritten ? `（原文「${r.question.original}」含非法字符，已清洗）` : ''}`
            : `提问       [[${r.question.link}]]  ← 已在第 ${r.line} 行（重复提问，未重复追加）`;
        const out = [
          `vault      ${r.vault}`,
          `项目       ${r.projectName}（${r.project}）`,
          `根文档     ${r.base.rel}${baseState}`,
          askLine,
        ];
        if (r.source) {
          out.push(
            `出处       ${r.source.rel}${r.source.hasLink ? ` 第 ${r.source.line} 行` : '（那里没有这个双链——请核对出处）'}`
          );
        }
        if (r.note) out.push(`答案笔记   ${r.note.path}`);
        for (const rel of r.relations || []) out.push(`关系       ${rel}`);
        out.push(
          '',
          '下一步（按 skill 标准 9 步走，占位全部用上面的值）:',
          `  ${r.next || `${APP_NAME} obsidian frontmatter --source ${r.base.rel} --project ${r.project}`}`,
          '  答案写到上面的「答案笔记」路径；除根文档外不要再创建任何文档树 / 索引 / 清单文件',
          '  正文必须是「回答这个问句」的实质内容（读源码 / 读资料后写出来的答案），',
          '  不是「这条问句是什么」的说明——后者等于把红链留着、把答案丢掉',
        );
        if (r.note && r.note.frontmatter) {
          out.push('', '目标笔记的 frontmatter（照抄，不要自己编）:', r.note.frontmatter);
        }
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
  // HTTP：body 里的键原样交给 service 去校验（白名单在 service 里）。
  for (const k of Object.keys(ctx)) {
    if (k === 'pairs') continue;
    patch[k] = ctx[k];
  }
  return patch;
}

const SOURCE_LABEL = {
  flag: '--vault 参数',
  store: 'store 配置',
  env: '环境变量 NX_OBSIDIAN_VAULT',
  kb: 'kb 登记库兜底',
  cwd: '当前目录向上找 .obsidian',
};

function lines(r) {
  if (!r.configured) {
    return ['vault 未设置', ...(r.hints || []).map((h) => `  ${h}`)];
  }
  const out = [
    `vault      ${r.vault}（来源: ${SOURCE_LABEL[r.source] || r.source || '未知'}）`,
    `  .obsidian  ${r.hasObsidianMarker ? '存在' : '未发现（不像 Obsidian vault）'}`,
  ];
  for (const d of r.docs || []) {
    out.push(`  ${d.key.padEnd(16)} ${d.rel}  ${d.exists ? '【存在】' : '【缺失】'}`);
  }
  for (const h of r.hints || []) out.push(`提示        ${h}`);
  return out;
}

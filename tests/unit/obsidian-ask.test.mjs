// obsidian 域：项目域提问入口（ask）。
//
// 这条命令是「位置的唯一事实源」——agent 不得自行决定答案笔记放哪、不得建树 / 索引。
// 所以这里钉的都是位置契约：Base 只在首次初始化时创建、提问追加幂等、清洗差异如实回报、
// 除 Base 外一个结构文件都不建。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

// 每次测试都把 store 指到临时目录 + 清掉 env 兜底，绝不碰用户真实数据。
function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-ask-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function fakeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-'));
  mkdirSync(join(dir, '.obsidian'));
  return dir;
}

function fakeProject(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-proj-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf8');
  }
  return dir;
}

// genFrontmatterYaml 把 Windows 路径的反斜杠按 YAML 规则翻倍——断言要按同样的形状比。
function yamlPath(p) {
  return `project: "${p.replace(/\\/g, '\\\\')}"`;
}

function listFilesDeep(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(p.slice(dir.length + 1).replace(/\\/g, '/'));
    }
  };
  walk(dir);
  return out.sort();
}

test('ask: vault 未设置是业务结果，不是错误', async () => {
  tmpData();
  const r = await obsidian.ask({ question: '这是框架是什么' });
  assert.equal(r.configured, false);
  assert.ok(r.hints.some((h) => h.includes('obsidian set')));
});

test('ask: 只有空白的提问 = 纯初始化模式（不带 --question 的等价形式）', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const project = fakeProject({ 'package.json': '{ "name": "nx-kn" }\n' });

  const r = await obsidian.ask({ question: '   ', project });

  assert.equal(r.question, null);
  assert.equal(r.appended, false);
  assert.equal(r.base.created, true, '空提问按「仅初始化」处理，Base 照常建');
});

test('ask: 项目目录不存在要如实报出来', async () => {
  tmpData();
  await obsidian.set({ patch: { vault: fakeVault() } });
  const missing = join(tmpdir(), 'nx-kn-no-such-project-xyz');
  await assert.rejects(() => obsidian.ask({ question: 'q', project: missing }), /项目目录不存在/);
});

test('ask: 首次提问 = 初始化 Base（frontmatter 带 project 绑定）+ 追加 [[提问]]，行号与路径都对', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const project = fakeProject({ 'package.json': '{ "name": "nx-kn" }\n' });

  const r = await obsidian.ask({ question: '这是框架是什么', project });

  assert.equal(r.projectName, 'nx-kn');
  assert.equal(r.base.rel, 'projects/nx-kn/Base-nx-kn.md');
  assert.equal(r.base.created, true);
  assert.equal(r.appended, true);
  assert.equal(r.duplicate, false);
  assert.equal(r.question.rewritten, false, '提问本身合法时不改写');
  assert.equal(r.note.path, 'projects/nx-kn/这是框架是什么.md');

  const text = readFileSync(r.base.abs, 'utf8');
  const lines = text.split('\n');
  assert.equal(lines[0], '---', 'Base 第一行必须是 frontmatter 起始');
  assert.ok(text.includes(yamlPath(project)), 'Base 的 frontmatter 必须绑定项目根');
  assert.ok(text.includes('# nx-kn'), 'Base 正文只有标题，不放清单 / 树 / 索引');
  assert.equal(lines[r.line - 1], '[[这是框架是什么]]', '返回的行号要正指向刚追加的那一行');

  // 除 Base 外一个文件都不建
  assert.deepEqual(listFilesDeep(join(vault, 'projects', 'nx-kn')), ['Base-nx-kn.md']);
});

test('ask: 同一提问重复提交不重复追加（幂等），行号指向已有那行', async () => {
  tmpData();
  await obsidian.set({ patch: { vault: fakeVault() } });
  const project = fakeProject();

  const first = await obsidian.ask({ question: '这是框架是什么', project });
  const before = readFileSync(first.base.abs, 'utf8');
  const second = await obsidian.ask({ question: '这是框架是什么', project });

  assert.equal(second.appended, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.line, first.line);
  assert.equal(readFileSync(second.base.abs, 'utf8'), before, '重复提问不得改动根文档');
});

test('ask: 不同提问依次追加到末尾，第二条紧跟着第一条', async () => {
  tmpData();
  await obsidian.set({ patch: { vault: fakeVault() } });
  const project = fakeProject();

  const first = await obsidian.ask({ question: '这是框架是什么', project });
  const second = await obsidian.ask({ question: '扫描怎么回退', project });
  const text = readFileSync(second.base.abs, 'utf8');
  const lines = text.split('\n');

  assert.ok(text.includes('[[这是框架是什么]]'));
  assert.equal(lines[first.line - 1], '[[这是框架是什么]]');
  assert.equal(second.line, first.line + 1, '第二条紧贴第一条的下一行');
  assert.equal(lines[second.line - 1], '[[扫描怎么回退]]');
});

test('ask: 提问里的非法字符由脚本清洗（rewritten:true），追加的是清洗后的链接', async () => {
  tmpData();
  await obsidian.set({ patch: { vault: fakeVault() } });
  const project = fakeProject();

  const r = await obsidian.ask({ question: '这是框架是什么?', project });

  assert.equal(r.question.original, '这是框架是什么?');
  assert.equal(r.question.link, '这是框架是什么');
  assert.equal(r.question.rewritten, true);
  const text = readFileSync(r.base.abs, 'utf8');
  assert.ok(text.includes('[[这是框架是什么]]'), '追加清洗后的链接（文件名才能解析它）');
  assert.ok(!text.includes('[[这是框架是什么?]]'), '不得把非法字符原样写进双链');
});

test('ask: Base 已存在时原样使用——不重写 frontmatter、不动已有内容', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const dir = join(vault, 'projects', 'handmade');
  mkdirSync(dir, { recursive: true });
  const base = join(dir, 'Base-handmade.md');
  writeFileSync(
    base,
    '---\ncreatime: 2020-01-01 00:00:00\ntags: []\nbklink: []\n---\n\n# 手工建的根\n\n[[已有模块]]\n',
    'utf8',
  );

  const project = fakeProject({ 'package.json': '{ "name": "handmade" }\n' });
  const r = await obsidian.ask({ question: '第二个问题', project });

  assert.equal(r.base.existed, true);
  assert.equal(r.base.created, false);
  const text = readFileSync(r.base.abs, 'utf8');
  assert.ok(text.startsWith('---\ncreatime: 2020-01-01'), '已有 frontmatter 不被重写');
  assert.ok(text.includes('[[已有模块]]'), '已有内容原样保留');
  assert.ok(text.includes('[[第二个问题]]'), '新提问追加在末尾');
});

test('ask: 项目名推导 —— package.json 优先且去掉 @scope；缺失时回退目录名', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });

  const withScope = fakeProject({ 'package.json': '{ "name": "@org/my-pkg" }\n' });
  const r1 = await obsidian.ask({ question: 'q1', project: withScope });
  assert.equal(r1.projectName, 'my-pkg');
  assert.equal(r1.base.rel, 'projects/my-pkg/Base-my-pkg.md');

  const bare = fakeProject();
  const r2 = await obsidian.ask({ question: 'q2', project: bare });
  assert.ok(r2.projectName.length > 0, '目录名兜底不为空');
  assert.equal(r2.base.rel, `projects/${r2.projectName}/Base-${r2.projectName}.md`);
});

test('ask: 不带提问 = 仅初始化根文档（项目解读首次建树的入口），不追加任何链接', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const project = fakeProject({ 'package.json': '{ "name": "nx-kn" }\n' });

  const r = await obsidian.ask({ project });

  assert.equal(r.question, null);
  assert.equal(r.appended, false);
  assert.equal(r.note, null);
  assert.equal(r.base.created, true);
  const text = readFileSync(r.base.abs, 'utf8');
  assert.ok(!text.includes('[['), '纯初始化不写任何双链');
});

// ---- 机制固化：ask 一次建立「Base ↔ 目标」与「出处文档 ↔ 目标」两条关系 ----

test('ask: 目标笔记的 frontmatter 由脚本给出（bklink = 根文档 + 问题链接，project 绑定项目根）', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const project = fakeProject({ 'package.json': '{ "name": "dataweb" }\n' });

  const r = await obsidian.ask({ question: '这是框架是什么', project });

  const fm = r.note.frontmatter;
  assert.ok(fm.startsWith('---\n'), 'frontmatter 以 --- 起始');
  assert.match(fm, /creatime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(fm, /tags: \[\]/);
  assert.match(fm, /- "\[\[Base-dataweb\]\]"/, 'bklink 第一项是根文档');
  assert.match(fm, /- "\[\[这是框架是什么\]\]"/, 'bklink 第二项是问题链接');
  assert.ok(fm.includes(yamlPath(project)), 'project 绑定项目根');
  assert.ok(fm.trimEnd().endsWith('---'), 'frontmatter 以 --- 收尾');
});

test('ask: 出处文档里本来就有这个双链 —— 两条关系并存，出处文档不被改动', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const project = fakeProject({ 'package.json': '{ "name": "dataweb" }\n' });

  // 用户在自己的笔记里写了 [[问题]]
  mkdirSync(join(vault, '日常'), { recursive: true });
  const srcRel = '日常/我的笔记.md';
  const srcAbs = join(vault, srcRel);
  writeFileSync(srcAbs, '疑问：[[这是框架是什么]]\n', 'utf8');
  const before = readFileSync(srcAbs, 'utf8');

  const r = await obsidian.ask({ question: '这是框架是什么', project, source: srcRel });

  assert.equal(r.source.rel, srcRel);
  assert.equal(r.source.hasLink, true, '出处文档里确实有这个双链');
  assert.equal(r.source.line, 1);
  assert.equal(r.appended, true, 'Base 侧仍然追加 —— 两条关系指向同一篇目标笔记');
  assert.ok(r.relations.some((x) => x.includes('Base ↔ 目标')));
  assert.ok(r.relations.some((x) => x.includes('出处 ↔ 目标')));
  assert.equal(readFileSync(srcAbs, 'utf8'), before, '出处文档不得被改动');

  // Base 与出处文档里都能看到同一个链接
  const baseText = readFileSync(r.base.abs, 'utf8');
  assert.ok(baseText.includes('[[这是框架是什么]]'), 'Base 里有这个链接');
});

test('ask: 给的出处里没有这个双链时如实报出来（不替 agent 圆场）', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  const project = fakeProject();

  mkdirSync(join(vault, '日常'), { recursive: true });
  writeFileSync(join(vault, '日常', '别的.md'), '与提问无关\n', 'utf8');

  const r = await obsidian.ask({ question: '这是框架是什么', project, source: '日常/别的.md' });

  assert.equal(r.source.hasLink, false);
  assert.equal(r.source.line, null);
  assert.ok(r.relations.some((x) => x.includes('请核对出处')));
});

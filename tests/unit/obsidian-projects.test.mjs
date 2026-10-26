// obsidian projects：「有哪些项目及其文档」的枚举指令。
//
// 这条指令的价值在于**不创建任何东西**——根文档的唯一入口是 ask。
// 所以测试里最要紧的一根钉子是「跑完 projects 之后，vault 一个文件都不多」；
// 其余是枚举口径：篇数 / 根文档检出 / 红链按项目分摊 / 标题取 H1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-obsidian-projects-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function fakeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-projects-'));
  mkdirSync(join(dir, '.obsidian'));
  return dir;
}

function note(vault, rel, text) {
  const abs = join(vault, ...rel.split('/'));
  mkdirSync(abs.slice(0, abs.lastIndexOf('\\')), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

function fm(bklink = []) {
  return [
    '---',
    'creatime: 2026-10-26 10:00:00',
    'tags: []',
    `bklink:${bklink.length ? '' : ' []'}`,
    ...bklink.map((b) => `  - "[[${b}]]"`),
    '---',
    '',
  ].join('\n');
}

test('projects: vault 未设置是业务结果（configured:false），不是错误', async () => {
  tmpData();
  const r = await obsidian.projects({});
  assert.equal(r.configured, false);
  assert.ok(Array.isArray(r.hints) && r.hints.length > 0);
});

test('projects: 没有 projects/ 目录时 count 0 + 给出建目录的唯一入口提示', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  const r = await obsidian.projects({});
  assert.equal(r.configured, true);
  assert.equal(r.count, 0);
  assert.deepEqual(r.projects, []);
  assert.match(r.hints[0], /ask --project/);
});

test('projects: 枚举项目、篇数、根文档、标题（跳过 frontmatter 与代码围栏）', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });

  note(vault, 'projects/alpha/Base-alpha.md', fm() + '# alpha\n');
  note(vault, 'projects/alpha/主题-总纲.md', fm(['Base-alpha']) + '# 主题系统总纲\n\n正文\n');
  // 围栏里那个 `# 假标题` 不能被当成标题
  note(
    vault,
    'projects/alpha/围栏.md',
    fm(['Base-alpha']) + '# 真标题\n\n```bash\n# 这是注释\n```\n'
  );
  // 没有 H1：退回文件名 stem，不能让整条指令失败
  note(vault, 'projects/alpha/无标题.md', fm(['Base-alpha']) + '正文只有一段\n');

  note(vault, 'projects/beta/data.md', fm() + '# 医疗数据\n');

  const r = await obsidian.projects({});
  assert.equal(r.count, 2);
  const alpha = r.projects.find((p) => p.name === 'alpha');
  const beta = r.projects.find((p) => p.name === 'beta');

  assert.equal(alpha.docs, 4);
  assert.equal(alpha.base, 'projects/alpha/Base-alpha.md');
  assert.deepEqual(
    alpha.documents.map((d) => d.title).sort(),
    ['alpha', '主题系统总纲', '无标题', '真标题'].sort()
  );
  assert.ok(alpha.updatedAt, 'updatedAt 应有时分秒');

  assert.equal(beta.docs, 1);
  assert.equal(beta.base, null, 'beta 没有 Base-beta.md');
  assert.equal(beta.documents[0].title, '医疗数据');
  assert.match(r.hints[0], /beta/, '缺根文档的项目要在提示里点名');
});

test('projects: 未解析链接按「源文件所属项目」分摊，同一链接引用多次只算一条', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });

  note(vault, 'projects/alpha/a.md', fm() + '# A\n\n[[不存在的链接]]\n');
  note(vault, 'projects/alpha/b.md', fm() + '# B\n\n[[不存在的链接]]\n');
  note(vault, 'projects/beta/c.md', fm() + '# C\n\n[[另一条红链]]\n');
  // 项目外的红链不归属任何项目
  note(vault, '散记.md', fm() + '# 散记\n\n[[库外红链]]\n');

  const r = await obsidian.projects({});
  const alpha = r.projects.find((p) => p.name === 'alpha');
  const beta = r.projects.find((p) => p.name === 'beta');
  assert.equal(alpha.unresolved, 1, '同一条红链被两篇引用，只算一条');
  assert.equal(beta.unresolved, 1);
});

test('projects: 从 Base 根文档读出代码库绑定；无根文档 / 无 project 行都是 null', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });

  // genFrontmatterYaml 写的是 JSON 风格双引号标量
  note(
    vault,
    'projects/alpha/Base-alpha.md',
    ['---', 'creatime: 2026-10-26 10:00:00', 'tags: []', 'bklink: []', 'project: "D:\\\\repos\\\\alpha"', '---', '', '# alpha', ''].join('\n')
  );
  note(vault, 'projects/alpha/a.md', fm() + '# A\n');
  // 有根文档但没有 project 行（手写的）
  note(vault, 'projects/beta/Base-beta.md', fm() + '# beta\n');
  // 完全没有根文档
  note(vault, 'projects/gamma/c.md', fm() + '# C\n');

  const r = await obsidian.projects({});
  const get = (n) => r.projects.find((p) => p.name === n);
  assert.equal(get('alpha').projectPath, 'D:\\repos\\alpha');
  assert.equal(get('beta').projectPath, null);
  assert.equal(get('gamma').projectPath, null);
});

test('projects: 只读——跑完不新增任何文件（根文档只由 ask 创建）', async () => {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  note(vault, 'projects/alpha/note.md', fm() + '# 笔记\n');

  const before = readdirSync(join(vault, 'projects', 'alpha')).sort();
  await obsidian.projects({});
  const after = readdirSync(join(vault, 'projects', 'alpha')).sort();

  assert.deepEqual(after, before, 'projects 不得创建根文档或其他文件');
  assert.ok(!after.includes('Base-alpha.md'));
});

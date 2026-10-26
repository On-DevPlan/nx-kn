// 项目名三级解析：显式（--project-name）> 已有根文档绑定 > 自动推导。
//
// 为什么这几条钉子必须存在：项目名同时决定三件事——vault 目录 `projects/<名>/`、
// 根文档 `Base-<名>.md`、以及每篇笔记 bklink 里的 `[[Base-<名>]]`。
// 推错一次不是「输出不好看」，而是该项目的整批笔记在同一秒集体变红链，
// 并且**全程不报错**（会安静地在旧目录旁边长出一棵新树）。
//
// 测试里的假代码库刻意让「目录名」与 package.json 的 name 不同——这正是真机上
// sedoc-fe-8.60（目录）vs sedoc-fe-1.0（包名）的错位。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-project-name-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function fakeVault() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-name-'));
  mkdirSync(join(dir, '.obsidian'));
  return dir;
}

// 假代码库：目录名 app-8.60，包名 app-1.0（两者不同才有区分度）
function fakeRepo({ dirName = 'app-8.60', pkgName = 'app-1.0' } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'nx-kn-repo-'));
  const dir = join(parent, dirName);
  mkdirSync(dir, { recursive: true });
  if (pkgName) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: pkgName }), 'utf8');
  return dir;
}

function writeNote(vault, rel, text) {
  const abs = join(vault, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
}

// 手工造根文档（模拟「历史绑定」）：project 值按 genFrontmatterYaml 的双引号写法
function baseDoc(repoAbs) {
  const escaped = String(repoAbs).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return ['---', 'creatime: 2026-10-26 10:00:00', 'tags: []', 'bklink: []', `project: "${escaped}"`, '---', '', '# 根', ''].join(
    '\n'
  );
}

async function setup() {
  const vault = fakeVault();
  tmpData();
  await obsidian.set({ patch: { vault } });
  return vault;
}

test('显式 --project-name 覆盖包名推导（目录名是人定的，不由 npm 包名决定）', async () => {
  await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });

  const r = await obsidian.ask({ project: repo, projectName: 'app-8.60' });

  assert.equal(r.projectName, 'app-8.60');
  assert.equal(r.projectNameSource, 'flag');
  assert.equal(r.base.rel, 'projects/app-8.60/Base-app-8.60.md');
  assert.equal(r.base.created, true);

  // 只有一棵树：没有 projects/app-1.0/ 这种按包名长出来的平行目录
  const listed = await obsidian.projects({});
  assert.deepEqual(
    listed.projects.map((p) => p.name),
    ['app-8.60']
  );
});

test('不带显式名字时沿用已有绑定（这一级防的是「忘带参数就分裂」）', async () => {
  await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });

  await obsidian.ask({ project: repo, projectName: 'app-8.60' }); // 首次：建树 + 写绑定
  const r = await obsidian.ask({ project: repo }); // 第二次：不带名字

  assert.equal(r.projectName, 'app-8.60', '绑定过就永远沿用，不能退回包名 app-1.0');
  assert.equal(r.projectNameSource, 'binding');
  assert.equal(r.base.created, false, '已有根文档，不应新建');
});

test('既无显式名字也无绑定时才回退推导（首次初始化）', async () => {
  await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });

  const r = await obsidian.ask({ project: repo });

  assert.equal(r.projectName, 'app-1.0', '推导规则仍是 package.json.name');
  assert.equal(r.projectNameSource, 'derived');
});

test('显式名字含路径分隔符直接报错（不静默截断成另一层目录）', async () => {
  await setup();
  const repo = fakeRepo();

  await assert.rejects(() => obsidian.ask({ project: repo, projectName: 'a/b' }), /路径分隔符/);
  await assert.rejects(() => obsidian.ask({ project: repo, projectName: 'a\\b' }), /路径分隔符/);
});

test('显式名字会被 sanitize 时直接报错（人要为准，脚本不替人改写）', async () => {
  await setup();
  const repo = fakeRepo();

  // `*` 在 ILLEGAL_NAME_RE 里：sanitizeName 会删掉它变成 app8，必须拒绝而不是照改
  await assert.rejects(() => obsidian.ask({ project: repo, projectName: 'app*8' }), /非法字符/);
});

test('目录已被另一个项目占用时报错，不覆盖别人的树', async () => {
  await setup();
  const repoA = fakeRepo({ dirName: 'repo-a', pkgName: 'pa' });
  const repoB = fakeRepo({ dirName: 'repo-b', pkgName: 'pb' });

  await obsidian.ask({ project: repoA, projectName: 'shared' });

  await assert.rejects(
    () => obsidian.ask({ project: repoB, projectName: 'shared' }),
    /已被另一个项目占用/
  );
});

test('目录存在但没有根文档时允许接管（无主笔记补项目身份的唯一路径）', async () => {
  const vault = await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });

  // 早期手写的笔记：有内容、没有 Base、没有 project 绑定
  writeNote(vault, 'projects/app-8.60/旧笔记.md', '# 旧笔记\n\n正文\n');

  const r = await obsidian.ask({ project: repo, projectName: 'app-8.60' });

  assert.equal(r.base.created, true);
  assert.equal(r.base.rel, 'projects/app-8.60/Base-app-8.60.md');
});

test('同一项目根被多个目录绑定时报错（一个项目两棵树要人来判断，脚本不挑）', async () => {
  const vault = await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });

  writeNote(vault, 'projects/甲/Base-甲.md', baseDoc(repo));
  writeNote(vault, 'projects/乙/Base-乙.md', baseDoc(repo));

  await assert.rejects(() => obsidian.ask({ project: repo }), /被多个目录绑定/);
  // 显式指定其中一个就放行——歧义由人消解
  const r = await obsidian.ask({ project: repo, projectName: '乙' });
  assert.equal(r.projectName, '乙');
  assert.equal(r.projectNameSource, 'flag');
});

test('scan / check 与 ask 用同一个名字（透传，不各自推导一次）', async () => {
  await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });
  await obsidian.ask({ project: repo, projectName: 'app-8.60' });

  const explicit = await obsidian.scan({ project: repo, projectName: 'app-8.60' });
  assert.equal(explicit.scope, 'projects/app-8.60');
  assert.equal(explicit.projectNameSource, 'flag');
  assert.equal(explicit.scopeExists, true);

  const bound = await obsidian.scan({ project: repo }); // 不传名字 → 沿用绑定
  assert.equal(bound.scope, 'projects/app-8.60');
  assert.equal(bound.projectNameSource, 'binding');
});

test('Windows 路径大小写不同仍认作同一个项目（否则绑定会静默失效）', async () => {
  if (process.platform !== 'win32') return; // 只有大小写不敏感的文件系统需要这条
  await setup();
  const repo = fakeRepo({ dirName: 'app-8.60', pkgName: 'app-1.0' });

  await obsidian.ask({ project: repo, projectName: 'app-8.60' });
  const r = await obsidian.ask({ project: repo.toUpperCase() });

  assert.equal(r.projectName, 'app-8.60');
  assert.equal(r.projectNameSource, 'binding');
});

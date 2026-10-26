// 项目迁移：export / import 的端到端行为。
//
// 迁移最怕的不是「报错」，而是**看起来成功了**：包是空的、少了几篇、project 绑定
// 指向上一台机器的路径、或者覆盖时把旧目录里的东西混进来。所以这里的钉子集中在
// 「导出的东西能被原样装回来」和「装不回来的时候一个字节都不写」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import { buildZip, readZip } from '../../src/core/zip.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-migrate-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function fakeVault(tag = 'v') {
  const dir = mkdtempSync(join(tmpdir(), `nx-kn-vault-${tag}-`));
  mkdirSync(join(dir, '.obsidian'));
  return dir;
}

function writeNote(vault, rel, text) {
  const abs = join(vault, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  return abs;
}

function baseDoc(name, projectAbs) {
  const escaped = String(projectAbs).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    '---',
    'creatime: 2026-10-26 10:00:00',
    'tags: []',
    'bklink: []',
    `project: "${escaped}"`,
    '---',
    '',
    `# ${name}`,
    '',
  ].join('\n');
}

// 造一个有 2 个项目的 vault：alpha 有根文档 + 2 篇，beta 只有 1 篇（无根文档）
function seedVault() {
  const vault = fakeVault('src');
  const alpha = 'D:\\repos\\alpha';
  writeNote(vault, 'projects/alpha/Base-alpha.md', baseDoc('alpha', alpha));
  writeNote(vault, 'projects/alpha/主题系统-总纲.md', '# 主题系统总纲\n\n正文 [[Base-alpha]]\n');
  writeNote(vault, 'projects/alpha/子目录/细节.md', '# 细节\n\n深一层\n');
  writeNote(vault, 'projects/beta/散记.md', '# 散记\n\n没有根文档的项目\n');
  return { vault, alpha };
}

async function useVault(vault) {
  clearCache();
  await obsidian.set({ patch: { vault } });
}

async function setup() {
  const dataDir = tmpData();
  const src = seedVault();
  await useVault(src.vault);
  const zipPath = join(dataDir, 'pack.zip');
  const r = await obsidian.exportProjects({ all: true, out: zipPath });
  return { ...src, dataDir, zipPath, exported: r };
}

test('导出：--all 打进全部项目，manifest 记录每个文件与 sha256', async () => {
  const { exported, zipPath } = await setup();

  assert.equal(exported.projects.length, 2);
  assert.equal(exported.fileCount, 4, 'alpha 3 篇 + beta 1 篇');
  assert.ok(exported.bytes > 0 && existsSync(zipPath));

  const entries = readZip(readFileSync(zipPath));
  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, [
    'manifest.json',
    'projects/alpha/Base-alpha.md',
    'projects/alpha/主题系统-总纲.md',
    'projects/alpha/子目录/细节.md',
    'projects/beta/散记.md',
  ]);

  const manifest = JSON.parse(entries.find((e) => e.name === 'manifest.json').data.toString('utf8'));
  assert.equal(manifest.format, 'nx-kn/projects');
  assert.equal(manifest.version, 1);
  const alpha = manifest.projects.find((p) => p.name === 'alpha');
  assert.equal(alpha.projectPath, 'D:\\repos\\alpha', 'project 绑定要进 manifest');
  assert.equal(alpha.files.length, 3);
  assert.ok(alpha.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256)));
});

test('往返：导出后导入另一个 vault，字节与 project 绑定全部一致', async () => {
  const { zipPath, vault: srcVault } = await setup();
  const dst = fakeVault('dst');
  await useVault(dst);

  const r = await obsidian.importProjects({ file: zipPath });
  assert.equal(r.imported.length, 2);

  const rels = [
    'projects/alpha/Base-alpha.md',
    'projects/alpha/主题系统-总纲.md',
    'projects/alpha/子目录/细节.md',
    'projects/beta/散记.md',
  ];
  for (const rel of rels) {
    assert.deepEqual(
      readFileSync(join(dst, ...rel.split('/'))),
      readFileSync(join(srcVault, ...rel.split('/'))),
      `${rel} 内容必须逐字节一致`
    );
  }
  // 目录结构（含子目录）
  assert.ok(readdirSync(join(dst, 'projects', 'alpha')).includes('子目录'));
  // 绑定原样保留（目标机器上这个路径可能不存在——那不归导入管，如实报告即可）
  assert.match(readFileSync(join(dst, 'projects', 'alpha', 'Base-alpha.md'), 'utf8'), /project: "D:\\\\repos\\\\alpha"/);
});

test('--name 只导一个项目；--name 与 --all 互斥', async () => {
  const { dataDir } = await setup();
  await useVault(seedVault().vault);

  const one = await obsidian.exportProjects({ names: 'alpha', out: join(dataDir, 'only-alpha.zip') });
  assert.deepEqual(one.projects.map((p) => p.name), ['alpha']);

  await assert.rejects(
    () => obsidian.exportProjects({ names: 'alpha', all: true, out: join(dataDir, 'x.zip') }),
    /只能给一个/
  );
  await assert.rejects(() => obsidian.exportProjects({ names: '不存在', out: join(dataDir, 'y.zip') }), /项目不存在/);
  // 「不给 --out」的默认落点在 api-transfer.test.mjs 里钉（要 chdir 到临时目录，别污染仓库）
});

test('同名冲突：默认整体拒绝，且一个文件都不写', async () => {
  const { zipPath } = await setup();
  const dst = fakeVault('conflict');
  writeNote(dst, 'projects/alpha/旧内容.md', '# 旧内容\n');
  await useVault(dst);

  await assert.rejects(() => obsidian.importProjects({ file: zipPath }), /已存在同名项目/);

  // 只留下原来那一个文件，没有被塞进半截新内容
  assert.deepEqual(readdirSync(join(dst, 'projects', 'alpha')), ['旧内容.md']);
  assert.ok(!existsSync(join(dst, 'projects', 'beta')), 'beta 也不该被写进去（整体拒绝）');
});

test('--force 覆盖并按项目整目录备份旧内容', async () => {
  const { zipPath } = await setup();
  const dst = fakeVault('force');
  writeNote(dst, 'projects/alpha/旧内容.md', '# 旧内容\n');
  await useVault(dst);

  const r = await obsidian.importProjects({ file: zipPath, force: true });

  assert.ok(r.backup, '覆盖必须留备份');
  assert.ok(
    existsSync(join(r.backup, 'alpha', '旧内容.md')),
    '旧目录要整份进备份（不是只备份 model 层）'
  );
  assert.ok(!existsSync(join(dst, 'projects', 'alpha', '旧内容.md')), '覆盖 = 替换，旧文件不该残留');
  assert.ok(existsSync(join(dst, 'projects', 'alpha', 'Base-alpha.md')));
});

test('--dry-run 只规划：不写盘，且如实标出会覆盖哪些', async () => {
  const { zipPath } = await setup();
  const dst = fakeVault('dry');
  writeNote(dst, 'projects/alpha/旧内容.md', '# 旧内容\n');
  await useVault(dst);

  const r = await obsidian.importProjects({ file: zipPath, dryRun: true });
  assert.equal(r.dryRun, true);
  assert.deepEqual(r.wouldOverwrite, ['alpha']);
  assert.equal(readdirSync(join(dst, 'projects', 'alpha')).length, 1, 'dry-run 不得改动磁盘');
  assert.ok(!existsSync(join(dst, 'projects', 'beta')));
});

test('内容被篡改（哈希不符）→ 拒绝，不写任何文件', async () => {
  const { zipPath, dataDir } = await setup();
  const entries = readZip(readFileSync(zipPath));
  const tampered = entries.map((e) =>
    e.name === 'projects/alpha/主题系统-总纲.md'
      ? { name: e.name, data: Buffer.from('# 被改过的内容\n', 'utf8'), mtime: e.mtime }
      : { name: e.name, data: e.data, mtime: e.mtime }
  );
  const badPath = join(dataDir, 'tampered.zip');
  writeFileSync(badPath, buildZip(tampered));

  const dst = fakeVault('tampered');
  await useVault(dst);

  await assert.rejects(() => obsidian.importProjects({ file: badPath }), /哈希不符/);
  assert.ok(!existsSync(join(dst, 'projects')), '校验失败时连目录都不该建');
});

test('manifest 之外的多余条目：忽略并报告，不落盘', async () => {
  const { zipPath, dataDir } = await setup();
  const entries = readZip(readFileSync(zipPath));
  const extra = [...entries, { name: 'projects/alpha/偷偷加的.md', data: Buffer.from('# x\n'), mtime: new Date() }];
  const withExtra = join(dataDir, 'extra.zip');
  writeFileSync(withExtra, buildZip(extra));

  const dst = fakeVault('extra');
  await useVault(dst);
  const r = await obsidian.importProjects({ file: withExtra });

  assert.deepEqual(r.ignored, ['projects/alpha/偷偷加的.md']);
  assert.ok(!existsSync(join(dst, 'projects', 'alpha', '偷偷加的.md')));
});

test('--project-path 只改写 Base 的 project 行，其他笔记字节不动', async () => {
  const { zipPath } = await setup();
  const dst = fakeVault('rewrite');
  const newRepo = fakeVault('newrepo');
  await useVault(dst);

  const r = await obsidian.importProjects({ file: zipPath, projectPath: newRepo });
  const alpha = r.imported.find((p) => p.name === 'alpha');
  assert.equal(alpha.projectPathRewritten, true);

  const base = readFileSync(join(dst, 'projects', 'alpha', 'Base-alpha.md'), 'utf8');
  assert.ok(base.includes(newRepo.replace(/\\/g, '\\\\')), 'Base 应绑定到新路径');
  assert.ok(!base.includes('D:\\\\repos\\\\alpha'), '旧路径要被替换掉');

  // 非 Base 文件不做任何改写
  assert.equal(
    readFileSync(join(dst, 'projects', 'alpha', '主题系统-总纲.md'), 'utf8'),
    '# 主题系统总纲\n\n正文 [[Base-alpha]]\n'
  );
});

test('--project-path 指向不存在的目录 → 报错（不写坏绑定）', async () => {
  const { zipPath } = await setup();
  const dst = fakeVault('badpath');
  await useVault(dst);

  await assert.rejects(
    () => obsidian.importProjects({ file: zipPath, projectPath: join(dst, '不存在的代码库') }),
    /--project-path 指向的目录不存在/
  );
});

test('不是迁移包 / 文件不存在 → 明确报错', async () => {
  const { dataDir } = await setup();
  const dst = fakeVault('bad');
  await useVault(dst);

  await assert.rejects(() => obsidian.importProjects({ file: join(dataDir, '没有这个.zip') }), /zip 不存在/);

  const plain = join(dataDir, 'plain.zip');
  writeFileSync(plain, buildZip([{ name: 'readme.md', data: '# 普通 zip\n' }]));
  await assert.rejects(() => obsidian.importProjects({ file: plain }), /缺 manifest\.json/);
});

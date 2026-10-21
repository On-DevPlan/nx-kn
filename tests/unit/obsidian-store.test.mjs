// obsidian 域：vault 定位与「内容规范文档」路径解析的规则钉死。
//
// 这套规则错在哪都不会报错，只会**静默地写错笔记**：
// 规范解析到错的文件 → agent 按另一套内容风格写；vault 指错 → 规范路径整个落空。
// 所以每条边界都用测试钉住，尤其是三条：
//   1. 兜底只在「未设置」时发生，不在「设了但坏了」时发生（否则配置错误被藏起来）
//   2. 未设置是**业务结果**不是错误（skill 侧只需判标志位）
//   3. 归一化永不抛（它跑在每次 loadStore 里，包括 store 损坏隔离那条路径）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, initialState, mutateStore, normalize } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

// 每次测试都把 store 指到临时目录 + 清掉 env 兜底，绝不碰用户真实数据。
function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-obsidian-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

// 一个「像样的 vault」：有 .obsidian/，有 nx-kn/ 规范目录与两份规范文档。
function fakeVault(withDocs = true) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-'));
  mkdirSync(join(dir, '.obsidian'));
  mkdirSync(join(dir, 'nx-kn'));
  if (withDocs) {
    writeFileSync(join(dir, 'nx-kn', 'base-content.md'), '# 内容生成规范\n', 'utf8');
    writeFileSync(join(dir, 'nx-kn', 'questionnaire.md'), '# 问卷模式 · 内容规范\n', 'utf8');
  }
  return dir;
}

// ---- 归一化：形状与垃圾输入 ----

test('initialState() 的 obsidian 形状固定（默认值即 vault 现状的约定位置）', () => {
  assert.deepEqual(initialState().obsidian, {
    vault: '',
    specDir: 'nx-kn',
    contentDoc: 'base-content.md',
    questionnaireDoc: 'questionnaire.md',
  });
});

test('normalize: obsidian 缺字段逐个补默认，部分键不影响其余键', () => {
  const n = normalize({ obsidian: { vault: 'D:\\V' } });
  assert.equal(n.obsidian.vault, 'D:\\V');
  assert.equal(n.obsidian.specDir, 'nx-kn');
  assert.equal(n.obsidian.contentDoc, 'base-content.md');
  assert.equal(n.obsidian.questionnaireDoc, 'questionnaire.md');
});

test('normalize: obsidian 是垃圾输入时回落默认且**不抛**（normalize 跑在每次 load 里）', () => {
  for (const garbage of [null, undefined, 'garbage', 42, [], true]) {
    const n = normalize({ obsidian: garbage });
    assert.deepEqual(n.obsidian, initialState().obsidian);
  }
});

test('normalize: specDir 的反斜杠归一为 /（跨平台同一份配置）', () => {
  assert.equal(normalize({ obsidian: { specDir: 'a\\b' } }).obsidian.specDir, 'a/b');
});

// ---- vault 解析链 ----

test('vault 解析：store 配置 > 环境变量 > kb 登记库兜底', async () => {
  const dir = tmpData();
  const envVault = fakeVault();
  const kbVault = fakeVault();

  // 1) 什么都没设 → 未设置（业务结果，不是错误）
  let r = await obsidian.resolvePaths();
  assert.equal(r.configured, false);
  assert.equal(r.vault, null);
  assert.ok(r.hints.some((h) => h.includes('obsidian set')), '未设置时要给出可照做的提示');

  // 2) kb 兜底：只有含 .obsidian/ 的登记库算数
  await mutateStore((s) => {
    s.kb.vaults.push({ path: join(dir, 'not-a-vault') });
    s.kb.vaults.push({ path: kbVault });
  });
  r = await obsidian.resolvePaths();
  assert.equal(r.source, 'kb');
  assert.equal(r.vault, kbVault);

  // 3) 环境变量压过 kb 兜底
  process.env.NX_OBSIDIAN_VAULT = envVault;
  r = await obsidian.resolvePaths();
  assert.equal(r.source, 'env');
  assert.equal(r.vault, envVault);

  // 4) store 配置压过环境变量
  await mutateStore((s) => {
    s.obsidian.vault = kbVault;
  });
  r = await obsidian.resolvePaths();
  assert.equal(r.source, 'store');
  assert.equal(r.vault, kbVault);
});

test('vault 设了但目录被删：如实报 vaultExists=false，**不静默兜底到别的库**', async () => {
  tmpData();
  const gone = join(tmpdir(), 'nx-kn-vault-gone-' + Date.now());
  const kbVault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = gone;
    s.kb.vaults.push({ path: kbVault });
  });

  const r = await obsidian.resolvePaths();
  assert.equal(r.configured, true);
  assert.equal(r.source, 'store', '来源仍是 store——不能悄悄换成 kb 兜底');
  assert.equal(r.vaultExists, false);
  assert.ok(r.hints.some((h) => h.includes('不存在')), '要明确报「目录不存在」');
});

// ---- 规范文档解析 ----

test('规范文档解析：默认落在 <vault>/nx-kn/ 下两份文件，存在性如实反映', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.resolvePaths();
  assert.equal(r.specDir, join(vault, 'nx-kn'));
  assert.equal(r.specDirExists, true);
  assert.equal(r.docs.length, 2);
  assert.deepEqual(r.docs.map((d) => d.key), ['content', 'questionnaire']);
  assert.equal(r.docs[0].path, join(vault, 'nx-kn', 'base-content.md'));
  assert.equal(r.docs[0].exists, true);
  assert.equal(r.docs[1].exists, true);
  assert.equal(r.hints.length, 0, '一切正常时不该有提示');
});

test('规范文档缺失：指名对应的配置键，别让人猜', async () => {
  tmpData();
  const vault = fakeVault(false); // 一份文档都不写
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.resolvePaths();
  assert.equal(r.docs.every((d) => d.exists === false), true);
  assert.ok(r.hints.some((h) => h.includes('contentDoc')));
  assert.ok(r.hints.some((h) => h.includes('questionnaireDoc')));
});

test('spec() 是给 agent 的最小契约：形状固定，没问题时不带 hints', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const ok = await obsidian.spec();
  assert.equal(ok.configured, true);
  assert.equal(ok.vault, vault);
  assert.deepEqual(Object.keys(ok.docs[0]).sort(), ['doc', 'exists', 'key', 'path']);
  assert.equal('hints' in ok, false, '一切正常时不该出现 hints 字段');

  const un = await obsidian.spec();
  assert.equal(un.configured, true, '此时仍已配置');

  // 清掉 vault → 未设置是**业务结果**（不抛），带可照做的 hints
  await obsidian.set({ patch: { vault: '' } });
  const un2 = await obsidian.spec();
  assert.equal(un2.configured, false);
  assert.ok(Array.isArray(un2.hints) && un2.hints.length > 0);
});

// ---- set 的写入口校验 ----

test('set: 未知键被拒绝（白名单外的键不进 store）', async () => {
  tmpData();
  await assert.rejects(
    () => obsidian.set({ patch: { hacker: 'yes' } }),
    (e) => e.code === 'INVALID_INPUT' && /未知的 obsidian 配置键/.test(e.message)
  );
});

test('set: specDir 拒绝绝对路径与 ..（规范文档必须在 vault 内）', async () => {
  tmpData();
  await assert.rejects(
    () => obsidian.set({ patch: { specDir: 'C:\\elsewhere' } }),
    (e) => e.code === 'INVALID_INPUT' && /必须是相对路径/.test(e.message)
  );
  await assert.rejects(
    () => obsidian.set({ patch: { specDir: 'a/../b' } }),
    (e) => e.code === 'INVALID_INPUT' && /\.\./.test(e.message)
  );
});

test('set: 文档名不许带路径分隔符（裸文件名）', async () => {
  tmpData();
  await assert.rejects(
    () => obsidian.set({ patch: { contentDoc: 'a/b.md' } }),
    (e) => e.code === 'INVALID_INPUT' && /路径分隔符/.test(e.message)
  );
});

test('set: vault 目录不存在时报 NOT_FOUND（把路径原样回显，便于找出笔误）', async () => {
  tmpData();
  const missing = join(tmpdir(), 'nx-kn-no-such-vault-' + Date.now());
  await assert.rejects(
    () => obsidian.set({ patch: { vault: missing } }),
    (e) => e.code === 'NOT_FOUND' && /不存在/.test(e.message)
  );
});

test('set: 写入后落盘，空值即复位', async () => {
  tmpData();
  const vault = fakeVault();
  const r = await obsidian.set({ patch: { vault } });
  assert.deepEqual(r.written, ['vault']);
  assert.equal(r.configured, true);

  const onDisk = JSON.parse(readFileSync(process.env.NX_KN_STORE, 'utf8'));
  assert.equal(onDisk.obsidian.vault, vault);
  assert.equal(onDisk.obsidian.specDir, 'nx-kn');

  // 空值 = 清除：回到未设置
  await obsidian.set({ patch: { vault: '' } });
  const after = await obsidian.resolvePaths();
  assert.equal(after.configured, false);
});

test('set: 文档名可改，规范目录跟着换（识别路径完全可配）', async () => {
  tmpData();
  const vault = fakeVault();
  mkdirSync(join(vault, 'docs'), { recursive: true });
  writeFileSync(join(vault, 'docs', 'style.md'), '# 风格\n', 'utf8');

  await obsidian.set({ patch: { vault, specDir: 'docs', contentDoc: 'style.md' } });
  const r = await obsidian.resolvePaths();
  assert.equal(r.specDir, join(vault, 'docs'));
  assert.equal(r.docs[0].path, join(vault, 'docs', 'style.md'));
  assert.equal(r.docs[0].exists, true);
  assert.equal(r.docs[1].exists, false, '问卷文档没搬过来 → 如实报缺失');
});

// kb 存储结构的迁移断言。
//
// 为什么值得单独成文：`kb.vault`（单值）→ `kb.vaults`（数组）是一次**静默迁移**——
// 迁移失败不会报错，只会让用户的已配置知识库凭空消失（列表变空、面板显示「未设定」），
// 而 store.json 看起来仍然是「有内容的 JSON」。所以把迁移规则钉在这里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearCache,
  initialState,
  loadStore,
  mutateStore,
  normalize,
  normalizeKb,
  storeRecovery,
} from '../../src/core/store.js';

test('normalizeKb: 旧结构（单值 vault）迁移为单元素数组', () => {
  const kb = normalizeKb({ vault: 'D:\\Notes\\MyVault' });
  assert.deepEqual(kb, {
    vaults: [
      { path: 'D:\\Notes\\MyVault', name: 'MyVault', model: null, addedAt: null, origin: null },
    ],
  });
});

test('normalizeKb: 旧结构的全局 model **不迁移**（已知脏值，不能升级成建索引参数）', () => {
  // 背景：旧 kb.model 是全局单值，`kb use` 切库时被原样保留，会出现
  // 「store 记着 A 模型、磁盘上没有任何 A 模型的索引」这种状态（本机真实发生过）。
  // 因此迁移只带 path/name，模型留给 DEFAULT_EMBEDDING 与面板去决定。
  const kb = normalizeKb({ vault: 'D:\\A', model: 'local/potion-code-16m-v2' });
  assert.equal(kb.vaults[0].model, null, '旧全局 model 必须被丢弃，不得静默生效');
  assert.equal(kb.vaults[0].path, 'D:\\A', 'path 必须保住（迁移的核心目的）');
});

test('normalizeKb: 新结构里的每库 model 照常保留（只有旧全局字段才丢）', () => {
  const kb = normalizeKb({ vaults: [{ path: 'D:\\A', model: 'local/qwen3-embedding-0.6b' }] });
  assert.equal(kb.vaults[0].model, 'local/qwen3-embedding-0.6b');
});

test('normalizeKb: 旧结构迁移后不再保留 vault / model 两个旧键', () => {
  const kb = normalizeKb({ vault: '/home/u/notes', model: 'm' });
  assert.equal('vault' in kb, false, '旧键留着会让「以哪个为准」变成悬而未决的问题');
  assert.equal('model' in kb, false);
});

test('normalizeKb: 新结构原样保留（含 name 与 addedAt）', () => {
  const kb = normalizeKb({
    vaults: [{ path: 'D:\\A', name: '甲库', model: 'local/x', addedAt: '2026-10-04T00:00:00Z' }],
  });
  assert.deepEqual(kb.vaults, [
    { path: 'D:\\A', name: '甲库', model: 'local/x', addedAt: '2026-10-04T00:00:00Z', origin: null },
  ]);
});

test('normalizeKb: 新结构缺 name / model / addedAt 时给安全默认', () => {
  const kb = normalizeKb({ vaults: ['D:\\DevProjects\\my\\github\\nx-kn-smoke'] });
  assert.deepEqual(kb.vaults, [
    {
      path: 'D:\\DevProjects\\my\\github\\nx-kn-smoke',
      name: 'nx-kn-smoke',
      model: null,
      addedAt: null,
      origin: null,
    },
  ]);
});

test('normalizeKb: 按绝对路径去重（旧单值与新数组指向同一目录只留一条）', () => {
  const kb = normalizeKb({
    vault: 'D:\\A',
    vaults: [{ path: 'D:\\A' }, { path: 'D:\\B' }],
  });
  assert.deepEqual(kb.vaults.map((v) => v.path), ['D:\\A', 'D:\\B']);
});

test('normalizeKb: 空值 / 垃圾输入 / 无 path 的记录被安全丢弃（不抛）', () => {
  for (const bad of [undefined, null, 'string', 42, {}, { vault: '' }, { vault: '   ' }]) {
    assert.deepEqual(normalizeKb(bad).vaults, [], `输入 ${JSON.stringify(bad)} 应得到空列表`);
  }
  assert.deepEqual(normalizeKb({ vaults: [{ name: '无路径' }, null] }).vaults, []);
});

test('normalize: 顶层走通——老 store.json 整体迁移后 kb.vaults 有值', () => {
  const out = normalize({
    version: 1,
    settings: { theme: 'dark' },
    kb: { vault: 'D:\\Obsidian Vault', model: 'local/potion-code-16m-v2' },
  });
  assert.equal(out.settings.theme, 'dark');
  assert.equal(out.kb.vaults.length, 1);
  assert.equal(out.kb.vaults[0].path, 'D:\\Obsidian Vault');
  assert.equal(out.kb.vaults[0].name, 'Obsidian Vault');
});

test('normalize: initialState() 的 kb 形状是空数组（不是 null）', () => {
  assert.deepEqual(initialState().kb, { vaults: [] });
  // 泛型分支不能把 kb 覆盖掉：显式传一个含 kb 的假数据再确认
  assert.deepEqual(normalize({ kb: null }).kb, { vaults: [] });
});

// ---- 落盘往返：迁移是「惰性」的 ----
// 读命令（status / query / list）只 normalize 内存里的对象、**不写盘**——
// 读操作去改用户的文件是个坏习惯。所以磁盘上的老结构会一直留到下一次写入为止。
// 这条语义不写下来很容易被「优化」掉，因此用真实文件钉住。

test('迁移是惰性的：读只改内存，首次写入才落盘并丢掉旧 kb.vault / kb.model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-store-'));
  const p = join(dir, 'store.json');
  writeFileSync(
    p,
    JSON.stringify({ version: 1, settings: {}, kb: { vault: 'D:\\A', model: 'legacy/x' } }),
    'utf8'
  );

  clearCache();
  const loaded = await loadStore(p);
  assert.deepEqual(loaded.kb.vaults.map((v) => v.path), ['D:\\A'], '内存里已经迁移成列表');

  const onDisk = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(onDisk.kb.vault, 'D:\\A', '读命令不得写盘（磁盘仍是老结构）');
  assert.equal('vaults' in onDisk.kb, false);

  // 第一次写入：迁移结果随写入一起落盘，旧键被丢掉
  await mutateStore((s) => {
    s.kb.vaults.push({ path: 'D:\\B' });
  }, p);

  const after = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(after.kb.vaults.map((v) => v.path), ['D:\\A', 'D:\\B']);
  assert.equal('vault' in after.kb, false, '首次写入后旧 kb.vault 不应再出现');
  assert.equal('model' in after.kb, false, '首次写入后旧 kb.model 不应再出现');
  assert.deepEqual(
    after.kb.vaults[1],
    { path: 'D:\\B', name: 'B', model: null, addedAt: null, origin: null },
    '新增记录落盘时会被补齐默认字段'
  );
});

// ---- 损坏的 store.json：绝不静默覆盖 ----
//
// 背景（本机真实发生过）：改造前 `loadStore` 把「文件不存在」与「JSON 坏了」放在
// 同一个 catch 分支里，都返回空结构。后果不是「读到空列表」这么轻——
// 下一次任意写操作（kb add / index / settings set）都会 mutateStore，
// 于是那份空结构被原子写回原路径，**原文件内容不可恢复，且全程零报错**。
// 当时是靠目录里一份人工备份 store.json.bak-20261004 才救回来的。

test('store.json 损坏：留备份 + 按空结构继续，原文件不失联', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-store-bad-'));
  const p = join(dir, 'store.json');
  const garbage = '{"version":1,"kb":{"vaults":[  ← 截断的 JSON';
  writeFileSync(p, garbage, 'utf8');

  clearCache();
  assert.equal(storeRecovery(), null, '还没读，不该有隔离记录');

  const loaded = await loadStore(p);
  assert.deepEqual(loaded.kb.vaults, [], '读出来的应是空结构（继续可用）');

  const rec = storeRecovery();
  assert.ok(rec, '必须留下隔离记录（否则这次隔离只存在于 stderr 里）');
  assert.equal(rec.path, p);
  assert.match(rec.backup, /\.corrupt-\d{8}T\d{6}Z$/, `备份名应带时间戳: ${rec.backup}`);
  assert.ok(existsSync(rec.backup), '备份文件必须真的存在');
  assert.equal(readFileSync(rec.backup, 'utf8'), garbage, '备份必须是原文件内容的完整副本');
  assert.equal(existsSync(p), false, '坏文件应被挪走，否则下次读又会走一遍这个分支');
});

test('损坏之后的一次写入不会毁掉原内容（这是这条修复的全部意义）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-store-bad-'));
  const p = join(dir, 'store.json');
  const broken = '{"version":1,"kb":{"vault":"D:\\\\OldVault"}'; // 断了
  writeFileSync(p, broken, 'utf8');

  clearCache();
  assert.equal(storeRecovery(), null);

  await loadStore(p);
  const backup = storeRecovery().backup;

  // 用户随后的正常写操作
  await mutateStore((s) => {
    s.kb.vaults.push({ path: 'D:\\NewVault' });
  }, p);

  const now = JSON.parse(readFileSync(p, 'utf8'));
  assert.deepEqual(now.kb.vaults.map((v) => v.path), ['D:\\NewVault']);
  assert.equal(
    readFileSync(backup, 'utf8'),
    broken,
    '原内容必须还在备份里——以前的实现会在这一步把它永久覆盖掉'
  );
});

test('文件不存在（首次运行）不算损坏：不产备份、不留隔离记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-store-new-'));
  const p = join(dir, 'store.json');

  clearCache();
  const loaded = await loadStore(p);
  assert.deepEqual(loaded, initialState(), '首次运行应拿到 initialState()');
  assert.equal(storeRecovery(), null, '「文件不存在」与「JSON 坏了」是两件事');
  assert.deepEqual(
    readdirSync(dir).filter((f) => f.includes('corrupt')),
    [],
    '不该凭空造出备份文件'
  );
});

test('空字符串 / 空白文件（JSON.parse 必失败）也走隔离，不是「空结构」', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-store-empty-'));
  const p = join(dir, 'store.json');
  writeFileSync(p, '   \n', 'utf8');

  clearCache();
  await loadStore(p);
  assert.ok(storeRecovery(), '空白文件不是合法 JSON，同样要留备份而不是静默当空');
  assert.equal(storeRecovery().backup.includes('.corrupt-'), true);
});

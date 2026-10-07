// 「抓取产物」与「它的源目录」之间的谱系判定，以及由此派生的「默认不参与检索」。
//
// 为什么值得单独成文：这条规则一旦判错，两种坏结果都是静默的——
//   判宽了（把不该收的收起来）→ 内容**凭空消失**：用户登记了库，检索却永远扫不到它。
//   判严了（该收的没收）→ 同一篇笔记出两条命中，白占 --limit 名额（本机真实发生过）。
// 两种都不会报错，只会让人觉得「这工具搜不准」。所以把边界逐条钉住。
//
// 判据的核心是「不猜」：产物目录 = sourceDirOf(源名)，源目录 = 源的 url（本地目录源），
// 两条都是我们自己写下的值，因此不需要内容相似度这种模糊手段。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  clearCache,
  crawlProductVaults,
  loadStore,
  normalize,
  standbyVaults,
} from '../../src/core/store.js';
import { add as kbAdd, resolveVaults } from '../../src/modules/kb/service.js';

// sourcesDir() 跟着 store.json 走（见 core/paths.js），所以把 NX_KN_STORE 指到临时目录，
// 就同时隔离了「库列表」与「采集产物」，不会碰到用户的真实数据。
function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-lineage-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  clearCache();
  return dir;
}

function storeOf({ vaults = [], sources = [] }) {
  return normalize({ version: 1, settings: {}, kb: { vaults }, crawl: { sources } });
}

// ---- crawlProductVaults：哪些库是「某个源的产物」 ----

test('本地目录源的产物 ←→ 其源库：构成一条谱系边', () => {
  const dir = tmpData();
  const vault = join(dir, 'Obsidian Vault');
  const product = join(dir, 'sources', 'obsidian-vault'); // 与 sourceDirOf() 同构
  const store = storeOf({
    vaults: [{ path: vault }, { path: product }],
    sources: [{ name: 'obsidian-vault', url: vault, kind: 'local' }],
  });

  const edges = crawlProductVaults(store);
  assert.equal(edges.size, 1, '产物与其源库都在列表里 → 恰好一条边');
  assert.equal(edges.get(resolve(product)), resolve(vault));
});

test('web 源不算重复：源是网址、不是本地库，产物就是唯一副本', () => {
  const dir = tmpData();
  const product = join(dir, 'sources', 'vitepress');
  const store = storeOf({
    vaults: [{ path: product }],
    sources: [{ name: 'vitepress', url: 'https://vitepress.dev/guide/', kind: 'web' }],
  });

  assert.equal(crawlProductVaults(store).size, 0, '把产物收起来 = 抓来的文档再也搜不到');
});

test('本地目录源但源目录从未登记：不算重复（否则内容凭空消失）', () => {
  const dir = tmpData();
  const product = join(dir, 'sources', 'notes');
  const store = storeOf({
    vaults: [{ path: product }],
    sources: [{ name: 'notes', url: join(dir, 'Notes'), kind: 'local' }],
  });

  assert.equal(crawlProductVaults(store).size, 0, '源库不在列表里就没人替它，产物必须继续参与');
});

test('产物目录没登记：无所谓重复', () => {
  const dir = tmpData();
  const vault = join(dir, 'Obsidian Vault');
  const store = storeOf({
    vaults: [{ path: vault }],
    sources: [{ name: 'obsidian-vault', url: vault, kind: 'local' }],
  });

  assert.equal(crawlProductVaults(store).size, 0);
});

test('源就是产物（病态数据）不构成「两份」', () => {
  const dir = tmpData();
  const product = join(dir, 'sources', 'self');
  const store = storeOf({
    vaults: [{ path: product }],
    sources: [{ name: 'self', url: product, kind: 'local' }],
  });

  assert.equal(crawlProductVaults(store).size, 0, '同一个目录不能既是被收起的又是收它的理由');
});

// ---- standbyVaults：谁被默认排除 ----

test('origin: 抓取自动登记的产物被排除；历史数据（未记录）由谱系兜底同样排除', () => {
  const dir = tmpData();
  const vault = join(dir, 'Vault');
  const product = join(dir, 'sources', 'v');
  const store = storeOf({
    vaults: [{ path: vault }, { path: product, origin: 'crawl' }],
    sources: [{ name: 'v', url: vault, kind: 'local' }],
  });

  const out = standbyVaults(store);
  assert.equal(out.size, 1);
  assert.equal(out.get(resolve(product)), resolve(vault));
});

test('origin: 用户显式 kb add 过的库**永不**被自动排除（哪怕它长得像产物）', () => {
  const dir = tmpData();
  const vault = join(dir, 'Vault');
  const product = join(dir, 'sources', 'v');
  const store = storeOf({
    vaults: [{ path: vault }, { path: product, origin: 'user' }],
    sources: [{ name: 'v', url: vault, kind: 'local' }],
  });

  assert.equal(standbyVaults(store).size, 0, '「我确认要它」必须压过一切自动规则');
});

// ---- resolveVaults：解析时剔除，并带着原因 ----

test('resolveVaults: 产物默认不参与检索，vaults 与 standby 分开返回且带原因', async () => {
  const dir = tmpData();
  const vault = join(dir, 'Vault');
  const product = join(dir, 'sources', 'v');
  mkdirSync(vault, { recursive: true });
  mkdirSync(product, { recursive: true });
  writeFileSync(join(vault, 'a.md'), '# a\n', 'utf8');
  writeFileSync(join(product, 'a.md'), '# a\n', 'utf8');
  writeFileSync(
    process.env.NX_KN_STORE,
    JSON.stringify({
      version: 1,
      settings: {},
      kb: { vaults: [{ path: product }, { path: vault }] },
      crawl: { sources: [{ name: 'v', url: vault, kind: 'local' }] },
    }),
    'utf8'
  );
  clearCache();

  const r = await resolveVaults({});

  assert.equal(r.vaults.length, 1, '只有源库参与');
  assert.equal(resolve(r.vaults[0].path), resolve(vault));
  assert.equal(r.standby.length, 1);
  assert.equal(resolve(r.standby[0].path), resolve(product));
  assert.equal(r.standby[0].standby, true);
  // 原因必须一路带着走：说不清理由的排除，用户只会读成「东西丢了」
  assert.equal(resolve(r.standby[0].standbyBecause), resolve(vault));
  assert.equal(r.standby[0].missing, false, '被排除 ≠ 目录不存在，两件事不能混');
});

test('resolveVaults: --root 显式指定是逃生舱，不受排除规则影响', async () => {
  const dir = tmpData();
  const vault = join(dir, 'Vault');
  const product = join(dir, 'sources', 'v');
  mkdirSync(vault, { recursive: true });
  mkdirSync(product, { recursive: true });
  writeFileSync(
    process.env.NX_KN_STORE,
    JSON.stringify({
      version: 1,
      settings: {},
      kb: { vaults: [{ path: product }, { path: vault }] },
      crawl: { sources: [{ name: 'v', url: vault, kind: 'local' }] },
    }),
    'utf8'
  );
  clearCache();

  const r = await resolveVaults({ root: product });
  assert.equal(r.vaults.length, 1, '显式说「这次只看这个」时，谈不上与别的库重复');
  assert.equal(resolve(r.vaults[0].path), resolve(product));
  assert.equal(r.standby.length, 0);
});

// ---- kb add：启用被排除的库的**唯一**入口 ----

test('kb add 一次已存在的产物库 = 用户确认要它 → 立刻不再被排除', async () => {
  const dir = tmpData();
  const vault = join(dir, 'Vault');
  const product = join(dir, 'sources', 'v');
  mkdirSync(vault, { recursive: true });
  mkdirSync(product, { recursive: true });
  writeFileSync(join(product, 'a.md'), '# a\n', 'utf8');
  writeFileSync(
    process.env.NX_KN_STORE,
    JSON.stringify({
      version: 1,
      settings: {},
      kb: { vaults: [{ path: product, origin: 'crawl' }, { path: vault }] },
      crawl: { sources: [{ name: 'v', url: vault, kind: 'local' }] },
    }),
    'utf8'
  );
  clearCache();

  assert.equal(standbyVaults(await loadStore()).size, 1, '前提：一开始是被排除的');

  await kbAdd({ path: product });

  const after = await loadStore();
  assert.equal(standbyVaults(after).size, 0, 'kb add 应当把 origin 提成 user');
  assert.equal(after.kb.vaults.find((v) => resolve(v.path) === resolve(product)).origin, 'user');

  const r = await resolveVaults({});
  assert.equal(r.vaults.length, 2, '两个库都参与——重复是用户自己要的');
  assert.equal(r.standby.length, 0);
});

test('kb add 新增记录时写入 origin: user（与抓取自动登记的 crawl 区分开）', async () => {
  const dir = tmpData();
  const vault = join(dir, 'Vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'a.md'), '# a\n', 'utf8');
  clearCache();

  await kbAdd({ path: vault });

  const store = await loadStore();
  assert.equal(store.kb.vaults[0].origin, 'user');
});

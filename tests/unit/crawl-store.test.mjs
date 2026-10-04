// store 采集域归一化单测：新增字段必须能「老 store 读进来就有默认值」。
//
// store 的约定是「改 initialState() 即自动迁移，不写迁移脚本」。
// 这条约定成立的前提是 normalize 真的把缺失键补齐——这里把它钉住。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, normalize, normalizeCrawl } from '../../src/core/store.js';

test('initialState 含 crawl.sources（与 kb.vaults 分列）', () => {
  const s = initialState();
  assert.deepEqual(s.crawl, { sources: [] });
  assert.deepEqual(s.kb, { vaults: [] });
});

test('normalizeCrawl：丢弃缺 name/url 的记录，按 name 去重，补默认值', () => {
  const out = normalizeCrawl({
    sources: [
      { name: 'docs', url: 'https://a.com/' },
      { name: 'docs', url: 'https://dup.com/' }, // 同名 → 去重丢弃
      { url: 'https://noname.com/' }, // 缺 name → 丢弃
      { name: 'noname' }, // 缺 url → 丢弃
      { name: 'api', url: 'https://b.com/api', include: '/api/**', max: 50 },
    ],
  });
  assert.equal(out.sources.length, 2);
  assert.equal(out.sources[0].name, 'docs');
  assert.equal(out.sources[0].include, '**', '缺 include 应补 **');
  assert.equal(out.sources[0].max, 200, '缺 max 应补 200');
  assert.equal(out.sources[1].name, 'api');
  assert.equal(out.sources[1].include, '/api/**');
  assert.equal(out.sources[1].max, 50);
});

test('normalizeCrawl：非法 max（0/负数/非数）回落到 200', () => {
  const out = normalizeCrawl({
    sources: [
      { name: 'a', url: 'https://a.com/', max: 0 },
      { name: 'b', url: 'https://b.com/', max: -3 },
      { name: 'c', url: 'https://c.com/', max: 'x' },
    ],
  });
  assert.deepEqual(out.sources.map((s) => s.max), [200, 200, 200]);
});

test('normalize：老 store（无 crawl 键）读进来自动补上，不需要迁移脚本', () => {
  const s = normalize({ version: 1, settings: {}, kb: { vaults: [{ path: '/x' }] } });
  assert.deepEqual(s.crawl, { sources: [] });

  const s2 = normalize({ version: 1, crawl: { sources: [{ name: 'd', url: 'https://d.com/' }] } });
  assert.equal(s2.crawl.sources.length, 1);
  assert.deepEqual(s2.kb, { vaults: [] });
});

test('normalize：未知顶层键原样带过来（crawl 与 kb 不被通用分支吞掉）', () => {
  const s = normalize({
    version: 1,
    future: { x: 1 },
    crawl: { sources: [{ name: 'd', url: 'https://d.com/' }] },
  });
  assert.deepEqual(s.future, { x: 1 });
  assert.equal(s.crawl.sources.length, 1);
});

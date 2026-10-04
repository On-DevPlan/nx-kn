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

test('normalizeCrawl：抓取引擎缺省补默认（skill-seekers），非法值也回落默认', () => {
  const out = normalizeCrawl({
    sources: [
      { name: 'old', url: 'https://old.com/' }, // 老记录：没有 engine 键
      { name: 'ok', url: 'https://ok.com/', engine: 'node' },
      { name: 'bad', url: 'https://bad.com/', engine: 'wget' }, // 不认识的引擎
    ],
  });
  assert.equal(out.sources[0].engine, 'skill-seekers', '老 store 必须能直接跑，不能因为缺字段变 undefined');
  assert.equal(out.sources[1].engine, 'node', '合法的显式选择必须保留');
  assert.equal(out.sources[2].engine, 'skill-seekers', '非法值回落默认，而不是原样带下去');
});

test('normalizeCrawl：增强级别只认 0~3 的整数，其余回落 0', () => {
  const out = normalizeCrawl({
    sources: [
      { name: 'a', url: 'https://a.com/', enhanceLevel: 2 },
      { name: 'b', url: 'https://b.com/', enhanceLevel: 0 },
      { name: 'c', url: 'https://c.com/', enhanceLevel: 4 }, // 越界
      { name: 'd', url: 'https://d.com/', enhanceLevel: -1 }, // 负数
      { name: 'e', url: 'https://e.com/', enhanceLevel: 1.5 }, // 非整数
      { name: 'f', url: 'https://f.com/', enhanceLevel: 'x' }, // 非数
      { name: 'g', url: 'https://g.com/' }, // 缺省
    ],
  });
  assert.deepEqual(
    out.sources.map((s) => s.enhanceLevel),
    [2, 0, 0, 0, 0, 0, 0]
  );
});

test('normalizeCrawl：agent 缺省为 null（不是空串，也不是 undefined）', () => {
  const out = normalizeCrawl({
    sources: [
      { name: 'a', url: 'https://a.com/' },
      { name: 'b', url: 'https://b.com/', agent: 'kimi' },
    ],
  });
  assert.equal(out.sources[0].agent, null);
  assert.equal(out.sources[1].agent, 'kimi');
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

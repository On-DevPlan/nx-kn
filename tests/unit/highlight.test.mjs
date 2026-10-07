// 检索高亮的切词与标黄单测。
//
// 为什么要单测：这一段决定「面板上哪几个字变黄」。它没有 UI 依赖、是纯函数，
// 而它的正确性又全靠几条易错规则——中文 2-gram、停用词过滤、区间合并、
// 大小写不敏感、查询里的正则元字符按字面处理。任何一条破了都不会报错，
// 只会让高亮悄悄变错（整段变黄 / 一个字不黄 / 该合并的碎成几段）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightTerms, splitHighlight } from '../../src/web/frontend/highlight.js';

test('highlightTerms：中文按 2-gram 切，单字与疑问词不进词表', () => {
  const terms = new Set(highlightTerms('登录页为什么提示超时'));
  // 相邻两字都成为候选——这正是「不用词典也能覆盖任意中文词」的来源
  for (const t of ['登录', '录页', '页为', '么提', '提示', '示超', '超时']) {
    assert.ok(terms.has(t), `缺 bigram: ${t}`);
  }
  assert.ok(!terms.has('什么') && !terms.has('为什'), '中文疑问词不该标黄');
});

test('highlightTerms：整个问句都是虚词时词表为空', () => {
  assert.deepEqual(highlightTerms('为什么'), []);
  assert.deepEqual(highlightTerms('的'), [], '单字不成词');
  assert.deepEqual(highlightTerms('   '), [], '空白问句');
});

test('highlightTerms：英文整词、停用词按 zg 的口径排除', () => {
  const terms = new Set(highlightTerms('how to use nx-kn query'));
  assert.ok(terms.has('nx-kn'), '带连字符的标识符要保持整词');
  assert.ok(terms.has('query'));
  for (const stop of ['how', 'to', 'use']) {
    assert.ok(!terms.has(stop), `停用词不该标黄: ${stop}`);
  }
});

test('highlightTerms：数字至少两位才收（单个数字没有区分度）', () => {
  const terms = new Set(highlightTerms('错误码 404 与 5'));
  assert.ok(terms.has('404'));
  assert.ok(!terms.has('5'));
  assert.ok(terms.has('错误') && terms.has('误码'), '数字串不该影响中文切分');
});

test('splitHighlight：命中切出来，未命中原样保留（顺序与全文拼接不变）', () => {
  const segs = splitHighlight('登录超时排查记录：登录页白屏', '登录超时');
  assert.deepEqual(segs, [
    { text: '登录超时', hit: true },
    { text: '排查记录：', hit: false },
    { text: '登录', hit: true },
    { text: '页白屏', hit: false },
  ]);
  assert.equal(segs.map((s) => s.text).join(''), '登录超时排查记录：登录页白屏');
});

test('splitHighlight：相邻 bigram 的重叠区间合并成整词块', () => {
  // 「登录超时」在原文里是连续的：登录[0,2) 、录超[1,3) 、超时[2,4) 三段重叠，
  // 合并后应是一整块而不是三个碎黄块——这是 bigram 方案可用的前提。
  const segs = splitHighlight('abc def', 'ab bc');
  assert.deepEqual(segs, [
    { text: 'abc', hit: true },
    { text: ' def', hit: false },
  ]);
});

test('splitHighlight：英文匹配大小写不敏感，原样输出（不改写大小写）', () => {
  assert.deepEqual(splitHighlight('Scenario DSL 场景', 'scenario'), [
    { text: 'Scenario', hit: true },
    { text: ' DSL 场景', hit: false },
  ]);
});

test('splitHighlight：查询里的正则元字符按字面处理（不抛、不误匹配）', () => {
  // 问句是用户随手敲的，含 `(` `)` `*` `?` `.` 是常态。实现用 indexOf 而非 RegExp，
  // 所以既不会因非法正则抛异常，也不会把 `.` 当成「任意字符」。
  assert.deepEqual(splitHighlight('use(react) is nice', 'use(react)'), [
    { text: 'use(', hit: false },
    { text: 'react', hit: true },
    { text: ') is nice', hit: false },
  ]);
  assert.deepEqual(splitHighlight('a.b 与 axb', 'a.b'), [
    { text: 'a.b', hit: true },
    { text: ' 与 axb', hit: false },
  ], '`.` 必须当字面：当通配就会把 axb 也标黄');
});

test('splitHighlight：没有字面重合时整段返回（语义命中常见，不算失败）', () => {
  assert.deepEqual(splitHighlight('完全不同的一段话', '登录超时'), [
    { text: '完全不同的一段话', hit: false },
  ]);
});

test('splitHighlight：中文词只标注连续出现的部分', () => {
  assert.deepEqual(splitHighlight('nx-kn 的闭包与原型链', '闭包原型'), [
    { text: 'nx-kn 的', hit: false },
    { text: '闭包', hit: true },
    { text: '与', hit: false },
    { text: '原型', hit: true },
    { text: '链', hit: false },
  ]);
});

test('splitHighlight：空值 / 空问句安全（返回单段，不抛）', () => {
  assert.deepEqual(splitHighlight('abc', ''), [{ text: 'abc', hit: false }]);
  assert.deepEqual(splitHighlight('', '登录'), [{ text: '', hit: false }]);
  assert.deepEqual(splitHighlight(null, null), [{ text: '', hit: false }]);
  assert.deepEqual(splitHighlight(undefined, '登录'), [{ text: '', hit: false }]);
});

test('splitHighlight：可传入预先算好的词表（视图里同一问句复用一次切词）', () => {
  const terms = highlightTerms('登录超时');
  assert.deepEqual(splitHighlight('登录', '不会用到', terms), [{ text: '登录', hit: true }]);
});

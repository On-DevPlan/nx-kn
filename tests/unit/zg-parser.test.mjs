// zg 输出解析的纯逻辑断言。
//
// 为什么单独成文：`zg query --json` 在 0.2.2 已被移除（实测报错「--json has been
// removed」），我们只能解析 agent markdown 文本——一个纯文本协议。解析规则一旦
// 被改坏，命令不报错、只是**静默返回空命中**（面板显示「没有命中」），
// 是最难发现的一类退化。所以把真实输出原样钉在这里。
//
// 样本全部来自本机 zg 0.2.2 的实测输出（只把乱码字符换成了正常中文）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuery, parseStatus } from '../../src/core/zg.js';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

// ---- parseQuery ----

const QUERY_READY = [
  'query groups (1):',
  'Q1 [primary]: 登录页为什么提示超时',
  'hits: 3',
  '',
  '#1 matchedBy=fts+vector notes/登录超时排查.md:1-2',
  '1\t---',
  '',
  '#2 matchedBy=fts+vector notes/登录超时排查.md:6-15',
  'heading: 登录超时排查记录',
  'heading_level: 1',
  '6\t# 登录超时排查记录',
  '7\t升级至 8.60.17 后登录页出现「登录超时」提示。',
  '',
  '#3 matchedBy=vector notes/主题系统策略模式.md:3-5',
  'heading: tags: [sedoc, bug, login]',
  'heading_level: 2',
  '3\ttags: [sedoc, bug, login]',
  '',
  'results: served_from_current_index',
  'background_refresh: idle (3/4)',
].join('\n');

test('parseQuery: 命中头 / 行号范围 / matchedBy 拆分', () => {
  const r = parseQuery(QUERY_READY);
  assert.equal(r.declaredGroups, 1);
  assert.equal(r.hits.length, 3);
  assert.deepEqual(r.hits[0], {
    n: 1,
    matchedBy: ['fts', 'vector'],
    path: 'notes/登录超时排查.md',
    start: 1,
    end: 2,
    heading: null,
    headingLevel: null,
    snippet: '---',
  });
  assert.equal(r.hits[2].matchedBy.join('+'), 'vector');
  assert.equal(r.hits[2].path, 'notes/主题系统策略模式.md');
});

test('parseQuery: heading / heading_level 与多行片段拼接', () => {
  const r = parseQuery(QUERY_READY);
  const h2 = r.hits[1];
  assert.equal(h2.heading, '登录超时排查记录');
  assert.equal(h2.headingLevel, 1);
  assert.equal(h2.snippet, '# 登录超时排查记录\n升级至 8.60.17 后登录页出现「登录超时」提示。');
  // heading 里本身带冒号（`tags: [...]`）时不能被当成截断
  assert.equal(r.hits[2].heading, 'tags: [sedoc, bug, login]');
});

test('parseQuery: 片段正文里的 # 标题不会被误认成命中头（HIT_RE 锚定行首）', () => {
  const r = parseQuery(QUERY_READY);
  // 正文里的 `6\t# 登录超时排查记录` 若被当成命中头，hits 会多出一条
  assert.equal(r.hits.length, 3);
});

test('parseQuery: 查询分组与尾注', () => {
  const r = parseQuery(QUERY_READY);
  assert.deepEqual(r.groups, [
    { n: 1, flag: 'primary', query: '登录页为什么提示超时', hits: 3 },
  ]);
  assert.deepEqual(r.notes, [
    'results: served_from_current_index',
    'background_refresh: idle (3/4)',
  ]);
});

test('parseQuery: 空输出与无命中返回空结构（不抛）', () => {
  for (const t of ['', 'query groups (0):\n', '  ']) {
    const r = parseQuery(t);
    assert.deepEqual(r.hits, []);
    assert.deepEqual(r.groups, []);
  }
});

test('parseQuery: 路径含空格与中文时行号仍被正确切出', () => {
  const raw = [
    'query groups (1):',
    'Q1 [primary]: 主题',
    'hits: 1',
    '',
    '#1 matchedBy=vector 01 项目/主题 系统.md:12-20',
    'heading: 策略模式',
    'heading_level: 2',
    '12\t主题系统',
  ].join('\n');
  const r = parseQuery(raw);
  assert.equal(r.hits[0].path, '01 项目/主题 系统.md');
  assert.equal(r.hits[0].start, 12);
  assert.equal(r.hits[0].end, 20);
  assert.equal(r.hits[0].snippet, '主题系统');
});

test('parseQuery: 片段里的空行被保留（输出中是 `7\\t`，不能因 trim 丢掉）', () => {
  const raw = [
    'query groups (1):',
    'Q1 [primary]: 主题',
    'hits: 1',
    '',
    '#1 matchedBy=vector notes/a.md:6-10',
    'source:',
    '6\t第一行',
    '7\t',
    '8\t第二行',
  ].join('\n');
  const r = parseQuery(raw);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].snippet, '第一行\n\n第二行');
});

// ---- 调用口径的防回归断言 ----

test('查询固定走 --fuse（不加会把问句按词拆成多组、重复返回）', () => {
  // 实测：`query "Scenario DSL 场景怎么写"` 不加 --fuse 时回来 3 组 × limit 条，
  // 大半是同一条的副本；加 --fuse 才是统一排序的列表。删掉这个 flag 不会报错，
  // 只会让结果悄悄变差——所以在此钉住（同 consistency.test.mjs 的读源码断言套路）。
  const src = readFileSync(join(SRC, 'modules', 'kb', 'service.js'), 'utf8');
  assert.match(src, /'--fuse'/, 'kb/service.js 的 query 必须带 --fuse');
  assert.match(src, /cwd: dir/, 'zg query 没有 root 参数，必须 cwd = vault 运行');
});

// ---- parseStatus ----

test('parseStatus: ready 形态（覆盖条 # 已满）', () => {
  const raw = [
    '\u2714 Workspace index is ready',
    '  D:\\Notes\\Vault',
    '',
    '  Coverage    #################### 100%  11 / 11 files',
    '  Entities    17',
    '  Truncated   0 fragments',
    '  Queue       0 pending \u00b7 0 failed',
    '',
    '  Embedding   local/qwen3-embedding-0.6b',
    '              1,024 dimensions \u00b7 cosine',
    '',
    '  Storage     .zvec-grep\\index.zvec',
  ].join('\n');
  const s = parseStatus(raw);
  assert.equal(s.configured, true);
  assert.equal(s.ready, true);
  assert.equal(s.stale, false);
  assert.equal(s.root, 'D:\\Notes\\Vault');
  assert.equal(s.coveragePercent, 100);
  assert.equal(s.files, 11);
  assert.equal(s.filesTotal, 11);
  assert.equal(s.entities, 17);
  assert.deepEqual(s.embedding, {
    model: 'local/qwen3-embedding-0.6b',
    dims: 1024,
    metric: 'cosine',
  });
});

test('parseStatus: needs-an-update 形态（覆盖条 # 与 - 混排 + Changes 行）', () => {
  // 实测样本：进度条是 `#` 与 `-` 混排，只认 `#` 会让 Coverage 整条匹配失败
  const raw = [
    '! Workspace index needs an update',
    '  D:\\Notes\\Vault',
    '',
    '  Coverage    ################----  79%  11 / 14 files',
    '  Entities    17',
    '  Queue       0 pending \u00b7 0 failed',
    '  Changes     3 added \u00b7 0 modified \u00b7 0 deleted',
  ].join('\n');
  const s = parseStatus(raw);
  assert.equal(s.ready, false);
  assert.equal(s.stale, true);
  assert.equal(s.coveragePercent, 79);
  assert.equal(s.files, 11);
  assert.equal(s.filesTotal, 14);
  assert.deepEqual(s.changes, { added: 3, modified: 0, deleted: 0 });
});

test('parseStatus: 未配置形态', () => {
  const raw = [
    '? Workspace index is not configured',
    '  D:\\Notes\\Vault',
    '',
    '  Storage     .zvec-grep\\index.zvec',
    '  Policy      undecided',
    '',
    '  Next        zg index or zg query --rg',
  ].join('\n');
  const s = parseStatus(raw);
  assert.equal(s.configured, false);
  assert.equal(s.ready, false);
  assert.equal(s.root, 'D:\\Notes\\Vault');
  assert.equal(s.next, 'zg index or zg query --rg');
  assert.equal(s.coveragePercent, null);
});

test('parseStatus: POSIX 根路径也能识别', () => {
  const s = parseStatus('  /home/u/notes\n  Storage     .zvec-grep/index.zvec\n');
  assert.equal(s.root, '/home/u/notes');
});

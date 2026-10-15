// needdo 域单元测试：入库四通道、提取器（docx/pdf 最小 fixture）、主题整理、归档流转。
// 每个用例独立的 NX_KN_STORE + 独立的文件目录（needdoDir 跟 store 所在目录走），
// 防写脏真实数据——与 smoke.mjs 的 isolatedEnv 同一思路。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, loadStore, normalizeNeeddo } from '../../src/core/store.js';
import * as needdo from '../../src/modules/needdo/service.js';

// 进程级缓存（core/store.js 的 cache + mtime）会跨用例串数据，每个用例换 store 前先清。
let envDir = null;
function freshEnv() {
  envDir = mkdtempSync(join(tmpdir(), 'nx-kn-needdo-'));
  clearCache();
  process.env.NX_KN_STORE = join(envDir, 'store.json');
  return envDir;
}

test('add：文字 / 链接 / 非法输入', async () => {
  freshEnv();

  const a = await needdo.addText('明天下午3点开会\n记得带Q4预算');
  assert.equal(a.kind, 'text');
  assert.equal(a.title, '明天下午3点开会'); // 首行作标题
  assert.ok(a.excerpt.length <= 200);

  const b = await needdo.addLink('https://example.com/a?b=1');
  assert.equal(b.kind, 'link');
  assert.equal(b.title, 'example.com/a?b=1'); // 展示名剥掉协议

  await assert.rejects(needdo.addText('   '), /不能为空/);
  await assert.rejects(needdo.addLink('ftp://x'), /http/);
  await assert.rejects(needdo.add({}), /没有可入库的内容/);
});

test('混排文字：原文不动，夹着的 URL 抽进 links（去重）', async () => {
  freshEnv();
  const it = await needdo.addText(
    '先看 https://a.com/x 再看 http://b.com/y，第一遍给的 https://a.com/x 是同一篇。正文保持原样。'
  );
  assert.deepEqual(it.links, ['https://a.com/x', 'http://b.com/y']);
  assert.match(it.content, /https:\/\/a\.com\/x 再看/, '原文必须原样保留');
  const clean = await needdo.addText('没有链接的一段话');
  assert.deepEqual(clean.links, []);
});

test('file：docx 提取出段落文本', async () => {
  freshEnv();
  const buf = makeZip([
    { name: '[Content_Types].xml', data: Buffer.from('<Types/>') },
    {
      name: 'word/document.xml',
      data: Buffer.from(
        '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>第一段：项目排期</w:t></w:r></w:p><w:p><w:r><w:t>第二段：记得评审</w:t></w:r></w:p></w:body></w:document>'
      ),
    },
  ]);
  const it = await needdo.addFileData('排期.docx', buf);
  assert.equal(it.kind, 'file');
  assert.equal(it.ext, 'docx');
  assert.ok(it.textFile, 'docx 必须能提取文本');
  assert.ok(it.excerpt.includes('第一段'));

  const detail = await needdo.show({ id: it.id });
  assert.match(detail.text, /第一段：项目排期/);
  assert.match(detail.text, /第二段：记得评审/);
  // 原件与提取文本都落了盘
  assert.ok(existsSync(join(envDir, 'needdo', it.file)));
  assert.ok(existsSync(join(envDir, 'needdo', it.textFile)));
});

test('file：pdf 明文流提取 + 拒收不支持的类型', async () => {
  freshEnv();

  const content = 'BT /F1 12 Tf 72 720 Td (Meeting at 3pm bring Q4 plan) Tj ET';
  const pdf = Buffer.from(
    `%PDF-1.4\n4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n%%EOF\n`,
    'latin1'
  );
  const it = await needdo.addFileData('note.pdf', pdf);
  assert.ok(it.textFile, '明文 PDF 应提取出文本');
  assert.match(it.excerpt, /Meeting at 3pm/);

  await assert.rejects(needdo.addFileData('virus.exe', Buffer.from('MZ')), /不支持的文件类型/);
  await assert.rejects(needdo.addFileData('empty.pdf', Buffer.alloc(0)), /文件为空/);
});

test('list / show / remove：过滤与联动清理', async () => {
  freshEnv();

  await needdo.addText('第一条随手记');
  const f = await needdo.addFileData('a.md', Buffer.from('# 标题\n一些markdown文字内容'));
  await needdo.addText('第二条随手记');

  const all = await needdo.list({});
  assert.equal(all.total, 3);
  assert.equal(all.inbox, 3);

  // 主题是 process 时才分配的——入库后都是「未整理」（topic null），过滤不该误命中
  const untopic = await needdo.list({ topic: '杂项收集' });
  assert.equal(untopic.count, 0);

  await needdo.remove({ id: f.id });
  const after = await needdo.list({});
  assert.equal(after.total, 2);
  assert.ok(!existsSync(join(envDir, 'needdo', f.file)), '条目删了，盘上的原件也要删');

  await assert.rejects(needdo.show({ id: f.id }), /没有这条条目/);
});

test('process：主题分类、归档与整理报告', async () => {
  freshEnv();

  await needdo.addText('记得周三前提交报销单');
  await needdo.addText('关于国庆放假安排的通知');
  await needdo.addLink('https://example.com/weekly');
  await needdo.addFileData('p.pdf', Buffer.from('%PDF-1.4\n%%EOF')); // 无文本流 → 不提取，但仍入库

  const r = await needdo.process({});
  assert.equal(r.processed, 4);
  const topics = Object.fromEntries(r.byTopic.map((x) => [x.topic, x.count]));
  assert.equal(topics['待办事项'], 1, '「记得/提交」命中待办');
  assert.equal(topics['公告通知'], 1, '「放假/通知」命中公告');
  assert.equal(topics['链接收藏'], 1);
  assert.equal(topics['文档资料'], 1);
  assert.ok(existsSync(r.report), '整理报告要落盘');
  assert.match(readFileSync(r.report, 'utf8'), /# NeedDo 整理报告/);

  assert.equal((await needdo.list({})).inbox, 0, '整理完收件箱清空（全部归档）');
  assert.equal((await needdo.list({ status: 'done' })).count, 4);

  // 再跑一次：没有新条目时是空操作，不重复写报告
  const r2 = await needdo.process({});
  assert.equal(r2.processed, 0);
  assert.equal(r2.report, null);
});

test('archive：归档可逆，批量与 missing 如实回报', async () => {
  freshEnv();
  const a = await needdo.addText('待归档的一条');
  const done = await needdo.archive({ id: a.id });
  assert.equal(done.status, 'done');
  assert.equal(done.count, 1);
  assert.equal((await needdo.list({ status: 'inbox' })).count, 0);
  const back = await needdo.archive({ id: a.id, undo: true });
  assert.equal(back.status, 'inbox');

  // 批量：存在的归档、不存在的跳过并回报；全不存在时按 notFound 报
  const b = await needdo.addText('批量第二条');
  const c = await needdo.addText('批量第三条');
  const batch = await needdo.archive({ ids: [b.id, c.id, 'nd_ghost'] });
  assert.equal(batch.count, 2);
  assert.deepEqual(batch.missing, ['nd_ghost']);
  assert.equal((await needdo.list({ status: 'inbox' })).count, 1, '只剩被还原过的 a');
  await assert.rejects(needdo.archive({ ids: ['nd_x', 'nd_y'] }), /没有这些条目/);
});

test('remove 批量：不连续选中的条目一个不误删，missing 回报', async () => {
  freshEnv();
  const ids = [];
  for (const s of ['甲', '乙', '丙', '丁']) ids.push((await needdo.addText(s)).id);
  // 删第 1、3 条（不连续）——下标式 splice 会把「乙」误带走，过滤重建不会
  const r = await needdo.remove({ ids: [ids[0], ids[2]] });
  assert.equal(r.removed, 2);
  assert.deepEqual(r.ids, [ids[0], ids[2]]);
  const left = await needdo.list({});
  assert.deepEqual(
    left.items.map((x) => x.title).sort(),
    ['丁', '乙']
  );
  const r2 = await needdo.remove({ ids: [ids[1], 'nd_ghost'] });
  assert.equal(r2.removed, 1);
  assert.deepEqual(r2.missing, ['nd_ghost']);
});

test('process --ids：只整理指定条目，其余留在收件箱', async () => {
  freshEnv();
  const a = await needdo.addText('记得还书');
  const b = await needdo.addText('随便一条不动的');

  const r = await needdo.process({ ids: [a.id] });
  assert.equal(r.processed, 1);
  assert.equal((await needdo.list({ status: 'done' })).count, 1);
  assert.equal((await needdo.list({ status: 'inbox' })).count, 1);

  // 归档条目不能被再次整理（即使 id 被点名）
  const r2 = await needdo.process({ ids: [a.id, b.id] });
  assert.equal(r2.processed, 1);
});

test('fileData：原件以 base64 过境，路径与尺寸一并返回', async () => {
  freshEnv();
  const f = await needdo.addFileData('b.md', Buffer.from('# 一份原件\n正文内容'));
  const r = await needdo.fileData({ id: f.id });
  assert.equal(r.ext, 'md');
  assert.ok(Buffer.from(r.data, 'base64').equals(Buffer.from('# 一份原件\n正文内容')));
  assert.ok(r.path.endsWith(f.file));
  await assert.rejects(needdo.fileData({ id: 'nd_nope' }), /没有这条条目/);
  const t = await needdo.addText('文字条目没有原件');
  await assert.rejects(needdo.fileData({ id: t.id }), /没有原件/);
});

test('normalizeNeeddo：坏条目丢弃、合法条目补默认值（老 store 缺 needdo 键 → items: []）', async () => {
  freshEnv();
  const out = normalizeNeeddo({
    items: [
      { id: 'nd_ok', kind: 'text', content: 'x' },
      { id: 'nd_ok', kind: 'text', content: 'dup' }, // 同 id → 去重丢弃
      { kind: 'text', content: '无 id' }, // 无 id → 丢弃
      { id: 'nd_file', kind: 'file', ext: 'exe' }, // file + 非法扩展名 → 丢弃
      { id: 'nd_bad', kind: 'weird' }, // kind 非法 → 归为 text
    ],
  });
  assert.equal(out.items.length, 2);
  assert.equal(out.items[0].id, 'nd_ok');
  assert.equal(out.items[0].status, 'inbox', '缺 status 补 inbox');
  assert.equal(out.items[1].id, 'nd_bad');
  assert.equal(out.items[1].kind, 'text');

  const st = await loadStore(); // 全新 store：needdo 键自动补齐
  assert.deepEqual(st.needdo, { items: [] });
});

// ---- 测试用的最小 zip 构造（store 方法，不压缩；CRC 置 0——本仓读取器不校验 CRC） ----
function makeZip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method = store
    local.writeUInt32LE(f.data.length, 18); // csize
    local.writeUInt32LE(f.data.length, 22); // usize
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, f.data);

    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt32LE(f.data.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([c, name]));
    offset += 30 + name.length + f.data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cd, eocd]);
}

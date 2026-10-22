// 双链解析与 frontmatter 生成的行为规格。
//
// 这个文件是 kn-obsidian-repair-unresolved-links 原先那三个 Python 脚本的
// **行为对照表**——每条期望值都来自 Python 版的实际规则，不是「我觉得应该」。
//
// 为什么值得逐条钉：这套规则错在哪都不会报错，只会**误建笔记**（把已存在的笔记
// 当成红链，又在 source 旁边建一份）。口径一漂，用户的 vault 就开始长出重复笔记。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ATTACHMENT_EXTS,
  buildLinkIndex,
  cleanLinkTarget,
  decodeVaultFile,
  formatLocalTimestamp,
  genFrontmatterYaml,
  isAttachmentLink,
  pythonTrim,
  resolveLinkTarget,
  sanitizeName,
  scanLineForLinks,
} from '../../src/core/obsidian-links.js';

// ---- 空白字符集：Python 认的，JS trim() 不全认 ----

test('pythonTrim：认全角空格与 NBSP，但不认 BOM（与 Python str.strip() 一致）', () => {
  assert.equal(pythonTrim('　foo　'), 'foo', 'U+3000 全角空格要裁');
  assert.equal(pythonTrim(' foo '), 'foo', 'U+00A0 NBSP 要裁');
  assert.equal(pythonTrim('﻿foo'), '﻿foo', 'U+FEFF BOM **不**裁（JS trim() 会裁）');
  assert.equal(pythonTrim('\t\nfoo\r '), 'foo');
});

// ---- 目标清洗：顺序固定（先 # 再 |）----

test('cleanLinkTarget：先切标题再切别名，顺序不能反', () => {
  assert.equal(cleanLinkTarget('a|b#c'), 'a', '先 # 后 |：a|b → a');
  assert.equal(cleanLinkTarget('a#b|c'), 'a');
  assert.equal(cleanLinkTarget('foo'), 'foo');
  assert.equal(cleanLinkTarget('foo　'), 'foo', '尾部全角空格要裁');
  assert.equal(cleanLinkTarget('foo　bar'), 'foo　bar', '中间的全角空格**保留**（这正是误判来源之一）');
  assert.equal(cleanLinkTarget('  '), '', '全空白 → 空');
});

// ---- 双链词法 ----

test('双链正则：[[]] 不算链接，[[a]b]] 也不算', () => {
  const st = { inCode: false };
  assert.deepEqual(scanLineForLinks('[[]]', st).links, []);
  assert.deepEqual(scanLineForLinks('[[a]b]]', st).links, []);
  assert.deepEqual(scanLineForLinks('见 [[foo]] 与 [[bar]]', st).links, ['foo', 'bar']);
});

test('代码围栏：开围栏那行跳过，闭围栏那行不跳过（Python 版的不对称行为）', () => {
  const st = { inCode: false };
  assert.deepEqual(scanLineForLinks('```js', st).links, [], '开围栏行被跳过');
  assert.deepEqual(scanLineForLinks('const a = "[[x]]"', st).links, [], '围栏内的链接不算');
  assert.deepEqual(scanLineForLinks('```', st).links, [], '闭围栏行本身也没链接');
  assert.deepEqual(scanLineForLinks('再看 [[y]]', st).links, ['y'], '围栏结束后恢复正常');
});

test('行内代码：成对反引号里的链接不算', () => {
  const st = { inCode: false };
  assert.deepEqual(scanLineForLinks('写成 `[[x]]` 这样', st).links, []);
  assert.deepEqual(scanLineForLinks('`[[x]]` 和 [[y]]', st).links, ['y']);
});

// ---- 附件 ----

test('附件扩展名：18 个、大小写不敏感；.md 不算附件', () => {
  assert.equal(ATTACHMENT_EXTS.length, 18);
  assert.equal(isAttachmentLink('foo.png'), true);
  assert.equal(isAttachmentLink('foo.PNG'), true);
  assert.equal(isAttachmentLink('foo.md'), false, '.md 是笔记链接，不是附件');
  assert.equal(isAttachmentLink('foo'), false);
});

// ---- 索引与解析 ----

test('解析顺序：路径优先、其次 basename；全部大小写敏感', () => {
  const index = buildLinkIndex(['日常/foo.md', '日常/笔记.md', 'a/b.md']);
  assert.equal(resolveLinkTarget('foo', index), true, 'basename 能解析');
  assert.equal(resolveLinkTarget('日常/foo', index), true, '相对路径能解析');
  assert.equal(resolveLinkTarget('日常/foo.md', index), true, '带 .md 的路径能解析');
  assert.equal(resolveLinkTarget('Foo', index), false, '大小写敏感（Obsidian 本身不敏感——已知偏差）');
  assert.equal(resolveLinkTarget('不存在', index), false);
});

test('索引：by_path 只去最后一个扩展名（a.md.md → a.md）', () => {
  const index = buildLinkIndex(['a.md.md']);
  assert.equal(resolveLinkTarget('a.md', index), true);
});

// ---- 文件名清洗 ----

test('sanitizeName：照搬 Python 版的五步', () => {
  assert.equal(sanitizeName('a/b'), 'ab', '删斜杠');
  assert.equal(sanitizeName('a?b'), 'ab', '删问号');
  assert.equal(sanitizeName('a,b'), 'a,b', '逗号**不删**');
  assert.equal(sanitizeName('foo  bar'), 'foo bar', '2+ 空格折成一个');
  assert.equal(sanitizeName('foo　bar'), 'foo　bar', '全角空格不折');
  assert.equal(sanitizeName(' . x . '), ' x ', '去点在折空格之前（Python 版行为）');
  assert.match(sanitizeName('...'), /^unresolved-\d{1,4}$/, '全点被剥光 → 走兜底名（Python 版同）');
});

test('sanitizeName：兜底名是确定性的（Python 版用随机化 hash，移植必须换掉）', () => {
  const a = sanitizeName('');
  const b = sanitizeName('');
  assert.equal(a, b, '两次调用必须同名');
  assert.match(a, /^unresolved-\d{1,4}$/);
});

// ---- frontmatter ----

test('genFrontmatterYaml：形状与 Python 版一致', () => {
  const yaml = genFrontmatterYaml({
    keys: ['creatime', 'tags', 'bklink'],
    bklink: ['日常/foo.md', '日常/bar.md', '日常/foo.md'],
    now: new Date(2026, 5, 21, 14, 0, 0),
  });
  assert.equal(
    yaml,
    [
      '---',
      'creatime: 2026-06-21 14:00:00',
      'tags: []',
      'bklink:',
      '  - "[[foo]]"',
      '  - "[[bar]]"',
      '---',
    ].join('\n')
  );
});

test('genFrontmatterYaml：没有 bklink 时写空数组（不是空值）', () => {
  const yaml = genFrontmatterYaml({ bklink: [], now: new Date(2026, 0, 2, 3, 4, 5) });
  assert.match(yaml, /bklink: \[\]/);
  assert.match(yaml, /creatime: 2026-01-02 03:04:05/);
});

test('formatLocalTimestamp：用本地时区，不用 UTC（toISOString 会差几个小时）', () => {
  assert.equal(formatLocalTimestamp(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05');
});

// ---- 解码 ----

test('decodeVaultFile：BOM 被剥掉；GBK 能解出来', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('你好', 'utf8')]);
  assert.equal(decodeVaultFile(bom), '你好', 'BOM 要剥掉');

  // 「中文」的 GBK 编码
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4]);
  assert.equal(decodeVaultFile(gbk), '中文', 'GBK 文件要能解');
});

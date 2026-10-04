// core/web.js 单测：把「HTML → 干净 markdown」这条纯函数链路逐项钉死。
//
// 为什么这些必须单测：抓取是不可复现的（站点会变），但解析是纯函数。
// 把不确定性关在网络那一层，解析这一层就要能在 CI 里用固定输入逐字节断言。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  globMatch,
  globToRegExp,
  htmlToMarkdown,
  isHtmlContentType,
  isXmlContentType,
  normalizeUrl,
  originOf,
  pageFileFor,
  parseSitemap,
  pathOf,
  sameOrigin,
  sitemapCandidates,
  tidyMarkdown,
} from '../../src/core/web.js';

test('normalizeUrl：补全相对路径、剥掉 hash、拒绝非 http(s)', () => {
  assert.equal(normalizeUrl('/guide/x', 'https://a.com/docs/'), 'https://a.com/guide/x');
  assert.equal(normalizeUrl('https://a.com/x#sec', 'https://a.com/'), 'https://a.com/x');
  assert.equal(normalizeUrl('https://a.com/x?a=1', 'https://a.com/'), 'https://a.com/x?a=1');
  assert.equal(normalizeUrl('mailto:a@b.com', 'https://a.com/'), null);
  assert.equal(normalizeUrl('javascript:void(0)', 'https://a.com/'), null);
  assert.equal(normalizeUrl('', 'https://a.com/'), 'https://a.com/'); // 空串 = 当前页
  assert.equal(normalizeUrl(null), null);
  assert.equal(normalizeUrl('not a url'), null);
});

test('sameOrigin / originOf：协议+host+端口都要一致', () => {
  assert.equal(originOf('https://a.com/x/y'), 'https://a.com');
  assert.equal(sameOrigin('https://a.com/x', 'https://a.com/y?z=1'), true);
  assert.equal(sameOrigin('https://a.com/x', 'https://b.com/y'), false);
  assert.equal(sameOrigin('https://a.com/x', 'http://a.com/y'), false); // 协议不同
  assert.equal(sameOrigin('https://a.com:443/x', 'https://a.com/y'), true); // 默认端口归一
});

test('sitemapCandidates：指向站点根，与起始页子路径无关', () => {
  assert.deepEqual(sitemapCandidates('https://a.com/docs/guide/'), ['https://a.com/sitemap.xml']);
  assert.deepEqual(sitemapCandidates('nonsense'), []);
});

test('parseSitemap：urlset 与 sitemapindex 分别识别', () => {
  const urlset = parseSitemap(
    '<?xml version="1.0"?><urlset><url><loc>https://a.com/x</loc></url><url><loc>https://a.com/y</loc></url></urlset>'
  );
  assert.equal(urlset.isUrlset, true);
  assert.equal(urlset.isIndex, false);
  assert.deepEqual(urlset.locs, ['https://a.com/x', 'https://a.com/y']);

  const index = parseSitemap(
    '<sitemapindex><sitemap><loc>https://a.com/s1.xml</loc></sitemap><sitemap><loc>https://a.com/s2.xml</loc></sitemap></sitemapindex>'
  );
  assert.equal(index.isIndex, true);
  assert.equal(index.isUrlset, false);

  // 没有根标签 / 带命名空间前缀：靠「是不是都以 .xml 结尾」启发式判断
  const bare = parseSitemap('<loc>https://a.com/s1.xml</loc>');
  assert.equal(bare.isIndex, true);
});

test('globMatch：`**` 跨段、`*` 段内、`?` 单字符', () => {
  assert.equal(globMatch('**', '/anything/at/all'), true);
  assert.equal(globMatch('', '/anything'), true);
  assert.equal(globMatch('/guide/**', '/guide/a/b'), true);
  assert.equal(globMatch('/guide/**', '/api/a'), false);
  assert.equal(globMatch('/guide/*', '/guide/a'), true);
  assert.equal(globMatch('/guide/*', '/guide/a/b'), false);
  assert.equal(globMatch('/g?ide/a', '/guide/a'), true);
  // 正则元字符必须被转义，否则 `.` 会变成「任意字符」
  assert.equal(globMatch('/a.md', '/axmd'), false);
  assert.equal(globMatch('/a.md', '/a.md'), true);
  assert.equal(globToRegExp('/a+b').test('/a+b'), true);
  assert.equal(pathOf('https://a.com/x/y?z=1'), '/x/y');
});

test('pageFileFor：URL → 源目录内相对 md 路径', () => {
  assert.equal(pageFileFor('https://a.com/', 'https://a.com/'), 'index.md');
  assert.equal(
    pageFileFor('https://a.com/guide/getting-started', 'https://a.com/'),
    'guide/getting-started.md'
  );
  assert.equal(
    pageFileFor('https://a.com/api/v2/ref.html', 'https://a.com/'),
    'api/v2/ref.md'
  );
  // 起始 URL 的目录前缀要被剥掉（否则会多一层 docs/）
  assert.equal(
    pageFileFor('https://a.com/docs/api/ref', 'https://a.com/docs/'),
    'api/ref.md'
  );
  assert.equal(pageFileFor('https://a.com/dir/', 'https://a.com/'), 'dir/index.md');
  // 目录穿越：WHATWG URL 解析器在解析阶段就把 %2e%2e 当成 `..` 坍缩掉了
  // （pathname 直接变成 /etc/passwd），这是第一道防线；
  // 段级清洗（丢 `.`/`..`）是第二道，防的是别的来源拼进来的路径。
  assert.equal(
    pageFileFor('https://a.com/a/%2e%2e/%2e%2e/etc/passwd', 'https://a.com/'),
    'etc/passwd.md'
  );
  // 非法字符要被替换（Windows 上 `:` `*` 等不能进文件名）
  assert.equal(pageFileFor('https://a.com/a:b*c?d=1', 'https://a.com/'), 'a-b-c.md');
});

test('htmlToMarkdown：剔除版式噪声、正文优先、链接绝对化', () => {
  const html = `<!doctype html><html><head><title>Getting Started</title></head><body>
    <nav>NAVIGATION-TEXT</nav>
    <header>HEADER-TEXT</header>
    <aside>SIDEBAR-TEXT</aside>
    <main>
      <h1>Getting Started</h1>
      <p>Hello <a href="/guide/next">next page</a>.</p>
      <pre><code>npm i nx-kn</code></pre>
    </main>
    <footer>FOOTER-TEXT</footer>
  </body></html>`;

  const r = htmlToMarkdown(html, { url: 'https://docs.example.com/guide/getting-started' });
  assert.equal(r.title, 'Getting Started');
  assert.match(r.markdown, /# Getting Started/);
  assert.match(r.markdown, /\[next page\]\(https:\/\/docs\.example\.com\/guide\/next\)/);
  assert.match(r.markdown, /npm i nx-kn/);
  for (const noise of ['NAVIGATION-TEXT', 'HEADER-TEXT', 'SIDEBAR-TEXT', 'FOOTER-TEXT']) {
    assert.ok(!r.markdown.includes(noise), `版式噪声未被剔除: ${noise}`);
  }
  assert.ok(r.links.includes('https://docs.example.com/guide/next'));
});

test('htmlToMarkdown：表格转 GFM、图片被丢弃、无 main 时回落到 body', () => {
  const html =
    '<html><head><title>T</title></head><body><div id="content">' +
    '<h1>T</h1><img src="/logo.png" alt="logo">' +
    '<table><thead><tr><th>a</th><th>b</th></tr></thead>' +
    '<tbody><tr><td>1</td><td>2</td></tr></tbody></table>' +
    '</div></body></html>';
  const r = htmlToMarkdown(html, { url: 'https://a.com/p' });
  assert.match(r.markdown, /\| a \| b \|/);
  assert.match(r.markdown, /\| 1 \| 2 \|/);
  assert.ok(!r.markdown.includes('logo.png'), '图片不应进 markdown');
});

test('tidyMarkdown：收敛多余空行与行尾空白（保证两次抓取字节一致）', () => {
  assert.equal(tidyMarkdown('a  \n\n\n\nb\n'), 'a\n\nb');
  assert.equal(tidyMarkdown('\n\n  x  \n'), 'x');
});

test('isHtmlContentType / isXmlContentType', () => {
  assert.equal(isHtmlContentType('text/html; charset=utf-8'), true);
  assert.equal(isHtmlContentType('application/xhtml+xml'), true);
  assert.equal(isHtmlContentType('application/json'), false);
  assert.equal(isHtmlContentType(''), false);
  assert.equal(isXmlContentType('application/xml; charset=utf-8'), true);
  assert.equal(isXmlContentType('text/html'), false);
});

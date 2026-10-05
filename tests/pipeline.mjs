// 全链路流水线测试：把「一个 agent 装完 skill 之后要做的一整串事」真跑一遍。
//
// 为什么单独一个文件、且不进 pnpm test 的默认串：它会真的起 zg、真的建索引
// （几秒到几十秒）、真往磁盘写向量，属于**集成**验证。默认测试串要保持秒级，
// 所以它由 `pnpm run test:pipeline` 单独跑，并由 CI 的流水线步骤调用。
//
// 每一步都独立成一个子测试（`t.test`），失败时能一眼看出卡在哪一环——
// 这正是「每一步都做流水线测试」的字面要求。链条是：
//
//   P0  skill 安装       nx-kn skill install --to <临时目录>
//   P0b skill 导出       nx-kn skill get（外部 agent 的取用形态）
//   P1  空现场           nx-kn status        → 引导到 kb add
//   P2  加库             nx-kn kb add <vault>
//   P3  建索引（零配置） nx-kn index          ← 不给 --model，验证默认兜底
//   P4  复检状态         nx-kn status        → 已建 / 覆盖度 / 模型
//   P5  检索并读全文     nx-kn query         ← 拼 <vault>/<path> 必须能读到
//   P6  增量索引         nx-kn index          → added 1 / unchanged 2（旧向量保留）
//   P7  新笔记可召回     nx-kn query
//   P8  多库合并         kb add + index + query → 命中带来源库
//   P9  移除             kb remove            → 只解登记、不删索引
//   P10 采集（爬虫）     crawl add + run      → 本地「文档站」抓成 markdown（不联网）
//   P11 采集增量         crawl run            → 内容未变 0 重写；改一页只重写该页
//   P12 采集内容可检索   index + query        → 抓下来的词能命中、能读到原文
//   P13 采集移除         crawl remove         → 默认保留文件与知识库登记；--purge 连目录删
//   P14 守护（watch）     watch（常驻）        → 写一篇新笔记，不手动 index 也能检索到
//   P15 外部引擎          crawl add + run      → skill-seekers 后端全链路（假引擎，不联网）
//   P16 本地目录源        crawl add 本地目录   → skill-seekers 整理入库 + 引擎双闸（假引擎，不联网）
//   P17 一键流水线        pipeline             → 抓取 + 索引一条命令串完 + 幂等（假引擎，不联网）
//   P18 一步直达          pipeline <目录>      → 未登记自动登记再抓取 + 索引；同目录重复 = 增量
//
// 隔离：临时 store + 临时 skills 目录 + 临时 vault，绝不碰用户的真实数据。
// （采集产物目录跟着 store 走，见 core/paths.js 的 sourcesDir()——所以隔离是全覆盖的。）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_EMBEDDING } from '../src/core/paths.js';
import { INDEX_DIR, probe } from '../src/core/zg.js';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'kn.mjs');

// CI 上不想每次拉 600 MB 的默认模型：用 NX_KN_PIPELINE_MODEL 指一个小模型
// （如 local/potion-code-16m-v2），nx-kn 会通过 NX_KN_EMBEDDING 采纳它。
// 不设则走内置默认——那才是「干净机器零配置」要证明的那条路。
const PIPELINE_MODEL = process.env.NX_KN_PIPELINE_MODEL || '';
const EXPECTED_MODEL = PIPELINE_MODEL || DEFAULT_EMBEDDING;

// execFile 不走 shell，参数以数组传入：路径里的空格、中文都不会被再切一次。
function run(args, env = {}, { timeoutMs = 300_000 } = {}) {
  return exec(process.execPath, [BIN, ...args], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
}

async function runJson(args, env, opts) {
  const { stdout } = await run(args, env, opts);
  return JSON.parse(stdout);
}

// 轮询等待：谓词返回真值即返回它，超时则抛出（带上上下文，方便看进程输出）。
// 守护是**异步**的（文件事件 → 防抖 → 索引），只能等，不能假设「写完就绪」。
async function waitFor(fn, { timeoutMs = 60_000, stepMs = 1000, dump } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) {
      throw new Error(`等待超时（${timeoutMs}ms）${dump ? `\n--- 上下文 ---\n${dump()}` : ''}`);
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

const NOTE_A = `---
title: 登录超时排查
tags: [auth, 登录]
---

# 登录超时排查

会话过期导致登录页提示「登录超时」。鉴权令牌刷新失败时，前端会重复跳转登录页。
`;

const NOTE_B = `# 场景 DSL

when / then 的语法约定：用 when 描述前置条件，用 then 描述期望结果。
`;

const NOTE_C = `# 标签视图主题化

配色由 primary 派生，tag-active 用 70% mixWhite。高亮边界留白 8px。
`;

const NOTE_D = `# 打包发布流程

先用 pnpm build，再跑 npm publish。打 tag 之前先确认版本号。
`;

// 守护测试专用：关键词在别处（含 crawl 抓下来的页面）都不出现，
// 一旦检索到它就只可能是「守护把这篇新笔记写进了索引」。
const NOTE_W = `# 守护自动索引

守护监听到这篇新笔记后应当自动建索引。它独有的词是「鲸落守护」。
`;

// ---- 本地「文档站」：采集链路测试用它代替真实站点 ----
//
// 为什么不用真站点：流水线的目标是「CI 可复现全链路」。依赖别人的站点，
// CI 会因为对方波动/改版而红——那是把不确定性引进门。这里用 node:http 起一个
// 静态站，带 sitemap、导航/页脚噪声、以及每页独有的关键词，足以覆盖
// 「发现 → 抓取 → 清洗 → 落盘 → 增量」的每一步。
function docPage(title, keyword, links = []) {
  return `<!doctype html><html><head><title>${title}</title></head><body>
  <nav>SITE-NAV</nav>
  <main>
    <h1>${title}</h1>
    <p>${keyword} 是这一页独有的关键词。</p>
    ${links.map(([href, text]) => `<a href="${href}">${text}</a>`).join('\n')}
  </main>
  <footer>SITE-FOOTER</footer>
</body></html>`;
}

function startDocSite() {
  const pages = new Map([
    ['/', docPage('首页', 'homeword-unique', [['/guide/getting-started', 'Getting started'], ['/api/reference', 'API reference']])],
    ['/guide/getting-started', docPage('Getting Started', 'guideword-unique', [['/api/reference', 'API reference']])],
    ['/api/reference', docPage('API Reference', 'apiword-unique', [])],
  ]);

  const server = http.createServer((req, res) => {
    const host = req.headers.host;
    const u = new URL(req.url, `http://${host}`);
    if (u.pathname === '/sitemap.xml') {
      const body =
        '<?xml version="1.0" encoding="UTF-8"?>\n<urlset>\n' +
        [...pages.keys()].map((p) => `  <url><loc>http://${host}${p}</loc></url>`).join('\n') +
        '\n</urlset>\n';
      res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
      res.end(body);
      return;
    }
    if (pages.has(u.pathname)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pages.get(u.pathname));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  return new Promise((ready) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      ready({
        base: `http://127.0.0.1:${port}/`,
        set: (p, html) => pages.set(p, html),
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test('流水线：skill 安装 → 建库 → 建索引 → 检索 → 增量 → 多库 → 移除', async (t) => {
  const zg = await probe();
  if (!zg.installed) {
    t.skip(`本机未安装 zg（${zg.error || '未找到'}），全链路流水线无法进行——先 npm i -g @zvec/zvec-grep`);
    return;
  }

  const base = mkdtempSync(join(tmpdir(), 'nx-kn-pipe-'));
  const skillsDir = join(base, 'skills');
  const vaultA = join(base, 'Vault Alpha');
  const vaultB = join(base, 'Vault Beta');
  mkdirSync(skillsDir, { recursive: true });
  mkdirSync(vaultA, { recursive: true });
  mkdirSync(vaultB, { recursive: true });
  mkdirSync(join(vaultA, '.obsidian'), { recursive: true }); // 认得出是 Obsidian vault
  writeFileSync(join(vaultA, 'a.md'), NOTE_A, 'utf8');
  writeFileSync(join(vaultA, 'b.md'), NOTE_B, 'utf8');
  writeFileSync(join(vaultB, 'd.md'), NOTE_D, 'utf8');

  // NX_KN_VAULT 必须清空：一旦在场，它会压过 store 列表，多库这条路就走不到了。
  // NX_KN_EMBEDDING 显式给出（或显式清空），免得开发机 shell 里的残留影响判定。
  // NX_KN_CRAWL_DELAY_MS=0：抓取的礼貌间隔在测试里要关掉，否则几十页会白等。
  const env = {
    NX_KN_STORE: join(base, 'store.json'),
    NX_KN_VAULT: '',
    NX_KN_EMBEDDING: PIPELINE_MODEL,
    NX_KN_CRAWL_DELAY_MS: '0',
  };

  t.after(() => {
    // 索引与 vault 都在这个临时目录里，删掉即清理干净（不动用户任何数据）
    try {
      rmSync(base, { recursive: true, force: true });
    } catch {
      /* 文件锁导致的删除失败不影响测试结论 */
    }
  });

  await t.test('P0 skill 安装：SKILL.md 与 references 落地，重复安装幂等', async () => {
    const r = await runJson(['skill', 'install', '--to', skillsDir, '--json'], env);
    assert.equal(r.status, 'ok');
    assert.ok(r.files >= 2, `至少应装 SKILL.md + references（实际 ${r.files} 个文件）`);

    const installedSkill = join(skillsDir, 'nx-kn', 'SKILL.md');
    assert.ok(existsSync(installedSkill), `skill 未落盘: ${installedSkill}`);
    assert.ok(
      existsSync(join(skillsDir, 'nx-kn', 'references', '10-knowledge-base.md')),
      'references 没跟着装过去（agent 只能读到半份文档）'
    );
    assert.equal(
      readFileSync(installedSkill, 'utf8'),
      readFileSync(join(ROOT, 'assets', 'nx-kn', 'SKILL.md'), 'utf8'),
      '装过去的 SKILL.md 与随包内容不一致'
    );

    const again = await runJson(['skill', 'install', '--to', skillsDir, '--json'], env);
    assert.equal(again.skipped, true, '内容没变时重复安装应当跳过（幂等）');
  });

  await t.test('P0b skill get：外部 agent 能一次取到文档全文与安装状态', async () => {
    const r = await runJson(['skill', 'get', '--to', skillsDir, '--json'], env);
    assert.equal(r.skillName, 'nx-kn');
    assert.equal(r.ref, 'SKILL.md');
    assert.ok(r.contentBytes > 500, `导出的正文过短（${r.contentBytes} 字节）`);
    assert.match(r.content, /agent 典型会话/, '导出内容应是真正的 SKILL.md');
    assert.equal(r.install.status, 'ok');
  });

  await t.test('P1 空现场：status 不报错，而是把人引到 kb add', async () => {
    const r = await runJson(['status', '--json'], env);
    assert.equal(r.status, 'ok');
    assert.equal(r.configured, false);
    assert.deepEqual(r.vaults, []);
    assert.match(r.hint, /kb add/, '第一句该告诉用户怎么加库');
  });

  await t.test('P2 加库：kb add 登记成功并读到笔记数', async () => {
    const r = await runJson(['kb', 'add', vaultA, '--json'], env);
    assert.equal(r.status, 'ok');
    assert.equal(r.added, true);
    assert.equal(r.count, 1);
    assert.equal(r.notes, 2, 'vault A 里有 2 篇可索引的 md');
    assert.equal(r.obsidian, true, '有 .obsidian/ 应被识别为 Obsidian vault');
    assert.equal(r.indexed, false);

    const dup = await runJson(['kb', 'add', vaultA, '--json'], env);
    assert.equal(dup.added, false, '按绝对路径去重');
    assert.equal(dup.count, 1);
  });

  await t.test('P3 建索引（不给 --model）：走内置默认，零手动配置', async () => {
    // 关键一条：argv 里**没有** --model。干净机器上 zg 没有全局默认模型，
    // 全靠 nx-kn 的兜底。这里一失败，就说明「装完 skill 还得用户自己去配模型」。
    const r = await runJson(['index', '--json'], env, { timeoutMs: 900_000 });
    assert.equal(r.status, 'ok');
    assert.equal(r.rebuild, false);

    const res = r.results[0];
    assert.equal(res.mode, 'incremental');
    assert.equal(res.model, EXPECTED_MODEL, '不给 --model 时应落到默认模型');
    assert.ok(res.index, 'index 之后必须能读到索引状态');
    assert.ok(res.index.files > 0, '索引里应至少有 1 个文件');
    assert.equal(res.index.files, res.index.filesTotal, '首次索引应当全覆盖');
    assert.equal(res.index.embedding.model, EXPECTED_MODEL);
  });

  await t.test('P3b 再跑一次 index：无改动 → 不重复嵌入（added 0）', async () => {
    const r = await runJson(['index', '--json'], env, { timeoutMs: 900_000 });
    const c = r.results[0].changes;
    assert.equal(c.added, 0, '没有新笔记就不该新增');
    assert.ok(c.unchanged >= 2, `已有向量应原样保留（unchanged=${c.unchanged}）`);
  });

  await t.test('P4 复检状态：已建、覆盖度、生效模型都对得上', async () => {
    const r = await runJson(['status', '--json'], env);
    assert.equal(r.configured, true);
    assert.equal(r.totals.vaults, 1);
    assert.equal(r.totals.indexed, 1);

    const v = r.vaults[0];
    assert.equal(v.indexed, true);
    assert.equal(v.notes, 2);
    assert.equal(v.model, EXPECTED_MODEL);
    assert.equal(v.index.embedding.model, EXPECTED_MODEL);
    assert.equal(v.index.files, v.index.filesTotal);
    assert.ok(v.index.entities > 0);
  });

  await t.test('P5 检索：命中带库根与 score，拼绝对路径能读到原文', async () => {
    const r = await runJson(['query', '登录超时', '--json'], env);
    assert.equal(r.status, 'ok');
    assert.ok(r.hits.length > 0, '「登录超时」应当命中 a.md');
    assert.equal(r.searched.length, 1);

    const h = r.hits[0];
    assert.equal(h.vault, vaultA, '命中必须带上是哪个库');
    assert.ok(h.score != null, '多库合并靠 score 排序，--trace 必须生效');
    assert.ok(h.matchedBy.length > 0);

    // 这一步才是「skill 有用」的落点：agent 拿到相对路径后拼出的绝对路径
    // 必须真的存在、而且真的含被问的内容。
    const abs = join(h.vault, h.path);
    assert.ok(existsSync(abs), `按提示拼出的路径不存在: ${abs}`);
    assert.match(readFileSync(abs, 'utf8'), /登录超时/);
  });

  await t.test('P6 增量索引：加一篇 → added 1 / unchanged 2（旧向量保留）', async () => {
    writeFileSync(join(vaultA, 'c.md'), NOTE_C, 'utf8');
    const r = await runJson(['index', '--json'], env, { timeoutMs: 900_000 });
    const res = r.results[0];
    assert.equal(res.mode, 'incremental', '没给 --rebuild 就必须是增量');
    assert.equal(res.changes.added, 1);
    assert.equal(res.changes.unchanged, 2, '旧的两篇不该被重新嵌入');
    assert.equal(res.index.files, 3);
  });

  await t.test('P7 新笔记可召回：只在新文件里的词也能命中', async () => {
    const r = await runJson(['query', '标签视图', '--json'], env);
    assert.ok(
      r.hits.some((h) => h.path === 'c.md'),
      `应命中新加的 c.md，实际命中: ${r.hits.map((h) => h.path).join(', ')}`
    );
  });

  await t.test('P8 多库：加第二个库并建索引，跨库命中带来源库名', async () => {
    await runJson(['kb', 'add', vaultB, '--json'], env);
    const idx = await runJson(['index', '--json'], env, { timeoutMs: 900_000 });
    assert.equal(idx.count, 2, '两个库都应被索引到');

    const r = await runJson(['query', '打包发布', '--json'], env);
    assert.equal(r.searched.length, 2, '两个库都应参与检索');
    assert.deepEqual(r.searched.map((s) => s.path).sort(), [vaultA, vaultB].sort());

    const hit = r.hits.find((h) => h.path === 'd.md');
    assert.ok(hit, `应命中 vault B 的 d.md，实际命中: ${r.hits.map((h) => h.path).join(', ')}`);
    assert.equal(hit.vault, vaultB);
    assert.equal(hit.vaultName, basename(vaultB), '命中要带上来源库名（相对路径跨库会歧义）');
  });

  await t.test('P9 移除：只解除登记，磁盘上的索引原样留在库里', async () => {
    const r1 = await runJson(['kb', 'remove', vaultB, '--json'], env);
    assert.equal(r1.count, 1);
    assert.ok(existsSync(join(vaultB, INDEX_DIR)), 'kb remove 不该删索引（索引归 zg 所有）');

    const r2 = await runJson(['kb', 'remove', vaultA, '--json'], env);
    assert.equal(r2.count, 0);
    const list = await runJson(['kb', 'list', '--json'], env);
    assert.equal(list.count, 0);
  });

  // ---- 阶段 5：外部资料采集（爬虫）。全程打本地静态站，CI 不联网。 ----

  await t.test('P10 采集：crawl add + run 把「文档站」抓成 markdown 并自动登记为知识库', async (t2) => {
    const site = await startDocSite();
    t2.after(() => site.close());

    const add = await runJson(
      ['crawl', 'add', site.base, '--name', 'localdocs', '--engine', 'node', '--json'],
      env
    );
    assert.equal(add.name, 'localdocs');
    assert.equal(add.engine, 'node', '显式指定的引擎应原样回读');
    assert.equal(add.max, 200, '默认上限 200 页');

    // 登记后还没抓 → 0 页
    const before = await runJson(['crawl', 'list', '--json'], env);
    assert.equal(before.count, 1);
    assert.equal(before.sources[0].pages, 0);
    assert.equal(before.sources[0].registered, false);
    assert.equal(before.sources[0].engine, 'node', '引擎要能从 store 里读回来');

    // 注意这里**没有**再传 --engine：默认引擎是 skill-seekers（外部），而本用例的底线是
    // 「不联网可复现」——绝不能因为默认值变了就去调 Python / 拉依赖。
    // 不传也顺带验证了「源的引擎真的存进了 store，并被 run 采纳」。
    const r = await runJson(['crawl', 'run', '--name', 'localdocs', '--json'], env, { timeoutMs: 120_000 });
    const res = r.results[0];
    assert.equal(res.engine, 'node', '未传 --engine 时应采纳源上存着的引擎');
    assert.equal(res.via, 'sitemap', '本地站带 sitemap.xml，应走 sitemap 发现');
    assert.equal(res.pages, 3);
    assert.equal(res.changes.added, 3, '三页都应是新增');
    assert.equal(res.failed, 0);

    // 落盘：每个 URL 一个 .md，带 frontmatter
    const dir = res.dir;
    for (const f of ['index.md', join('guide', 'getting-started.md'), join('api', 'reference.md')]) {
      assert.ok(existsSync(join(dir, f)), `应落盘: ${join(dir, f)}`);
    }
    const body = readFileSync(join(dir, 'guide', 'getting-started.md'), 'utf8');
    assert.match(body, /^---\nsource: /, '应有 frontmatter');
    assert.match(body, /# Getting Started/);
    assert.match(body, /guideword-unique/);
    assert.ok(!body.includes('SITE-NAV'), '页面导航不应进 markdown');
    assert.ok(!body.includes('SITE-FOOTER'), '页脚不应进 markdown');

    // 抓完自动登记为知识库（与手动 kb add 完全同构）
    const kb = await runJson(['kb', 'list', '--json'], env);
    assert.equal(kb.count, 1, '抓完应自动登记为 1 个知识库');
    assert.equal(resolve(kb.vaults[0].path), resolve(dir));

    const after = await runJson(['crawl', 'list', '--json'], env);
    assert.equal(after.sources[0].pages, 3);
    assert.equal(after.sources[0].registered, true);
    assert.ok(after.sources[0].lastRunAt, '应记录上次抓取时间');
  });

  await t.test('P11 采集增量：内容未变 → 0 重写；改一页 → 只重写那一页', async (t2) => {
    const site = await startDocSite();
    t2.after(() => site.close());

    // 同样钉死内置引擎：这条用例只关心增量语义，不该被外部引擎的默认值带进网络与 Python。
    await runJson(['crawl', 'add', site.base, '--name', 'inc', '--engine', 'node', '--json'], env);
    const first = await runJson(['crawl', 'run', '--name', 'inc', '--json'], env, { timeoutMs: 120_000 });
    assert.equal(first.results[0].changes.added, 3);

    // 第二次：站点没变。哈希只算正文（frontmatter 里的 fetchedAt 每次都变），
    // 所以这里必须报 3 未变、0 新增 0 更新——否则增量就失效了。
    const again = await runJson(['crawl', 'run', '--name', 'inc', '--json'], env, { timeoutMs: 120_000 });
    const c2 = again.results[0].changes;
    assert.equal(c2.added, 0, '没改动不该新增');
    assert.equal(c2.updated, 0, '没改动不该重写（内容哈希一致）');
    assert.equal(c2.unchanged, 3);

    // 改一页内容后重抓：只有那一页被重写
    site.set('/api/reference', docPage('API Reference', 'apiword-changed', []));
    const third = await runJson(['crawl', 'run', '--name', 'inc', '--json'], env, { timeoutMs: 120_000 });
    const c3 = third.results[0].changes;
    assert.equal(c3.updated, 1, '只有改动过的那一页该被重写');
    assert.equal(c3.unchanged, 2);
    assert.match(readFileSync(join(third.results[0].dir, 'api', 'reference.md'), 'utf8'), /apiword-changed/);
  });

  await t.test('P12 采集内容可检索：index + query 命中抓下来的页面并读到原文', async () => {
    // P10/P11 抓下来的两个目录都已自动登记为知识库
    const kbBefore = await runJson(['kb', 'list', '--json'], env);
    assert.equal(kbBefore.count, 2, 'P10 与 P11 各登记了一个知识库');

    const idx = await runJson(['index', '--json'], env, { timeoutMs: 900_000 });
    assert.equal(idx.status, 'ok');
    assert.equal(idx.count, 2);

    const r = await runJson(['query', 'guideword-unique', '--json'], env);
    assert.ok(r.hits.length > 0, '抓下来的页面内容应能被检索到');
    const h = r.hits[0];
    const abs = join(h.vault, h.path);
    assert.ok(existsSync(abs), `按提示拼出的路径不存在: ${abs}`);
    assert.match(readFileSync(abs, 'utf8'), /guideword-unique/);
  });

  await t.test('P13 采集移除：默认保留文件与知识库登记；--purge 连目录一起删', async () => {
    const l = await runJson(['crawl', 'list', '--json'], env);
    const localdocs = l.sources.find((s) => s.name === 'localdocs');
    assert.ok(localdocs, 'localdocs 应在列表里');

    const r1 = await runJson(['crawl', 'remove', 'localdocs', '--json'], env);
    assert.equal(r1.removed, 'localdocs');
    assert.equal(r1.purged, null, '默认不该删目录');
    assert.ok(existsSync(join(localdocs.dir, 'index.md')), '默认应保留抓下来的文件');
    const kb1 = await runJson(['kb', 'list', '--json'], env);
    assert.ok(
      kb1.vaults.some((v) => resolve(v.path) === resolve(localdocs.dir)),
      '默认应保留知识库登记（抓下来的目录仍是有用的知识库）'
    );

    const r2 = await runJson(['crawl', 'remove', 'inc', '--purge', '--json'], env);
    assert.ok(r2.purged, '--purge 应返回被删目录');
    assert.ok(!existsSync(r2.purged), '--purge 应真的把目录删掉');
    const kb2 = await runJson(['kb', 'list', '--json'], env);
    assert.ok(
      !kb2.vaults.some((v) => resolve(v.path) === resolve(r2.purged)),
      '--purge 应连带撤掉知识库登记'
    );

    const r3 = await runJson(['crawl', 'list', '--json'], env);
    assert.equal(r3.count, 0);
  });

  // ---- 外部引擎（Skill Seekers）：用假引擎验证整条链路，全程离线 ----
  //
  // 真跑 skill-seekers 要联网拉约 50 MB 依赖、还要求 Python 3.10+ —— 那会捅破
  // 「CI 不联网可复现」的底线。但这条链路（spawn → 产出目录 → 摘 md → 增量 → 登记知识库）
  // 是**真实的代码路径**，必须有测试盯着，所以用 NX_KN_SKILL_SEEKERS_CMD 指向假引擎。
  // 假引擎只模拟真实引擎唯一被我们依赖的行为：把产物落在 <cwd>/output/<name>/ 下。

  await t.test('P15 外部引擎：skill-seekers 后端把产出摘成 markdown 并自动登记（假引擎，不联网）', async () => {
    const fake = join(ROOT, 'tests', 'fixtures', 'fake-skill-seekers.mjs');
    assert.ok(existsSync(fake), `缺假引擎 fixture: ${fake}`);
    const ssEnv = { ...env, NX_KN_SKILL_SEEKERS_CMD: JSON.stringify([process.execPath, fake]) };

    const add = await runJson(
      ['crawl', 'add', 'https://example.invalid/docs/', '--name', 'ssdocs', '--engine', 'skill-seekers', '--json'],
      ssEnv
    );
    assert.equal(add.engine, 'skill-seekers');
    assert.equal(add.enhanceLevel, 0, '增强级别默认 0 = 纯抓取，不调任何 LLM');

    const r = await runJson(['crawl', 'run', '--name', 'ssdocs', '--json'], ssEnv, { timeoutMs: 120_000 });
    const res = r.results[0];
    assert.equal(res.engine, 'skill-seekers');
    assert.equal(res.via, 'skill-seekers');
    assert.equal(res.pages, 2, '假引擎产出 SKILL.md + references/guide.md 两个 md');
    assert.equal(res.changes.added, 2);
    assert.equal(res.failed, 0);

    // 落盘：md 摘进来，非 md（scripts-search.py）不摘
    const dir = res.dir;
    assert.ok(existsSync(join(dir, 'SKILL.md')), `应落盘: ${join(dir, 'SKILL.md')}`);
    assert.ok(existsSync(join(dir, 'references', 'guide.md')));
    assert.ok(!existsSync(join(dir, 'scripts-search.py')), '非 markdown 的产物不该进知识库');
    const ref = readFileSync(join(dir, 'references', 'guide.md'), 'utf8');
    assert.match(ref, /skseeker-ref-word/, '外部引擎产出的内容应原样保留');
    assert.match(ref, /^---\nsource: /, '外部引擎的产出也应补上来源 frontmatter');

    // 自动登记为知识库（与内置引擎完全同构）
    const kb = await runJson(['kb', 'list', '--json'], ssEnv);
    assert.ok(
      kb.vaults.some((v) => resolve(v.path) === resolve(dir)),
      '外部引擎的产出也应自动登记为知识库'
    );

    // 增量：内容未变 → 0 重写
    const again = await runJson(['crawl', 'run', '--name', 'ssdocs', '--json'], ssEnv, { timeoutMs: 120_000 });
    const c2 = again.results[0].changes;
    assert.equal(c2.added, 0, '没改动不该新增');
    assert.equal(c2.updated, 0, '内容哈希一致时不该重写');
    assert.equal(c2.unchanged, 2);

    // list 里要能看到引擎（面板与 CLI 都靠它说明「这个源是怎么抓的」）
    const l = await runJson(['crawl', 'list', '--json'], ssEnv);
    const row = l.sources.find((s) => s.name === 'ssdocs');
    assert.equal(row.engine, 'skill-seekers');

    // 收尾：连目录与知识库登记一起撤掉，别给后面的守护用例留下额外状态
    await runJson(['crawl', 'remove', 'ssdocs', '--purge', '--json'], ssEnv);
  });

  await t.test('P15b 外部引擎：命令不存在时报错并指出两条出路（绝不静默回落）', async () => {
    const ssEnv = { ...env, NX_KN_SKILL_SEEKERS_CMD: join(tmpdir(), 'nx-kn-no-such-ss-bin') };

    await runJson(
      ['crawl', 'add', 'https://example.invalid/x/', '--name', 'ssfail', '--engine', 'skill-seekers', '--json'],
      ssEnv
    );

    await assert.rejects(
      () => runJson(['crawl', 'run', '--name', 'ssfail', '--json'], ssEnv, { timeoutMs: 60_000 }),
      (err) => {
        const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
        assert.match(out, /skill-seekers/, '错误里要点明是哪一步失败');
        assert.match(out, /--engine node/, '要给出「换内置引擎」这条出路');
        return true;
      },
      '默认引擎是外部的，但装不上时必须**响亮失败**并给出替代方案，而不是悄悄换个引擎跑'
    );

    await runJson(['crawl', 'remove', 'ssfail', '--purge', '--json'], ssEnv);
  });

  // ---- 阶段 5b：本地目录源（如 Obsidian vault 走整理入库）。假引擎，不联网。 ----

  await t.test('P16 本地目录源：crawl add 本地目录 → skill-seekers 整理 → 自动登记为知识库（假引擎，不联网）', async () => {
    const fake = join(ROOT, 'tests', 'fixtures', 'fake-skill-seekers.mjs');
    const ssEnv = { ...env, NX_KN_SKILL_SEEKERS_CMD: JSON.stringify([process.execPath, fake]) };

    // 模拟一个本地 Obsidian vault：含 .obsidian、子目录、中文笔记与一张图片
    const localVault = join(base, 'Local Vault');
    mkdirSync(join(localVault, 'notes'), { recursive: true });
    mkdirSync(join(localVault, '.obsidian'), { recursive: true });
    writeFileSync(join(localVault, '笔记A.md'), '# 笔记A\n\n本地目录整理测试。\n', 'utf8');
    writeFileSync(join(localVault, 'notes', '笔记B.md'), '# 笔记B\n\n子目录笔记。\n', 'utf8');
    writeFileSync(join(localVault, 'pic.png'), 'not really png', 'utf8');

    const add = await runJson(['crawl', 'add', localVault, '--name', 'localvault', '--json'], ssEnv);
    assert.equal(add.kind, 'local', '存在的目录应被识别为本地源');
    assert.equal(add.engine, 'skill-seekers', '本地源引擎默认（且只认）skill-seekers');
    assert.equal(resolve(add.url), resolve(localVault), '本地源的 url 应是 resolve 后的绝对路径');

    const r = await runJson(['crawl', 'run', '--name', 'localvault', '--json'], ssEnv, { timeoutMs: 120_000 });
    const res = r.results[0];
    assert.equal(res.kind, 'local');
    assert.equal(res.engine, 'skill-seekers');
    assert.equal(res.pages, 2, '假引擎产出 SKILL.md + references/guide.md 两个 md');
    assert.equal(res.changes.added, 2);

    // 落盘：md 摘进来；png 不摘（只收 .md 的纪律对本地源同样成立）
    assert.ok(existsSync(join(res.dir, 'SKILL.md')), `应落盘: ${join(res.dir, 'SKILL.md')}`);
    assert.ok(existsSync(join(res.dir, 'references', 'guide.md')));
    const skill = readFileSync(join(res.dir, 'SKILL.md'), 'utf8');
    assert.match(skill, /^---\n/, '整理产物应补 frontmatter（假引擎产出不带）');
    assert.match(skill, /source: "?.*Local Vault/, 'frontmatter 的 source 指向本地目录');

    // 原始 vault 不被写脏：整理产物落在 sources 目录，不在原目录里长出任何东西
    assert.ok(!existsSync(join(localVault, 'SKILL.md')), '原始目录不该被写进整理产物');

    // 自动登记为知识库（与文档站源完全同构）
    const kb = await runJson(['kb', 'list', '--json'], ssEnv);
    assert.ok(
      kb.vaults.some((v) => resolve(v.path) === resolve(res.dir)),
      '本地源的整理产物也应自动登记为知识库'
    );

    // list 能看到 kind（面板与 CLI 都靠它区分本地源与文档站源）
    const l = await runJson(['crawl', 'list', '--json'], ssEnv);
    assert.equal(l.sources.find((s) => s.name === 'localvault').kind, 'local');

    await runJson(['crawl', 'remove', 'localvault', '--purge', '--json'], ssEnv);
  });

  await t.test('P16b 本地目录源：--engine node 一律拒绝（add 与 run 双闸）', async () => {
    const fake = join(ROOT, 'tests', 'fixtures', 'fake-skill-seekers.mjs');
    const ssEnv = { ...env, NX_KN_SKILL_SEEKERS_CMD: JSON.stringify([process.execPath, fake]) };
    const localVault = join(base, 'Local Vault'); // P16 建的目录还在

    await assert.rejects(
      () => runJson(['crawl', 'add', localVault, '--name', 'badengine', '--engine', 'node', '--json'], ssEnv),
      (err) => {
        const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
        assert.match(out, /本地目录源只支持 skill-seekers/);
        return true;
      },
      '本地源选 node 引擎必须在登记时就响亮拒绝'
    );

    // 登记（默认引擎）后再用 run --engine node 覆盖，同样拒绝
    await runJson(['crawl', 'add', localVault, '--name', 'localvault2', '--json'], ssEnv);
    await assert.rejects(
      () => runJson(['crawl', 'run', '--name', 'localvault2', '--engine', 'node', '--json'], ssEnv),
      (err) => {
        const out = `${err.stdout || ''}${err.stderr || ''}${err.message || ''}`;
        assert.match(out, /本地目录源只支持 skill-seekers/);
        return true;
      },
      'run 覆盖引擎这条路也要拦住'
    );
    await runJson(['crawl', 'remove', 'localvault2', '--purge', '--json'], ssEnv);
  });

  // ---- 阶段 4：守护（watch）。真起一个常驻进程，证明「不手动 index 也能检索到」。 ----

  await t.test('P14 守护：起常驻 watch，写一篇新笔记就能检索到（无需手动 index）', async (t2) => {
    // P9 / P13 把库都移除了，这里重新登记 vault A。
    // 索引文件仍在磁盘上（kb remove 不删索引），所以守护只需补那一篇新笔记。
    await runJson(['kb', 'add', vaultA, '--json'], env);

    const before = await runJson(['query', '鲸落守护', '--json'], env);
    assert.ok(
      !before.hits.some((h) => h.path === 'watch-new.md'),
      '守护之前不该有这篇笔记的索引'
    );

    // 真起**常驻进程**而不是直接调函数：这样连「命令面 + 进程生命周期」一起验，
    // 也才叫「装完 skill 之后这件事能自动做完」。
    const child = spawn(process.execPath, [BIN, 'watch'], {
      cwd: tmpdir(),
      // 防抖压到 200ms：默认 1500ms 是给真人打字用的，测试里白等
      env: { ...process.env, ...env, NX_KN_WATCH_DEBOUNCE_MS: '200' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    const stop = () => { try { child.kill(); } catch { /* 已退出 */ } };
    t2.after(stop);

    try {
      // P14a 启动：常驻命令要先能起来并报出监听的库
      await waitFor(() => /守护已启动/.test(out), {
        timeoutMs: 30_000,
        stepMs: 200,
        dump: () => out,
      });

      // P14b 触发：往已登记的库里写一篇新笔记，**不跑任何 index 命令**
      writeFileSync(join(vaultA, 'watch-new.md'), NOTE_W, 'utf8');

      // P14c 等守护自己报「已增量更新」。
      //
      // 这一步刻意**不用 `query` 轮询**：zg 的 query 会在这个 workspace 上取得读锁、
      // 还可能触发它自己的后台刷新，于是守护那侧的 `zg index` 会撞上
      // `ZVEC_GREP.ENGINE.LOCK.BUSY`（实测踩过）。等守护的日志既不碰索引，也更直接——
      // 它证明的正是「守护把这次改动自己处理掉了」。
      await waitFor(() => /已增量更新/.test(out), {
        timeoutMs: 120_000,
        stepMs: 500,
        dump: () => out,
      });

      // P14d 收效：此刻再检索一次，必须命中这篇「从没手动索引过」的笔记
      const hit = await waitFor(
        async () => {
          const r = await runJson(['query', '鲸落守护', '--json'], env, { timeoutMs: 120_000 });
          return r.hits.find((h) => h.path === 'watch-new.md') || null;
        },
        { timeoutMs: 30_000, stepMs: 2000, dump: () => out }
      );

      // 与 P5 同样的落点：agent 拼出的绝对路径必须真能读到原文
      const abs = join(hit.vault, hit.path);
      assert.ok(existsSync(abs), `按提示拼出的路径不存在: ${abs}`);
      assert.match(readFileSync(abs, 'utf8'), /鲸落守护/);
    } finally {
      stop();
    }
  });

  // ---- 阶段 6：一键流水线。抓取 → 索引是一条链上的前后两步，pipeline 把它们串完。 ----

  await t.test('P17 一键流水线：pipeline = 抓取 → 索引串完，结束即可检索，幂等重跑全未变（假引擎，不联网）', async () => {
    const fake = join(ROOT, 'tests', 'fixtures', 'fake-skill-seekers.mjs');
    const ssEnv = { ...env, NX_KN_SKILL_SEEKERS_CMD: JSON.stringify([process.execPath, fake]) };
    const localVault = join(base, 'Local Vault'); // P16 建的目录还在

    // P16/P16b 清掉了自己的源，这里重新登记一个本地源
    await runJson(['crawl', 'add', localVault, '--name', 'pipevault', '--json'], ssEnv);

    const r = await runJson(['pipeline', '--json'], ssEnv, { timeoutMs: 300_000 });
    assert.equal(r.status, 'ok', '两步都成功时整体才是 ok');
    const crawl = r.steps.find((s) => s.id === 'crawl');
    const index = r.steps.find((s) => s.id === 'index');
    assert.equal(crawl.status, 'ok', '有源时抓取步骤必须真跑');
    assert.equal(crawl.result.results[0].changes.added, 2, '假引擎产出 2 个 md');
    assert.equal(index.status, 'ok', '有库时索引步骤必须真跑（P14 重新登记的 vaultA + 本步产物）');
    assert.ok(index.result.results.length >= 2, `应至少索引 2 个库（vaultA + pipevault 产物），实际 ${index.result.results.length}`);

    // 链路收口：pipeline 结束后不跑任何 index/query，直接检索必须命中刚抓的产物
    const hit = await runJson(['query', 'skseeker-root-word', '--json'], ssEnv, { timeoutMs: 120_000 });
    assert.ok(
      hit.hits.some((h) => resolve(h.vault).includes('pipevault')),
      'pipeline 跑完的产物应无需任何后续命令即可被检索到'
    );

    // 幂等：再跑一遍，抓取全未变、索引仍 ok（增量）
    const r2 = await runJson(['pipeline', '--json'], ssEnv, { timeoutMs: 300_000 });
    assert.equal(r2.status, 'ok');
    const crawl2 = r2.steps.find((s) => s.id === 'crawl');
    assert.equal(crawl2.result.totals.unchanged, 2, '内容没变，第二遍应当全部 unchanged');

    await runJson(['crawl', 'remove', 'pipevault', '--purge', '--json'], ssEnv);
  });

  await t.test('P18 一步直达：pipeline <目录> 自动登记 + 整理 + 索引；同目录重复执行 = 增量（假引擎，不联网）', async () => {
    const fake = join(ROOT, 'tests', 'fixtures', 'fake-skill-seekers.mjs');
    const ssEnv = { ...env, NX_KN_SKILL_SEEKERS_CMD: JSON.stringify([process.execPath, fake]) };
    const localVault = join(base, 'Local Vault'); // P16 建的目录还在，源已被其清理

    // 不先 crawl add——把目录直接交给 pipeline，登记 → 抓取 → 索引一条命令完成
    const r = await runJson(['pipeline', localVault, '--json'], ssEnv, { timeoutMs: 300_000 });
    assert.equal(r.status, 'ok', '三步都成功时整体才是 ok');
    const reg = r.steps.find((s) => s.id === 'register');
    assert.ok(reg, '应有登记步骤');
    assert.equal(reg.result.added, true, '未登记的目录应自动登记');
    assert.equal(reg.result.name, 'Local-Vault', '不给 --name 时从目录名推导（空格折成连字符）');
    const crawl = r.steps.find((s) => s.id === 'crawl');
    assert.equal(crawl.status, 'ok');
    assert.equal(crawl.result.count, 1, '只跑刚登记的这一个源');
    assert.equal(crawl.result.results[0].changes.added, 2, '假引擎产出 2 个 md');

    // 链路收口：一步直达跑完即可检索（不再跑任何 index/query）
    const hit = await runJson(['query', 'skseeker-root-word', '--json'], ssEnv, { timeoutMs: 120_000 });
    assert.ok(
      hit.hits.some((h) => resolve(h.vault).includes('Local-Vault')),
      'pipeline <目录> 跑完的产物应无需任何后续命令即可被检索到'
    );

    // 幂等：同目录再跑——复用现源不重复登记，内容没变全 unchanged
    const r2 = await runJson(['pipeline', localVault, '--json'], ssEnv, { timeoutMs: 300_000 });
    const reg2 = r2.steps.find((s) => s.id === 'register');
    assert.equal(reg2.result.added, false, '同目录重复提供应复用现源，而不是报冲突');
    const crawl2 = r2.steps.find((s) => s.id === 'crawl');
    assert.equal(crawl2.result.totals.unchanged, 2, '内容没变，第二遍应当全部 unchanged');

    // 按源名直达也通（target 先按源名匹配）
    const r3 = await runJson(['pipeline', 'Local-Vault', '--json'], ssEnv, { timeoutMs: 300_000 });
    assert.equal(r3.steps.find((s) => s.id === 'register').result.added, false, '源名应直接命中现源');

    await runJson(['crawl', 'remove', 'Local-Vault', '--purge', '--json'], ssEnv);
  });
});

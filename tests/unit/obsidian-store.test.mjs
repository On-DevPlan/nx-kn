// obsidian 域：vault 定位、规范文档登记表、以及三个双链修复动作。
//
// 这套规则错在哪都不会报错，只会**误建笔记**（把已存在的笔记当成红链，又建一份）
// 或**读错规范**（按另一套内容风格写）。所以每条边界都钉住，尤其是三条：
//   1. 兜底只在「未设置」时发生，不在「设了但坏了」时发生（否则配置错误被藏起来）
//   2. 未设置是**业务结果**不是错误（skill 侧只需判标志位）
//   3. 归一化永不抛（它跑在每次 loadStore 里，包括 store 损坏隔离那条路径）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, initialState, mutateStore, normalize } from '../../src/core/store.js';
import * as obsidian from '../../src/modules/obsidian/service.js';

// 每次测试都把 store 指到临时目录 + 清掉 env 兜底，绝不碰用户真实数据。
function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-obsidian-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

// 一个「像样的 vault」：有 .obsidian/，有 nx-kn/ 规范目录与两份规范文档。
function fakeVault(withDocs = true) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-'));
  mkdirSync(join(dir, '.obsidian'));
  mkdirSync(join(dir, 'nx-kn'));
  if (withDocs) {
    writeFileSync(join(dir, 'nx-kn', 'base-content.md'), '# 内容生成规范\n', 'utf8');
    writeFileSync(join(dir, 'nx-kn', 'questionnaire.md'), '# 问卷模式 · 内容规范\n', 'utf8');
    writeFileSync(join(dir, 'nx-kn', 'frontmatter-spec.md'), '# Frontmatter 生成规范\n', 'utf8');
  }
  return dir;
}

// ---- 归一化：形状与垃圾输入 ----

test('initialState() 的 obsidian 形状固定（登记表 = 相对 vault 根的路径）', () => {
  assert.deepEqual(initialState().obsidian, {
    vault: '',
    docs: {
      content: 'nx-kn/base-content.md',
      questionnaire: 'nx-kn/questionnaire.md',
      frontmatter: 'nx-kn/frontmatter-spec.md',
    },
  });
});

test('normalize: obsidian 缺字段逐个补默认，部分键不影响其余键', () => {
  const n = normalize({ obsidian: { vault: 'D:\\V' } });
  assert.equal(n.obsidian.vault, 'D:\\V');
  assert.equal(n.obsidian.docs.content, 'nx-kn/base-content.md');
  assert.equal(n.obsidian.docs.questionnaire, 'nx-kn/questionnaire.md');
  assert.equal(n.obsidian.docs.frontmatter, 'nx-kn/frontmatter-spec.md');
});

test('normalize: 登记表已存在时**不补默认**（注销过的项要能留住）', () => {
  // 用户显式注销了 content —— 下次读取不能悄悄给它装回来
  const n = normalize({ obsidian: { vault: 'D:\\V', docs: { questionnaire: 'nx-kn/q.md' } } });
  assert.deepEqual(n.obsidian.docs, { questionnaire: 'nx-kn/q.md' });
  assert.equal('content' in n.obsidian.docs, false);
});

test('normalize: obsidian 是垃圾输入时回落默认且**不抛**（normalize 跑在每次 load 里）', () => {
  for (const garbage of [null, undefined, 'garbage', 42, [], true]) {
    const n = normalize({ obsidian: garbage });
    assert.deepEqual(n.obsidian, initialState().obsidian);
  }
});

test('normalize: 旧形状（specDir + contentDoc）迁移成登记表', () => {
  const n = normalize({
    obsidian: { vault: 'D:\\V', specDir: 'nx-kn', contentDoc: 'base-content.md', questionnaireDoc: 'questionnaire.md' },
  });
  assert.equal(n.obsidian.docs.content, 'nx-kn/base-content.md');
  assert.equal(n.obsidian.docs.questionnaire, 'nx-kn/questionnaire.md');
  assert.equal(n.obsidian.docs.frontmatter, 'nx-kn/frontmatter-spec.md', '迁移时也补齐其余默认登记项');
  assert.equal('specDir' in n.obsidian, false, '旧键不再保留（照 kb 的先例）');
  assert.equal('contentDoc' in n.obsidian, false);
});

test('normalize: 登记表里的反斜杠归一为 /（跨平台同一份配置）', () => {
  assert.equal(normalize({ obsidian: { docs: { content: 'a\\b.md' } } }).obsidian.docs.content, 'a/b.md');
});

// ---- vault 解析链 ----

test('vault 解析：--vault 参数 > store 配置 > 环境变量 > kb 登记库兜底', async () => {
  const dir = tmpData();
  const envVault = fakeVault();
  const kbVault = fakeVault();
  const flagVault = fakeVault();

  // 1) 什么都没设 → 未设置（业务结果，不是错误）
  let r = await obsidian.resolvePaths();
  assert.equal(r.configured, false);
  assert.equal(r.vault, null);
  assert.ok(r.hints.some((h) => h.includes('obsidian set')), '未设置时要给出可照做的提示');

  // 2) kb 兜底：只有含 .obsidian/ 的登记库算数
  await mutateStore((s) => {
    s.kb.vaults.push({ path: join(dir, 'not-a-vault') });
    s.kb.vaults.push({ path: kbVault });
  });
  r = await obsidian.resolvePaths();
  assert.equal(r.source, 'kb');
  assert.equal(r.vault, kbVault);

  // 3) 环境变量压过 kb 兜底
  process.env.NX_OBSIDIAN_VAULT = envVault;
  r = await obsidian.resolvePaths();
  assert.equal(r.source, 'env');
  assert.equal(r.vault, envVault);

  // 4) store 配置压过环境变量
  await mutateStore((s) => {
    s.obsidian.vault = kbVault;
  });
  r = await obsidian.resolvePaths();
  assert.equal(r.source, 'store');
  assert.equal(r.vault, kbVault);

  // 5) --vault 参数压过一切
  r = await obsidian.resolvePaths({ flagVault });
  assert.equal(r.source, 'flag');
  assert.equal(r.vault, flagVault);
});

test('vault 设了但目录被删：如实报 vaultExists=false，**不静默兜底到别的库**', async () => {
  tmpData();
  const gone = join(tmpdir(), 'nx-kn-vault-gone-' + Date.now());
  const kbVault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = gone;
    s.kb.vaults.push({ path: kbVault });
  });

  const r = await obsidian.resolvePaths();
  assert.equal(r.configured, true);
  assert.equal(r.source, 'store', '来源仍是 store——不能悄悄换成 kb 兜底');
  assert.equal(r.vaultExists, false);
  assert.ok(r.hints.some((h) => h.includes('不存在')), '要明确报「目录不存在」');
});

// ---- 规范文档登记与读取 ----

test('规范文档解析：默认三条登记项，存在性如实反映', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.resolvePaths();
  assert.equal(r.docs.length, 3);
  assert.deepEqual(r.docs.map((d) => d.key), ['content', 'questionnaire', 'frontmatter']);
  assert.equal(r.docs[0].rel, 'nx-kn/base-content.md');
  assert.equal(r.docs[0].path, join(vault, 'nx-kn', 'base-content.md'));
  assert.equal(r.docs[0].exists, true);
  assert.equal(r.hints.length, 0, '一切正常时不该有提示');
});

test('规范文档缺失：指名对应的登记项，别让人猜', async () => {
  tmpData();
  const vault = fakeVault(false);
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.resolvePaths();
  assert.equal(r.docs.every((d) => d.exists === false), true);
  assert.ok(r.hints.some((h) => h.includes('docs.content')));
});

test('spec({doc})：直接给出文档全文（skill 靠它拿「内容要求」）', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.spec({ doc: 'content' });
  assert.equal(r.key, 'content');
  assert.equal(r.exists, true);
  assert.match(r.content, /# 内容生成规范/);
  assert.equal(r.path, join(vault, 'nx-kn', 'base-content.md'));
});

test('spec({doc})：未登记的 key 报「未登记」，已登记但文件缺失报「不存在」', async () => {
  tmpData();
  const vault = fakeVault(false);
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  await assert.rejects(
    () => obsidian.spec({ doc: 'style' }),
    (e) => e.code === 'NOT_FOUND' && /未登记/.test(e.message)
  );
  await assert.rejects(
    () => obsidian.spec({ doc: 'content' }),
    (e) => e.code === 'NOT_FOUND' && /不存在/.test(e.message)
  );
});

// ---- set：写入口校验 ----

test('set: 未知键被拒绝（白名单外的键不进 store）', async () => {
  tmpData();
  await assert.rejects(
    () => obsidian.set({ patch: { hacker: 'yes' } }),
    (e) => e.code === 'INVALID_INPUT' && /未知的 obsidian 配置键/.test(e.message)
  );
});

test('set: 登记项路径必须是相对 vault 根的（拒绝绝对路径与 ..）', async () => {
  tmpData();
  await assert.rejects(
    () => obsidian.set({ patch: { 'docs.content': 'C:\\elsewhere\\a.md' } }),
    (e) => e.code === 'INVALID_INPUT' && /必须是相对路径/.test(e.message)
  );
  await assert.rejects(
    () => obsidian.set({ patch: { 'docs.content': 'a/../b.md' } }),
    (e) => e.code === 'INVALID_INPUT' && /\.\./.test(e.message)
  );
});

test('set: vault 目录不存在时报 NOT_FOUND（把路径原样回显，便于找出笔误）', async () => {
  tmpData();
  const missing = join(tmpdir(), 'nx-kn-no-such-vault-' + Date.now());
  await assert.rejects(
    () => obsidian.set({ patch: { vault: missing } }),
    (e) => e.code === 'NOT_FOUND' && /不存在/.test(e.message)
  );
});

test('set: 登记与注销（空值 = 注销这一项）', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault, 'docs.style': 'nx-kn/我的风格.md' } });

  const onDisk = JSON.parse(readFileSync(process.env.NX_KN_STORE, 'utf8'));
  assert.equal(onDisk.obsidian.vault, vault);
  assert.equal(onDisk.obsidian.docs.style, 'nx-kn/我的风格.md');
  assert.equal(onDisk.obsidian.docs.content, 'nx-kn/base-content.md', '默认登记项仍在');

  await obsidian.set({ patch: { 'docs.style': '' } });
  const after = JSON.parse(readFileSync(process.env.NX_KN_STORE, 'utf8'));
  assert.equal('style' in after.obsidian.docs, false, '空值应注销该登记项');
});

test('set: 空值清空 vault → 回到未设置', async () => {
  tmpData();
  const vault = fakeVault();
  await obsidian.set({ patch: { vault } });
  await obsidian.set({ patch: { vault: '' } });
  const after = await obsidian.resolvePaths();
  assert.equal(after.configured, false);
});

// ---- 扫未解析双链 ----

test('scan: 列出未解析双链，附件/代码块/已有笔记都不算', async () => {
  tmpData();
  const vault = fakeVault();
  writeFileSync(
    join(vault, '日常.md'),
    [
      '见 [[红链]]',
      '附件 [[图.png]]',
      '已有 [[base-content]]',
      '```',
      '代码块里的 [[不算]]',
      '```',
    ].join('\n'),
  );
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.scan();
  assert.equal(r.configured, true);
  assert.equal(r.count, 1);
  assert.equal(r.links[0].link, '红链');
  assert.equal(r.links[0].sources[0].file, '日常.md');
  assert.equal(r.links[0].sources[0].line, 1);
});

test('scan: vault 未设置是业务结果（不抛）', async () => {
  tmpData();
  const r = await obsidian.scan();
  assert.equal(r.configured, false);
  assert.equal(r.count, 0);
  assert.ok(r.hints.length);
});

// ---- 生成 frontmatter ----

test('frontmatter: YAML 形状与 bklink 来源（source 优先，其次 locate）', async () => {
  tmpData();
  const vault = fakeVault();
  writeFileSync(join(vault, '引用者.md'), '这里引用了 [[目标]]\n');
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.frontmatter({ link: '目标', source: '日常/foo.md' });
  assert.match(r.yaml, /creatime: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
  assert.match(r.yaml, /tags: \[\]/);
  assert.match(r.yaml, /  - "\[\[foo\]\]"/);
  assert.equal(r.filename, '目标.md');

  const r2 = await obsidian.frontmatter({ link: '目标', locate: true });
  assert.match(r2.yaml, /  - "\[\[引用者\]\]"/);
});

test('frontmatter: --project 把文档和代码库绑在一起（项目解读模式）', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const r = await obsidian.frontmatter({ link: '爬虫模块', source: '日常/foo.md', project: vault });
  assert.equal(r.project, vault);
  // Windows 路径的反斜杠要按 YAML 双引号标量转义，否则 \ 会被当转义序列
  const expected = 'project: "' + vault.replace(/\\/g, '\\\\') + '"';
  assert.ok(r.yaml.includes(expected), 'yaml 里应有 ' + expected + '，实际：\n' + r.yaml);

  await assert.rejects(
    () => obsidian.frontmatter({ link: 'x', project: join(tmpdir(), 'no-such-' + Date.now()) }),
    (e) => e.code === 'NOT_FOUND' && /项目目录不存在/.test(e.message)
  );
});

// ---- 校验：新笔记有没有引入新的未解析双链 ----

test('check: 存快照 → 写入新笔记 → 差分，发现新引入的红链', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  const snap = await obsidian.check({ snapshot: 'snap.json' });
  assert.equal(snap.mode, 'snapshot');
  assert.equal(snap.count, 0);

  // 写一篇带红链的新笔记
  writeFileSync(join(vault, '新笔记.md'), '见 [[新出现的红链]]\n');

  const diff = await obsidian.check({ snapshotBefore: 'snap.json', newFile: '新笔记.md' });
  assert.equal(diff.mode, 'diff');
  assert.equal(diff.passed, false);
  assert.equal(diff.newUnresolved.length, 1);
  assert.equal(diff.newUnresolved[0].link, '新出现的红链');
});

test('check: 没有新红链时 passed=true', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });
  await obsidian.check({ snapshot: 'snap.json' });
  writeFileSync(join(vault, '干净笔记.md'), '没有链接\n');

  const diff = await obsidian.check({ snapshotBefore: 'snap.json', newFile: '干净笔记.md' });
  assert.equal(diff.passed, true);
  assert.equal(diff.newUnresolved.length, 0);
});

test('check: 快照文件不存在 / 格式不对 → 明确报错', async () => {
  tmpData();
  const vault = fakeVault();
  await mutateStore((s) => {
    s.obsidian.vault = vault;
  });

  await assert.rejects(
    () => obsidian.check({ snapshotBefore: 'nope.json', newFile: 'x.md' }),
    (e) => e.code === 'NOT_FOUND' && /不存在/.test(e.message)
  );

  writeFileSync(join(vault, 'bad.json'), '[]', 'utf8');
  await assert.rejects(
    () => obsidian.check({ snapshotBefore: 'bad.json', newFile: 'x.md' }),
    (e) => e.code === 'INVALID_INPUT' && /格式不对/.test(e.message)
  );
});

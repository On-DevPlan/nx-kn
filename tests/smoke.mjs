// smoke 测试：在真实进程里跑通关键路径。
// 这些是「面板能起、命令能跑」的最小证明——比单元测试更接近用户实际体验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin', 'kn.mjs');

function run(cmdline, env = {}) {
  // execFile 不走 shell，必须把命令串拆成 token 数组——
  // 整串塞进去会被当成一个 argv 元素，CLI 侧报「未知命令」。
  return exec(process.execPath, [BIN, ...cmdline.split(' ').filter(Boolean)], {
    cwd: tmpdir(),
    env: { ...process.env, ...env },
  });
}

// 每个测试独立的 store，防写脏真实数据
function isolatedEnv() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-smoke-'));
  return { env: { NX_KN_STORE: join(dir, 'store.json') }, dir };
}

test(`version 输出裸版本号（可被 V=$(nx-kn version) 消费）`, async () => {
  const { stdout } = await run('version');
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('routes: 命令表含各域命令且带 HTTP 对照', async () => {
  const { stdout } = await run('routes --json');
  const r = JSON.parse(stdout);
  assert.ok(r.count >= 8, `至少 8 条命令，实际 ${r.count}`);
  const ids = r.routes.map((x) => x.id);
  for (const id of [
    'home.bootstrap',
    'settings.get',
    'settings.set',
    'obsidian.get',
    'obsidian.set',
    'obsidian.spec',
    'kb.status',
    'kb.query',
  ]) {
    assert.ok(ids.includes(id), `缺命令 ${id}`);
  }
});

test('health：命令表可生成、存储路径可达', async () => {
  const { env } = isolatedEnv();
  const { stdout } = await run('health --json', env);
  const r = JSON.parse(stdout);
  assert.equal(r.status, 'ok');
  assert.ok(r.commands >= 8);
});

test('settings set → get：写读闭环走真实存储', async () => {
  const { env } = isolatedEnv();
  await run('settings set theme=dark lang=zh', env);
  const { stdout } = await run('settings get --json', env);
  const r = JSON.parse(stdout);
  assert.equal(r.settings.theme, 'dark');
  assert.equal(r.settings.lang, 'zh');
});

test('settings set 白名单外的键被拒绝', async () => {
  const { env } = isolatedEnv();
  await assert.rejects(
    () => run('settings set hacker=yes', env),
    (err) => {
      assert.match(err.stderr, /未知的设置键/);
      return true;
    }
  );
});

// ---- kb 域（只读路径 + 库列表的增删；真实建索引不在冒烟里跑：要几十秒且要联网拉模型）----

test('kb status：一个库都没有时给出引导而不是报错', async () => {
  const { env } = isolatedEnv();
  // 清空 NX_KN_VAULT，逼它走「store 里也没有」的分支
  const { stdout } = await run('status --json', { ...env, NX_KN_VAULT: '' });
  const r = JSON.parse(stdout);
  assert.equal(r.status, 'ok');
  assert.equal(r.configured, false);
  assert.deepEqual(r.vaults, []);
  assert.equal(typeof r.zg.installed, 'boolean');
  assert.match(r.hint, /kb add/);
});

test('kb status：vault 存在但未建索引 → 该库 indexed=false 且给出下一步', async () => {
  const { env, dir } = isolatedEnv();
  const { stdout } = await run('status --json', { ...env, NX_KN_VAULT: dir });
  const r = JSON.parse(stdout);
  assert.equal(r.configured, true);
  assert.equal(r.count, 1);
  const v = r.vaults[0];
  assert.equal(v.path, dir);
  assert.equal(v.indexed, false);
  assert.equal(v.obsidian, false);
  assert.equal(v.model, null, '没有索引时模型必须是「未记录」，不能回落 store 里的残留值');
  // hint 指向「下一步该做什么」。没有 zg 的机器上，更紧要的下一步是先装 zg——
  // 那是环境差异不是产品问题，所以两种提示都接受；但必须是**可照做**的提示。
  assert.match(v.hint, /nx-kn index|npm install -g @zvec\/zvec-grep/);
  assert.equal(r.totals.vaults, 1);
  assert.equal(r.totals.indexed, 0);
});

test('kb query：未建索引时返回业务结果 needIndex（不抛错、不阻塞面板）', async () => {
  const { env, dir } = isolatedEnv();
  const { stdout } = await run('query 随便问问 --json', { ...env, NX_KN_VAULT: dir });
  const r = JSON.parse(stdout);
  assert.equal(r.status, 'ok');
  assert.equal(r.needIndex, true);
  assert.match(r.hint, /先跑 nx-kn index/);
});

test('kb query：空问句被拒（用法: 前缀是 agent 的判定契约）', async () => {
  const { env } = isolatedEnv();
  await assert.rejects(
    () => run('kb query', env),
    (err) => {
      assert.match(err.stderr, /用法:/);
      return true;
    }
  );
});

test('kb index：一个库都没有时先拦下来（不白跑一次 zg）', async () => {
  const { env } = isolatedEnv();
  await assert.rejects(
    () => run('index --json', { ...env, NX_KN_VAULT: '' }),
    (err) => {
      assert.match(err.stdout + err.stderr, /知识库目录/);
      return true;
    }
  );
});

// ---- 多库：库列表的增 / 查 / 删（走真实存储，但不触发建索引）----

test('kb add → list → remove：库列表增删闭环，按路径去重', async () => {
  const { env, dir } = isolatedEnv();

  const added = JSON.parse((await run('kb add --json ' + dir, env)).stdout);
  assert.equal(added.status, 'ok');
  assert.equal(added.added, true);
  assert.equal(added.count, 1);

  // 同一个目录再加一次：不重复登记
  const again = JSON.parse((await run('kb add --json ' + dir, env)).stdout);
  assert.equal(again.added, false, '按绝对路径去重');
  assert.equal(again.count, 1);

  const listed = JSON.parse((await run('kb list --json', env)).stdout);
  assert.equal(listed.count, 1);
  assert.equal(listed.vaults[0].path, dir);

  const removed = JSON.parse((await run('kb remove --json ' + dir, env)).stdout);
  assert.equal(removed.count, 0);
  const after = JSON.parse((await run('kb list --json', env)).stdout);
  assert.equal(after.count, 0);
});

test('kb add：目录不存在时直接拒绝（不登记一个假路径）', async () => {
  const { env } = isolatedEnv();
  const ghost = join(tmpdir(), 'nx-kn-does-not-exist-' + Date.now());
  await assert.rejects(
    () => run('kb add --json ' + ghost, env),
    (err) => {
      assert.match(err.stdout + err.stderr, /不存在/);
      return true;
    }
  );
  const listed = JSON.parse((await run('kb list --json', env)).stdout);
  assert.equal(listed.count, 0);
});

// ---- 笔记计数的口径：必须和 zg 实际会索引的东西对得上 ----
//
// 背景：zg 建索引时会**静默跳过**隐藏目录、内置忽略目录名（node_modules 等）、
// 嵌套 git 仓库整棵、以及 0 字节空文件。nx-kn 若照实数所有 md，面板就会报出
// 一个比索引大的数字——本机正式 vault 上正是「报 226 篇、只索引 173 篇」，
// 差额 48（克隆仓库）+ 5（空文件）= 53，用户会以为漏索引了。
// 这里用一个构造出来的 vault 把四类排除一起钉住。

test('笔记计数：与 zg 的口径对齐（隐藏目录 / 内置忽略目录 / 克隆仓库 / 空文件）', async () => {
  const { env, dir } = isolatedEnv();

  writeFileSync(join(dir, 'a.md'), '# a\n正文\n', 'utf8'); // 唯一计入的
  writeFileSync(join(dir, 'b.md'), '# b\n正文\n', 'utf8');

  writeFileSync(join(dir, 'empty.md'), '', 'utf8'); // 空文件 → 不收
  mkdirSync(join(dir, '.hidden'));
  writeFileSync(join(dir, '.hidden', 'x.md'), '# x\n', 'utf8'); // 隐藏目录 → 不扫
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'node_modules', 'n.md'), '# n\n', 'utf8'); // zg 内置忽略名 → 不收
  const repo = join(dir, 'cloned-repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  writeFileSync(join(repo, 'r.md'), '# r\n', 'utf8'); // 嵌套 git 仓库 → 整棵跳过

  const { stdout } = await run('status --json', { ...env, NX_KN_VAULT: dir });
  const v = JSON.parse(stdout).vaults[0];
  assert.equal(v.notes, 2, '只有根层两个有内容的 md 会被索引');
  assert.deepEqual(v.notesSkipped, { empty: 1, nestedRepos: 1 }, '差额要能解释得出来');
});

test('多库：两个目录各自登记，list 全部返回（检索时才逐库合并）', async () => {
  const { env, dir } = isolatedEnv();
  const a = mkdtempSync(join(tmpdir(), 'nx-kn-a-'));
  const b = mkdtempSync(join(tmpdir(), 'nx-kn-b-'));
  await run('kb add --json ' + a, env);
  await run('kb add --json ' + b, env);
  const listed = JSON.parse((await run('kb list --json', env)).stdout);
  assert.equal(listed.count, 2);
  assert.deepEqual(listed.vaults.map((v) => v.path).sort(), [a, b].sort());
  assert.ok(dir); // dir 只用于隔离，这里不参与断言
});

// ---- Windows 引号回归：参数里的空格必须原样抵达 zg ----
//
// 背景：cmd.exe 会把命令行**再解析一遍**。曾用的写法让 Node 套一层引号、并把内层 `"`
// 转义成 `\"`，而 cmd 不认 `\"`——于是 `"D:\My Vault"` 被切回 `"D:\My` 与 `Vault"` 两个
// 参数，zg 报 `accepts at most one root path`。表现为「路径一有空格索引就建不起来」，
// 而且不止路径：`query "多个 词"` 也一样中招——**参数里有空格就坏**。
// 这条用真实 zg 钉住修复，避免哪天「顺手把 spawn 参数改干净」时又把它改回去。

test('runZg：带空格的路径不被 cmd 切分（Windows 引号回归）', async (t) => {
  const { probe, runZg } = await import('../src/core/zg.js');
  const zg = await probe();
  if (!zg.installed) return t.skip('本机未安装 zg，跳过这条回归');

  // 目录名故意带空格——正是会触发 cmd 二次切分的情形
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn space '));
  writeFileSync(join(dir, 'a.md'), '# 标题\n正文\n', 'utf8');

  const r = await runZg(['status', dir, '--mode', 'direct'], { timeoutMs: 60_000 });
  const text = r.stdout + r.stderr;
  assert.doesNotMatch(text, /at most one root path/, '路径被切成了多个 root');
  assert.equal(r.ok, true, `zg status 应成功，实际：${text}`);
  assert.ok(text.includes(basename(dir)), '回显的根路径应与传入的一致');
});

// ---- obsidian 域：vault 定位与内容规范文档解析 ----
//
// 这个域的唯一职责是回答一句话：「内容规范文档在哪」。
// 答错了不会报错，只会**按另一套规范写笔记**——所以每条路径都要在真实进程里钉住。

// 一个「像样的 vault」：有 .obsidian/，有 nx-kn/ 规范目录与两份规范文档。
function fakeVault(withDocs = true) {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-vault-'));
  mkdirSync(join(dir, '.obsidian'));
  mkdirSync(join(dir, 'nx-kn'));
  if (withDocs) {
    writeFileSync(join(dir, 'nx-kn', 'base-content.md'), '# 内容生成规范\n', 'utf8');
    writeFileSync(join(dir, 'nx-kn', 'questionnaire.md'), '# 问卷模式 · 内容规范\n', 'utf8');
  }
  return dir;
}

test('obsidian get：未配置时给出引导而不是报错（业务结果，不是失败）', async () => {
  const { env } = isolatedEnv();
  const { stdout } = await run('obsidian get --json', { ...env, NX_OBSIDIAN_VAULT: '' });
  const r = JSON.parse(stdout);
  assert.equal(r.status, 'ok');
  assert.equal(r.configured, false);
  assert.match(r.hints.join('\n'), /obsidian set/);
});

test('obsidian set → get：vault 与规范目录写读闭环走真实存储', async () => {
  const { env } = isolatedEnv();
  const vault = fakeVault();
  await run('obsidian set vault=' + vault + ' specDir=nx-kn', env);

  const r = JSON.parse((await run('obsidian get --json', env)).stdout);
  assert.equal(r.configured, true);
  assert.equal(r.source, 'store');
  assert.equal(r.vault, vault);
  assert.equal(r.specDir, join(vault, 'nx-kn'));
  assert.equal(r.hasObsidianMarker, true);
  assert.ok(r.docs.every((d) => d.exists === true), '两份规范文档都应存在');
});

test('obsidian spec：给出 skill 要读的两份文档的绝对路径', async () => {
  const { env } = isolatedEnv();
  const vault = fakeVault();
  await run('obsidian set vault=' + vault, env);

  const r = JSON.parse((await run('obsidian spec --json', env)).stdout);
  assert.equal(r.configured, true);
  assert.deepEqual(r.docs.map((d) => d.key), ['content', 'questionnaire']);
  assert.equal(r.docs[0].path, join(vault, 'nx-kn', 'base-content.md'));
  assert.equal(r.docs[1].path, join(vault, 'nx-kn', 'questionnaire.md'));
  assert.ok(r.docs.every((d) => d.exists === true));
});

test('obsidian spec：环境变量兜底（skill 的 python 脚本认同一个变量）', async () => {
  const { env } = isolatedEnv();
  const vault = fakeVault();
  const r = JSON.parse((await run('obsidian spec --json', { ...env, NX_OBSIDIAN_VAULT: vault })).stdout);
  assert.equal(r.configured, true);
  assert.equal(r.source, 'env');
  assert.equal(r.docs[0].exists, true);
});

test('obsidian spec：kb 登记库兜底（第一个含 .obsidian 的登记库）', async () => {
  const { env } = isolatedEnv();
  const vault = fakeVault();
  await run('kb add --json ' + vault, env);
  const r = JSON.parse((await run('obsidian spec --json', { ...env, NX_OBSIDIAN_VAULT: '' })).stdout);
  assert.equal(r.source, 'kb');
  assert.equal(r.docs[0].exists, true);
});

test('obsidian spec：规范文档缺失时如实报缺失并指名配置键', async () => {
  const { env } = isolatedEnv();
  const vault = fakeVault(false);
  await run('obsidian set vault=' + vault, env);

  const r = JSON.parse((await run('obsidian spec --json', env)).stdout);
  assert.equal(r.configured, true);
  assert.ok(r.docs.every((d) => d.exists === false));
  assert.match(r.hints.join('\n'), /contentDoc/);
});

test('obsidian set：白名单外的键被拒绝；specDir 必须是 vault 内相对路径', async () => {
  const { env } = isolatedEnv();
  await assert.rejects(
    () => run('obsidian set hacker=yes', env),
    (err) => {
      assert.match(err.stderr, /未知的 obsidian 配置键/);
      return true;
    }
  );
  await assert.rejects(
    () => run('obsidian set specDir=C:\\elsewhere', env),
    (err) => {
      assert.match(err.stderr, /必须是相对路径/);
      return true;
    }
  );
});

test('obsidian get：人类可读输出（skill 与人都在用这条命令）', async () => {
  const { env } = isolatedEnv();
  const vault = fakeVault();
  await run('obsidian set vault=' + vault, env);
  const { stdout } = await run('obsidian get', env);
  assert.match(stdout, /【存在】/);
  assert.match(stdout, /base-content\.md/);
});


// smoke 测试：在真实进程里跑通关键路径。
// 这些是「面板能起、命令能跑」的最小证明——比单元测试更接近用户实际体验。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
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
  for (const id of ['home.bootstrap', 'settings.get', 'settings.set', 'kb.status', 'kb.query']) {
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

// ---- kb 域（只读路径；真实建索引不在冒烟里跑：要几十秒且要联网拉模型）----

test('kb status：未设定 vault 时给出引导而不是报错', async () => {
  const { env } = isolatedEnv();
  // 清空 NX_KN_VAULT，逼它走「store 里也没有」的分支
  const { stdout } = await run('status --json', { ...env, NX_KN_VAULT: '' });
  const r = JSON.parse(stdout);
  assert.equal(r.status, 'ok');
  assert.equal(r.configured, false);
  assert.equal(typeof r.zg.installed, 'boolean');
  assert.match(r.hint, /kb use/);
});

test('kb status：vault 存在但未建索引 → indexed=false 且给出下一步', async () => {
  const { env, dir } = isolatedEnv();
  const { stdout } = await run('status --json', { ...env, NX_KN_VAULT: dir });
  const r = JSON.parse(stdout);
  assert.equal(r.configured, true);
  assert.equal(r.vault, dir);
  assert.equal(r.indexed, false);
  assert.equal(r.obsidian, false);
  assert.match(r.hint, /nx-kn index/);
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

test('kb index：未设定 vault 时先拦下来（不白跑一次 zg）', async () => {
  const { env } = isolatedEnv();
  await assert.rejects(
    () => run('index --json', { ...env, NX_KN_VAULT: '' }),
    (err) => {
      assert.match(err.stdout, /设定知识库目录/);
      return true;
    }
  );
});

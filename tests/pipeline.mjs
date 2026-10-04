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
//
// 隔离：临时 store + 临时 skills 目录 + 临时 vault，绝不碰用户的真实数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
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
  const env = {
    NX_KN_STORE: join(base, 'store.json'),
    NX_KN_VAULT: '',
    NX_KN_EMBEDDING: PIPELINE_MODEL,
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
});

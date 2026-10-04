// core/skill-seekers.js 的单测：候选命令解析 + 子进程驱动 + markdown 枚举。
//
// 这些都是纯逻辑或**本地**进程行为——不联网、不依赖 Python，所以属于单测层。
// 「外部引擎整条链路能不能跑通」交给流水线（用 tests/fixtures/fake-skill-seekers.mjs 假引擎）。
//
// 有一条**刻意不测**：没给 NX_KN_SKILL_SEEKERS_CMD 时的 PATH → uvx 回退。因为那条路
// 一旦真的走到 uvx，就会联网拉约 50 MB 依赖——单测不该有网络副作用。它由「env 是排他的」
// 那条测试从反面覆盖：只要 env 在场，失败也不去碰 uvx。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
  SKILL_SEEKERS_ENV,
  candidateCommands,
  describeCandidate,
  listMarkdownFiles,
  runSkillSeekers,
} from '../../src/core/skill-seekers.js';

const envWith = (v) => ({ [SKILL_SEEKERS_ENV]: v });
const toPosix = (p) => p.split(sep).join('/');

// ---- 候选命令解析 ----

test('候选命令：未指定 env 时按「PATH 上的 skill-seekers → uvx 免安装」顺序', () => {
  const c = candidateCommands({});
  assert.equal(c.length, 2);
  assert.deepEqual(
    c.map((x) => x.source),
    ['path', 'uvx']
  );
  assert.equal(c[0].bin, 'skill-seekers');
  assert.deepEqual(c[0].args, []);
  assert.equal(c[1].bin, 'uvx');
  assert.deepEqual(c[1].args, ['--from', 'skill-seekers', 'skill-seekers'], 'uvx 要显式指定包与命令');
});

test('候选命令：env 是单个路径时**唯一**候选（用户说了算，不再回退）', () => {
  const c = candidateCommands(envWith('/opt/ss/bin/skill-seekers'));
  assert.equal(c.length, 1);
  assert.equal(c[0].bin, '/opt/ss/bin/skill-seekers');
  assert.deepEqual(c[0].args, []);
  assert.equal(c[0].source, 'env');
});

test('候选命令：env 是 JSON 数组时按「程序 + 参数前缀」解析', () => {
  const c = candidateCommands(envWith(JSON.stringify(['uvx', '--from', 'skill-seekers', 'skill-seekers'])));
  assert.equal(c.length, 1);
  assert.equal(c[0].bin, 'uvx');
  assert.deepEqual(c[0].args, ['--from', 'skill-seekers', 'skill-seekers']);
});

test('候选命令：env 以 [ 开头但不是合法 JSON 数组时不抛，按单路径处理', () => {
  // 兜底正确性：用户随手写坏一个环境变量，不该让整个命令崩在解析上。
  for (const bad of ['[not json', JSON.stringify([1, 2]), JSON.stringify([])]) {
    const c = candidateCommands(envWith(bad));
    assert.equal(c.length, 1, `应该按单路径处理: ${bad}`);
    assert.equal(c[0].bin, bad);
  }
});

test('候选命令：空白 env 视同未设置', () => {
  const c = candidateCommands(envWith('   '));
  assert.equal(c.length, 2, '空白不该被当成一个叫「   」的命令');
});

test('describeCandidate：有参数前缀时把前缀一起带出来（错误信息里要说清怎么调的）', () => {
  assert.equal(describeCandidate({ bin: 'skill-seekers', args: [] }), 'skill-seekers');
  assert.equal(
    describeCandidate({ bin: 'uvx', args: ['--from', 'skill-seekers', 'skill-seekers'] }),
    'uvx --from skill-seekers skill-seekers'
  );
});

// ---- markdown 枚举 ----

test('listMarkdownFiles：递归、只收 .md（大小写都认）、按路径稳定排序', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nx-kn-ss-scan-'));
  mkdirSync(join(root, 'sub'), { recursive: true });
  mkdirSync(join(root, 'dir'), { recursive: true });
  writeFileSync(join(root, 'a.md'), '# a\n', 'utf8');
  writeFileSync(join(root, 'sub', 'b.md'), '# b\n', 'utf8');
  writeFileSync(join(root, 'sub', 'c.txt'), 'not md\n', 'utf8');
  writeFileSync(join(root, 'dir', 'd.MD'), '# d\n', 'utf8');
  writeFileSync(join(root, 'scripts-search.py'), 'not md\n', 'utf8');

  const got = (await listMarkdownFiles(root)).map((p) => toPosix(relative(root, p)));
  // 排序是「先按目录名、进入后再排」的深度优先结果，两次运行必须一致。
  assert.deepEqual(got, ['a.md', 'dir/d.MD', 'sub/b.md']);
});

test('listMarkdownFiles：目录不存在时回空数组而不是抛', async () => {
  assert.deepEqual(await listMarkdownFiles(join(tmpdir(), 'nx-kn-ss-does-not-exist-xyz')), []);
});

// ---- 子进程驱动 ----

function makeFakeBin() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-ss-bin-'));
  // echo：把收到的参数原样打出来——用来证明「参数没被任何 shell 二次解释」。
  writeFileSync(join(dir, 'echo.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));\n', 'utf8');
  // fail：写 stderr 并以 3 退出——模拟 skill-seekers 的业务失败。
  writeFileSync(join(dir, 'fail.mjs'), 'console.error("boom-detail");\nprocess.exit(3);\n', 'utf8');
  return dir;
}

test('runSkillSeekers：参数原样到达子进程（URL 里的 % 与空格都不经过 shell）', async () => {
  const dir = makeFakeBin();
  const env = envWith(JSON.stringify([process.execPath, join(dir, 'echo.mjs')]));

  const args = ['create', 'https://e.invalid/a%20b%2Fc', '--name', 'my docs'];
  const r = await runSkillSeekers(args, { env });

  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.via, 'env');
  // 这正是「不用 cmd.exe 垫片」的理由：一旦经过 cmd，%20 会被当变量展开、空格会被切参数。
  assert.deepEqual(JSON.parse(r.stdout.trim()), args, '参数必须逐字节原样送达');
});

test('runSkillSeekers：非 0 退出时回 ok:false 且带 stderr，不换候选', async () => {
  const dir = makeFakeBin();
  const env = envWith(JSON.stringify([process.execPath, join(dir, 'fail.mjs')]));

  const r = await runSkillSeekers(['create', 'https://e.invalid/'], { env });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.match(r.stderr, /boom-detail/);
  assert.equal(r.tried.length, 1, '进程真的跑起来了就是终局，重试另一个候选毫无意义');
});

test('runSkillSeekers：命令不存在时回 code 127，并把两条出路写进错误里', async () => {
  const dir = makeFakeBin();
  const env = envWith(join(dir, 'definitely-not-here'));

  const r = await runSkillSeekers(['--help'], { env });
  assert.equal(r.ok, false);
  assert.equal(r.code, 127);
  assert.match(r.error, /找不到 skill-seekers/);
  assert.match(r.error, /--engine node/, '必须告诉用户「可以换内置引擎」');
  assert.match(r.error, new RegExp(SKILL_SEEKERS_ENV), '必须告诉用户「可以用环境变量指定命令」');
  assert.equal(r.tried.length, 1, 'env 是排他的：它坏了也不该偷偷去试 uvx');
});

test('runSkillSeekers：卡死的子进程按 timeoutMs 击杀（code 124）——超时必须自己管', async () => {
  // 回归背景：曾用 spawn 的 timeout 选项，它在 Windows ENOENT 路径上会把事件循环
  // 钉住到超时才放（error 已触发、结果已返回，进程却多活 timeoutMs），让整个
  // node --test 子进程白挂 30 分钟。现在超时由我们自己的 unref 定时器管：
  // 这条测试钉住「击杀照常生效」，上面的 127 测试钉住「起不来时快速返回」。
  const env = envWith(JSON.stringify([process.execPath]));

  const t0 = Date.now();
  const r = await runSkillSeekers(['-e', 'setTimeout(()=>{}, 60000)'], { env, timeoutMs: 1500 });
  const elapsed = Date.now() - t0;

  assert.equal(r.ok, false);
  assert.equal(r.code, 124, '超时击杀后的 close code 是 null → 映射为 124');
  assert.ok(elapsed < 20_000, `超时要真的击杀，而不是等子进程自然退出（elapsed=${elapsed}ms）`);
});

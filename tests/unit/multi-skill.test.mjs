// 多 skill 扩展测试（per server-cli-web-scaffold B04）
//
// 覆盖：
//   - 三种 install 形式（默认 / 显式 [name] / --group=）
//   - list / groups 的默认 install 标记
//   - 降级路径（删 groups.json 仍能用）
//   - schema 错误显式报错（不静默）
//   - 错误参数：--group 空 / '-' 开头 / 互斥 / 未知 group
//   - 幂等（二次安装 skipped）
//
// 隔离要点：
//   - 真实 KN-KN 资产在仓库里（asset 路径是 __dirname 解析，模块加载期固定）
//   - 测试只**覆盖** install 路径（用 --to /tmp/...），不**碰**真实 ~/.claude/skills/
//   - 测试 **不**用 chdir / env var 覆盖 ASSETS_DIR（避免模块加载顺序竞争）；改用 mtime / content 隔离
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..');
const ASSETS_DIR = join(ROOT, 'assets');
const GROUPS_FILE = join(ASSETS_DIR, 'groups.json');

// ---- 1. assets/groups.json 的形状断言（schema 严格）----
test('groups.json: 默认 group key 与 package.json.name 同名（nx-kn）', () => {
  const groups = JSON.parse(readFileSync(GROUPS_FILE, 'utf8'));
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.ok(groups.groups[pkg.name], `默认 group "${pkg.name}" 必须在 groups.json 里`);
  assert.ok(Array.isArray(groups.groups[pkg.name].skills));
  assert.ok(groups.groups[pkg.name].skills.includes(pkg.name));
});

test('groups.json: 每个 group 都有 SKILL.md 实际资产对应', () => {
  const groups = JSON.parse(readFileSync(GROUPS_FILE, 'utf8'));
  for (const [gname, g] of Object.entries(groups.groups)) {
    for (const skill of g.skills) {
      const skillMd = join(ASSETS_DIR, skill, 'SKILL.md');
      assert.ok(existsSync(skillMd), `group ${gname} 声明的 skill "${skill}" 缺资产: ${skillMd}`);
    }
  }
});

// ---- 2. loadGroups / runList / runGroups 的纯逻辑 ----
test('loadGroups: manifest 模式下 defaultGroup = package.name', async () => {
  const { loadGroups } = await import('../../src/runtime/skill.js');
  const r = await loadGroups();
  assert.equal(r.source, 'manifest');
  assert.equal(r.defaultGroup, 'nx-kn');
  assert.equal(r.pkgName, 'nx-kn');
  assert.ok(r.groups['nx-kn']);
  assert.ok(r.groups['kn-obsidian-repair-unresolved-links']);
});

test('runList: --json 输出包含 skills + groups + defaultGroup + source', async () => {
  const { runList } = await import('../../src/runtime/skill.js');
  const r = await runList();
  assert.ok(Array.isArray(r.skills));
  assert.ok(r.skills.includes('nx-kn'));
  assert.ok(r.skills.includes('kn-obsidian-repair-unresolved-links'));
  assert.ok(Array.isArray(r.groups));
  const nxkn = r.groups.find((g) => g.name === 'nx-kn');
  assert.ok(nxkn, 'nx-kn group 必须存在');
  assert.equal(nxkn.isDefault, true);
  assert.equal(r.defaultGroup, 'nx-kn');
  assert.equal(r.source, 'manifest');
});

test('runList: 默认 install 只标一次（package.name 同名的那项）', async () => {
  const { runList } = await import('../../src/runtime/skill.js');
  const r = await runList();
  const defaults = r.groups.filter((g) => g.isDefault);
  assert.equal(defaults.length, 1, 'isDefault 应当只有一个');
  assert.equal(defaults[0].name, 'nx-kn');
});

// ---- 3. install 子命令 dispatcher 的单元行为 ----
//    用 --to /tmp/... 隔离，绝不碰真实 ~/.claude/skills
function makeTmpDir(label) {
  return mkdtempSync(join(tmpdir(), `nx-kn-skill-${label}-`));
}

test('runInstall: 无参（默认）= package.name', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  const to = makeTmpDir('default');
  try {
    const r = await runInstall({ to });
    assert.equal(r.group, null, '默认 install 返回 shape: r.group === null');
    assert.equal(r.skill, 'nx-kn');
    assert.ok(r.installed || r.skipped || r.status === 'conflict');
    assert.ok(r.path.includes('nx-kn'), `默认 install 应装到 nx-kn 子目录，实际: ${r.path}`);
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

test('runInstall: 显式 [name] 装指定 skill', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  const to = makeTmpDir('explicit');
  try {
    const r = await runInstall({ name: 'kn-obsidian-repair-unresolved-links', to });
    assert.equal(r.group, null);
    assert.equal(r.skill, 'kn-obsidian-repair-unresolved-links');
    assert.equal(r.status, 'ok');
    assert.ok(r.installed);
    assert.ok(r.path.includes('kn-obsidian-repair-unresolved-links'));
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

test('runInstall: --group= 一键装一组', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  const to = makeTmpDir('group');
  try {
    const r = await runInstall({ group: 'kn-obsidian-repair-unresolved-links', to });
    assert.equal(r.group, 'kn-obsidian-repair-unresolved-links');
    assert.ok(Array.isArray(r.skills));
    assert.equal(r.skills.length, 1);
    assert.equal(r.skills[0].skill, 'kn-obsidian-repair-unresolved-links');
    assert.equal(r.skills[0].installed || r.skills[0].replaced || r.skills[0].skipped, true);
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

test('runInstall: 互斥——[name] 与 --group 同时给报 INVALID_INPUT', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => runInstall({ name: 'foo', group: 'nx-kn' }),
    (err) => {
      assert.match(err.message, /互斥/);
      assert.equal(err.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('runInstall: --group 空值报错', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => runInstall({ group: '' }),
    (err) => {
      assert.match(err.message, /不能为空/);
      assert.equal(err.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('runInstall: --group 以 "-" 开头报错（防误读 flag）', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => runInstall({ group: '-flag' }),
    (err) => {
      assert.match(err.message, /'-'/);
      assert.equal(err.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('runInstall: 未知 group 报错并给出可用列表', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => runInstall({ group: 'bogus' }),
    (err) => {
      assert.match(err.message, /未知 group/);
      assert.match(err.message, /nx-kn/);
      assert.match(err.message, /kn-obsidian-repair-unresolved-links/);
      assert.equal(err.code, 'INVALID_INPUT');
      return true;
    },
  );
});

test('runInstall: 同一目录二次安装 skipped（幂等）', async () => {
  const { runInstall } = await import('../../src/runtime/skill.js');
  const to = makeTmpDir('idempotent');
  try {
    const first = await runInstall({ name: 'kn-obsidian-repair-unresolved-links', to });
    assert.ok(first.installed);
    const second = await runInstall({ name: 'kn-obsidian-repair-unresolved-links', to });
    assert.ok(second.skipped, '第二次应当 skipped（内容一致）');
    assert.equal(second.files, 0);
  } finally {
    rmSync(to, { recursive: true, force: true });
  }
});

// ---- 4. 降级路径 ----
test('降级：临时把 assets/groups.json 改名，runList source 回到 assets-dirs', async (t) => {
  const { loadGroups } = await import('../../src/runtime/skill.js');
  const backup = `${GROUPS_FILE}.bak-test`;
  const fs = await import('node:fs');
  fs.renameSync(GROUPS_FILE, backup);
  t.after(() => {
    // 即使测试抛错也要恢复
    if (fs.existsSync(`${GROUPS_FILE}.bak-test`)) {
      fs.renameSync(backup, GROUPS_FILE);
    }
  });
  const r = await loadGroups();
  assert.equal(r.source, 'assets-dirs', 'manifest 不可用时必须降级到目录扫描');
  assert.ok(r.groups['nx-kn']);
  assert.ok(r.groups['kn-obsidian-repair-unresolved-links']);
  assert.equal(r.defaultGroup, 'nx-kn');
});

// ---- 5. schema 严格性 ----
test('schema 校验：缺 version 报错', async (t) => {
  const fs = await import('node:fs');
  const backup = `${GROUPS_FILE}.bak-schema`;
  fs.renameSync(GROUPS_FILE, backup);
  writeFileSync(GROUPS_FILE, JSON.stringify({ groups: { nx: { skills: ['nx-kn'] } } }));
  t.after(() => {
    fs.renameSync(backup, GROUPS_FILE);
  });
  const { loadGroups } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => loadGroups(),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /version/);
      return true;
    },
    '缺 version 字段必须响亮失败，不降级',
  );
});

test('schema 校验：group 缺 skills 数组报错', async (t) => {
  const fs = await import('node:fs');
  const backup = `${GROUPS_FILE}.bak-schema2`;
  fs.renameSync(GROUPS_FILE, backup);
  writeFileSync(GROUPS_FILE, JSON.stringify({ version: 1, groups: { nx: { summary: 'no skills' } } }));
  t.after(() => {
    fs.renameSync(backup, GROUPS_FILE);
  });
  const { loadGroups } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => loadGroups(),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      assert.match(err.message, /skills/);
      return true;
    },
  );
});

test('schema 校验：group 含非法 skill 名（路径穿越）报错', async (t) => {
  const fs = await import('node:fs');
  const backup = `${GROUPS_FILE}.bak-schema3`;
  fs.renameSync(GROUPS_FILE, backup);
  writeFileSync(
    GROUPS_FILE,
    JSON.stringify({ version: 1, groups: { nx: { skills: ['nx-kn', '../bad'] } } }),
  );
  t.after(() => {
    fs.renameSync(backup, GROUPS_FILE);
  });
  const { loadGroups } = await import('../../src/runtime/skill.js');
  await assert.rejects(
    () => loadGroups(),
    (err) => {
      assert.equal(err.code, 'INVALID_INPUT');
      return true;
    },
  );
});

// 一致性断言：枚举清单、文档与代码必须共进退。
//
// 这些测试守的都是「新增东西时容易漏的一步」：模块加进 eslint 枚举、
// skill 文档提到的命令真实存在。某一条红了，说明步骤少做了，
// 代价只是补一行登记——但漏了它会在很久之后以难查的方式坑人。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---- 1. eslint 分层枚举 ----
// 背景：分层禁列用不了否定式 glob（eslint 9 的负模式对 `../` 相对路径
// 全部失效，实测记录在 eslint.config.js 注释里），退回枚举式。枚举的
// 经典问题是「新增模块忘补清单 → 静默失效」，本文件把它变成响亮失效。

test('lint 清单覆盖全部业务模块（新增模块必须登记 eslint.config.js）', () => {
  const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');

  const dirs = readdirSync(join(ROOT, 'src', 'modules'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const missing = dirs.filter((m) => !config.includes(`src/modules/${m}/**`));

  assert.deepEqual(
    missing,
    [],
    `以下业务模块没有登记进 eslint.config.js 通用块的 files，` +
      `它们将不受「模块互依禁令」保护：${missing.join(', ')}\n` +
      `修复：在通用块 files 里加 'src/modules/<名>/**/*.{js,jsx}'，` +
      `并在 group 里补 '../<名>/*' 与 '../<名>/**'（供其他模块的禁列引用）。`
  );
});

test('lint 通用块的 group 覆盖全部业务模块（互为禁列）', () => {
  const config = readFileSync(join(ROOT, 'eslint.config.js'), 'utf8');
  const dirs = readdirSync(join(ROOT, 'src', 'modules'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  const notListed = dirs.filter((m) => !config.includes(`'../${m}/*'`));
  assert.deepEqual(
    notListed,
    [],
    `以下模块没有被任何禁列 group 提及（别人 import 它不会被拦）：${notListed.join(', ')}`
  );
});

// ---- 2. view.jsx 只 import 前端壳与 react ----
// 与 eslint 的前端规则互为备份：这条能在不跑 eslint 的环境下（node --test）兜底。

test('view.jsx 只 import 前端壳与 react（不拖 node 侧代码进浏览器包）', () => {
  const walk = (dir, acc = []) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (e.name === 'view.jsx') acc.push(p);
    }
    return acc;
  };
  for (const file of walk(join(ROOT, 'src', 'modules'))) {
    const src = readFileSync(file, 'utf8');
    const bad = src.match(/from\s+'[^']*(core|runtime)\/[^']*';/g);
    assert.equal(bad, null, `${file} 引用了 Node 侧代码: ${bad}`);
  }
});

// ---- 3. skill 文档提到的命令必须真实存在 ----
// 文档是骨架的一部分：agent 只读 skill 文档，不会去猜命令名。文档里写了一条
// 跑不了的命令，等价于「skill 装完之后这件事做不成」——而这正是流水线要保证的。
// 这里用**真正的命令匹配器**（cli.js 的 resolveCommand）逐条解析，而不是做字符串
// 包含判断：包含判断会漏掉「写了 nx-kn index、但命令其实叫 indexing」这类漂移，
// 而那恰恰是最容易发生的一种。

// 只认「nx-kn + 1~2 个小写词」的形态：命令行永远是小写字母开头，
// 而正文里的 `[nx-kn 知识库召回]` 这类中文短语不该被当成命令。
// 空白必须限定为空格/制表符（不能用 \s）——frontmatter 是 `name: nx-kn` 换行接
// `description: ...`，用 \s 会把下一行的键名当成命令。
const CMD_RE = /nx-kn[ \t]+([a-z][a-z0-9-]*(?:[ \t]+[a-z][a-z0-9-]*)?)/g;

function docFiles() {
  const files = [join(ROOT, 'assets', 'nx-kn', 'SKILL.md')];
  const refDir = join(ROOT, 'assets', 'nx-kn', 'references');
  if (existsSync(refDir)) {
    for (const f of readdirSync(refDir)) {
      if (f.endsWith('.md')) files.push(join(refDir, f));
    }
  }
  return files;
}

test('SKILL.md 存在且速查表覆盖核心命令', () => {
  const skillPath = join(ROOT, 'assets', 'nx-kn', 'SKILL.md');
  assert.ok(existsSync(skillPath), `缺随包 skill：assets/nx-kn/SKILL.md（skill install 会 NOT_FOUND）`);
  const doc = readFileSync(skillPath, 'utf8');
  for (const cmd of ['routes', 'help', 'health', 'settings']) {
    assert.ok(
      doc.includes(cmd),
      `SKILL.md 速查表缺核心命令 ${cmd}（文档与实现漂移）`
    );
  }
});

test('skill 文档里出现的每条 nx-kn 命令都能解析到真实命令', async () => {
  const { resolveCommand } = await import('../../src/runtime/cli.js');

  const bad = [];
  let total = 0;
  for (const file of docFiles()) {
    const doc = readFileSync(file, 'utf8');
    const rel = file.slice(ROOT.length + 1).replace(/\\/g, '/');
    for (const m of doc.matchAll(CMD_RE)) {
      total++;
      const tokens = m[1].trim().split(/\s+/);
      if (!resolveCommand(tokens)) bad.push(`${rel}: nx-kn ${m[1].trim()}`);
    }
  }

  assert.ok(total >= 10, `文档里应至少提到 10 条命令（实际 ${total}）——正则或文档被改坏了`);
  assert.deepEqual(
    bad,
    [],
    `以下出现在 skill 文档里的命令在 CLI 里不存在（agent 照着敲会「未知命令」）：\n  ` +
      bad.join('\n  ')
  );
});

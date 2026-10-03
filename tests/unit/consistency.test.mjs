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
// assets/<app>/SKILL.md 的命令速查表如果与实际 CLI 帮助脱节，agent 会
// 照着文档敲出「未知命令」。文档是骨架的一部分，最基本的核心命令必须在场；
// 与模板 id 同名的 SKILL.md 目录若被改名，这里会先红。

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

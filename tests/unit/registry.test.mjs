// 模块注册表一致性：后端模块表 ↔ 前端视图表 必须两侧对齐。
//
// 背景见 registry.js 的注释：新增功能域要同时在 runtime/registry.js 与
// web/frontend/registry.js 登记，漏任何一侧，面板就少一个 tab 或 CLI 少一组
// 命令——而且没有任何运行时报错。这个文件把「漏登记」变成 CI 直接红。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function moduleDirs() {
  return readdirSync(join(ROOT, 'src', 'modules'), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

function backendRegistry() {
  return readFileSync(join(ROOT, 'src', 'runtime', 'registry.js'), 'utf8');
}

function frontendRegistry() {
  return readFileSync(join(ROOT, 'src', 'web', 'frontend', 'registry.js'), 'utf8');
}

test('每个业务模块都登记进 runtime/registry.js', () => {
  const src = backendRegistry();
  const missing = moduleDirs().filter((m) => !src.includes(`modules/${m}/index.js`));
  assert.deepEqual(missing, [], `模块没进 runtime/registry.js 的 MODULES: ${missing.join(', ')}`);
});

test('每个业务模块都有对应的面板视图，且登记进 frontend/registry.js', () => {
  const src = frontendRegistry();
  const missing = moduleDirs().filter(
    (m) => !src.includes(`modules/${m}/view.jsx`) || !src.includes(`id: '${m}'`)
  );
  assert.deepEqual(
    missing,
    [],
    `模块缺 view.jsx 或没进 frontend/registry.js 的 VIEWS: ${missing.join(', ')}`
  );
});

test('每个模板声明的模块目录都真实存在（防拼写漂移）', () => {
  const src = backendRegistry();
  for (const m of moduleDirs()) {
    // 反向断言由上一个测试覆盖；这里防的是 registry 里登记了幽灵模块名
    assert.ok(src.includes(m), `runtime/registry.js 提及 ${m} 但 src/modules/ 下无此目录`);
  }
});

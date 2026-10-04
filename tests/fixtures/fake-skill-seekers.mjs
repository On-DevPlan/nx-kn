#!/usr/bin/env node
// 假 skill-seekers：**只为流水线测试存在**。
//
// 为什么需要它：外部引擎这条链路（spawn → 产出目录 → 摘 md → 增量 → 登记知识库）
// 是真实代码路径，必须被验证；但真跑 skill-seekers 要联网拉约 50 MB 依赖 + Python 3.10+，
// 那会把「CI 不联网可复现」的底线捅破。
//
// 于是这里只模拟真实引擎**唯一被我们依赖的可观察行为**：
//   1. 把产物落在 `<cwd>/output/<name>/` 下，含 SKILL.md 与 references/*.md
//   2. 认得 `--name`（决定那个目录名）
// 其余（分类、增强、SQLite 索引）我们一概不看，所以一概不模拟。
//
// 用 NX_KN_SKILL_SEEKERS_CMD 指向它即可：值形如 ["<node>","<此文件绝对路径>"]。
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);

// 可用性探测会先问 --help / --version，得像真程序一样答一声就退。
if (argv.includes('--help') || argv.includes('--version')) {
  console.log('fake skill-seekers 0.0.0');
  process.exit(0);
}

function flagValue(name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}

// 我们的调用形态固定是 `create <url> --name <n> [--enhance-level <n>] [--agent <a>]`，
// 所以第一个非 flag 的位置参数就是 url。
const url = argv.slice(1).find((a) => !a.startsWith('--')) || '';
const name = flagValue('--name') || 'site';

const out = join(process.cwd(), 'output', name);
mkdirSync(join(out, 'references'), { recursive: true });

writeFileSync(
  join(out, 'SKILL.md'),
  `# ${name}\n\n由假 skill-seekers 生成，用于流水线测试。来源：${url}\n\n独有关键词：skseeker-root-word\n`,
  'utf8'
);

writeFileSync(
  join(out, 'references', 'guide.md'),
  '# Guide\n\n外部引擎产出的参考文档。独有关键词：skseeker-ref-word\n',
  'utf8'
);

// 顺便落一个非 md 文件：它**不该**被摘进知识库（我们只收 .md）。
writeFileSync(join(out, 'scripts-search.py'), '# 不该被摘走\n', 'utf8');

console.log(`fake skill-seekers: wrote ${out}`);

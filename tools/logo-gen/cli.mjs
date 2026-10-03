// 手动重出 logo：覆盖面板静态目录下的全套（svg + png + ico）。
// 生成器在 create 时已自动产出一套；这条命令用于改字母/撞色后手动刷新。
//
// 用法:
//   node tools/logo-gen/cli.mjs                    # 用 package.json 的项目名（nx-<letters>）
//   node tools/logo-gen/cli.mjs --scheme klein     # 指定撞色（可选值见 SCHEMES）
//   node tools/logo-gen/cli.mjs --letters ab --out <dir>   # 指定字母与输出目录（测试用）
import { generateAll, SCHEMES, DEFAULT_SCHEME } from './index.mjs';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';

function arg(name) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// 字母缺省取 package.json 的项目名前缀之后（nx-xx → xx）。模板契约里
// namePrefix 是唯一的派生规则来源，tools 不自己约定第二次。
const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
const fallbackLetters = String(pkg.name || '').replace(/^[^-]+-/, '');

const out = arg('out') || join(process.cwd(), 'src', 'web', 'frontend', 'public');
const letters = arg('letters') || fallbackLetters;
const scheme = arg('scheme') || DEFAULT_SCHEME;

if (!/^[a-z]{1,5}$/.test(letters)) {
  console.error(`字母非法: ${letters}（1~5 位小写字母；可用 --letters 显式指定）`);
  process.exit(1);
}
if (!SCHEMES[scheme]) {
  console.error(`未知撞色方案: ${scheme}（可选: ${Object.keys(SCHEMES).join(' / ')}）`);
  process.exit(1);
}

const r = generateAll(out, letters, scheme);
console.log(r.note);
for (const f of r.files) console.log('  ' + f);
console.log('输出目录: ' + out);

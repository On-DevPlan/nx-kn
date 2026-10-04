// 路径与安全校验：项目里所有「东西放哪」都从这里取，不在别处拼字符串。
//
// ⚠️ 本文件是生成器的**参数化中心**——新项目由模板生成时，只有这里的
// nx-kn / nx-kn / Obsidian 知识库检索（zg 引擎） / 7881 被替换，其余文件一律引用这些常量。
// 要加新常量请加在这里，不要在别处写字符串字面量。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { badInput } from './errors/index.js';

// ---- 项目标识 ----
export const APP_NAME = 'nx-kn';
export const APP_TITLE = 'nx-kn';
export const APP_DESC = 'Obsidian 知识库检索（zg 引擎）';

// ---- 数据目录（用户主目录下，可用环境变量覆盖）----
export const APP_DIR = join(homedir(), '.nx-kn');
export const STORE_PATH = join(APP_DIR, 'store.json');

// ---- 端口 ----
// serve 的 HTTP 端口。vite dev server 的端口在 vite.config.js 里单独配。
export const DEFAULT_PORT = 7881;

// ---- 知识库（Obsidian vault）----
//
// vault 路径的优先级：action 的 --root 参数 > 环境变量 > store.json 的 kb.vault。
// 环境变量这一层是为了「同一台机器上临时指向另一个 vault」而留的，不需要落盘。
export const VAULT_ENV = 'NX_KN_VAULT';

// Obsidian 的纯噪声目录：必须排除，否则索引里全是配置与已删笔记。
//
// 实测（zg 0.2.2）：这两个目录以 `.` 开头，zg 默认本就不扫隐藏路径，
// 所以「默认就对」；仍显式写成排除规则，理由是**别把正确性寄托在别人的默认值上**——
// 一旦哪天加了 --hidden，或 zg 改了默认，排除名单在这里能兜住。
export const VAULT_EXCLUDES = ['.obsidian', '.trash'];

// 建索引时的默认 embedding 模型。
//
// zg 的约束是「新索引必须显式给 --embedding，或已配置全局默认，二者之一」，
// 而本机 `~/.zvec-grep/config.json` 根本不存在（我们也不代用户配）——
// 没有这个默认值，`nx-kn index` 在一台干净的机器上必然报错。
//
// 选本机离线模型而不是远程 qwen：免 key、不走网络（会话代理也拦不到）、
// 中文可用，1024 维。要换远程模型仍然可以 `--model` + `--rebuild`。
export const DEFAULT_EMBEDDING = 'local/qwen3-embedding-0.6b';

// 默认模型的逃生舱：环境变量可覆盖内置默认，**不改代码**。
// 存在的理由有二：(1) CI / 干净机器用个小模型（model2vec 几十 MB）就能把
// 「加目录 → 建索引 → 检索」跑通，不必每次拉 600 MB 的 qwen；
// (2) 内网机器可以把它指向已经缓存好的那个模型。
// 只在「既没显式给 --model、索引里也没有已存 schema、这个库也没登记过模型」时才生效，
// 所以它永远不会顶掉用户明确的选择。
export const EMBEDDING_ENV = 'NX_KN_EMBEDDING';

export function defaultEmbeddingFromEnv() {
  const v = process.env[EMBEDDING_ENV];
  return v && String(v).trim() ? String(v).trim() : DEFAULT_EMBEDDING;
}


// 测试必须能指向临时目录，否则会写脏用户的真实数据。
export const STORE_ENV = 'NX_KN_STORE';

export function storePathFromEnv() {
  return process.env[STORE_ENV] || STORE_PATH;
}

export function vaultPathFromEnv() {
  return process.env[VAULT_ENV] || null;
}

// ---- 输入校验 ----
//
// 名称与路径分开校验：名称禁前导点（`.foo` 不像个名字），
// 路径允许（`.gitignore` 是完全正常的文件）。
// 早期把两者混用一套规则，结果拒绝了 `.gitignore`。
export function assertSafeName(name, label = '名称') {
  if (!name || typeof name !== 'string') throw badInput(`${label}不能为空`);
  if (/[\\/]/.test(name) || name.includes('..') || name.startsWith('.')) {
    throw badInput(`非法 ${label}: ${name}`);
  }
  return name;
}

export function assertSafeRelPath(input, { label = '文件路径', allowSubdir = true } = {}) {
  if (!input || typeof input !== 'string') throw badInput(label + '不能为空');
  if (/^([a-zA-Z]:|[\\/])/.test(input)) throw badInput(label + '必须是相对路径: ' + input);
  const segments = input.split(/[\\/]+/).filter((x) => x !== '' && x !== '.');
  if (!segments.length) throw badInput('非法 ' + label + ': ' + input);
  if (segments.includes('..')) throw badInput(label + '不得包含 ..: ' + input);
  if (!allowSubdir && segments.length > 1) {
    throw badInput(label + '不能包含路径分隔符: ' + input);
  }
  return segments.join('/');
}

// 路径与安全校验：项目里所有「东西放哪」都从这里取，不在别处拼字符串。
//
// ⚠️ 本文件是生成器的**参数化中心**——新项目由模板生成时，只替换这里的
// APP_NAME / APP_TITLE / APP_DESC / DEFAULT_PORT 四个占位（本仓取值依次是
// nx-kn / nx-kn / Obsidian 知识库检索（zg 引擎） / 7881），其余文件一律引用这些常量。
// 要加新常量请加在这里，不要在别处写字符串字面量。
//
// 注意 APP_TITLE 与 APP_NAME 在本仓是**同一个值**（模板把两处占位填成一样）。
// 展示标题的地方要先判重，别把名字打两遍——runtime/cli.js 的 appHead() 负责这件事。
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { badInput } from './errors/index.js';

// ---- 项目标识 ----
export const APP_NAME = 'nx-kn';
export const APP_TITLE = 'nx-kn';
export const APP_DESC = 'Obsidian 知识库检索（zg 引擎）';

// ---- 数据目录（用户主目录下，可用环境变量覆盖）----
export const APP_DIR = join(homedir(), '.nx-kn');
export const STORE_PATH = join(APP_DIR, 'store.json');

// ---- 资料采集（外部源）----
//
// 抓取产物落成普通 markdown 目录，再当作一个知识库登记 —— 于是索引、检索、
// 增量、多库合并全部复用 kb 域，采集域只负责「URL → 干净 markdown」。
//
// 放在「数据目录」下而不是用户随便挑的目录：采集产物是 nx-kn 的中间产物
// （可随时重抓重建），集中在一处便于「谁能删、删了会怎样」说得清。
//
// 关键：sources 目录**跟着 store.json 走**（同一个数据目录），而不是钉死在
// ~/.nx-kn/。这样 NX_KN_STORE / --store 这一个既有开关就能同时搬动
// 「库列表 + 采集产物」——测试指向临时目录即天然隔离，用户也能整体挪窝。
export const CRAWL_MANIFEST = '.nx-kn-crawl.json';

export function dataDirFromEnv() {
  return dirname(storePathFromEnv());
}

export function sourcesDir() {
  return join(dataDirFromEnv(), 'sources');
}

export function sourceDirOf(name) {
  return join(sourcesDir(), String(name));
}

// 抓取时的 User-Agent：表明身份，站点管理员若反感可据此封禁（比伪装成浏览器体面）。
// 刻意不带版本号：写死版本会随发版漂移，而无版本的 UA 已经足够表明身份。
export const CRAWL_UA = 'nx-kn (+https://github.com/On-DevPlan/nx-kn)';

// 抓取引擎。放在 core 而不是 crawl 模块里，是因为 store.js 的归一化也要用它补默认值，
// 而 core 不允许依赖 modules —— 常量各写一份迟早漂移。
//   node           内置，纯 Node（fetch + cheerio + turndown），零额外依赖
//   skill-seekers  外部 Python 引擎，默认（见 docs/plan 的决策修正）
export const CRAWL_ENGINES = ['node', 'skill-seekers'];
export const DEFAULT_CRAWL_ENGINE = 'skill-seekers';

// 相邻两次抓取的间隔（毫秒）。默认 300ms：串行 + 节流，不去打爆别人的站点。
// 测试要快，用环境变量压到 0——这条逃生舱和 NX_KN_EMBEDDING 是同一个思路。
export const CRAWL_DELAY_ENV = 'NX_KN_CRAWL_DELAY_MS';

export function crawlDelayMs() {
  const v = process.env[CRAWL_DELAY_ENV];
  if (v !== undefined && String(v).trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 300;
}

// ---- 守护（watch）----
//
// 监听已登记的库，笔记一变就自动跑增量索引。这里只放「防抖窗口」这一个参数。
//
// 默认 1500ms 而不是更短：Obsidian 保存一篇笔记会连发多个事件（写临时文件 + 改名），
// 键盘停顿前的自动保存也是独立事件流。窗口太短会把一次编辑拆成好几次索引，
// 每次都得起一个 zg 子进程；太长则「改完等半天才搜得到」。
//
// 测试要快，用环境变量压到几百毫秒甚至 0——与 NX_KN_CRAWL_DELAY_MS 同一个思路。
export const WATCH_DEBOUNCE_ENV = 'NX_KN_WATCH_DEBOUNCE_MS';

export function watchDebounceMs() {
  const v = process.env[WATCH_DEBOUNCE_ENV];
  if (v !== undefined && String(v).trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 1500;
}


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

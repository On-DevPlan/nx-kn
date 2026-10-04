// JSON 存储：用户目录下的单一数据文件，Web 表单与 agent CLI 共同读写。
//
// 这是**通用**存储：结构由 initialState() 决定。项目要加字段就改它，
// normalize 会自动给老数据补默认值——不需要写迁移脚本。
//
// 设计要点：
// - 原子写（临时文件 + rename），进程中断不会损坏数据
// - 进程内缓存 + mtime 失效检测：外部进程（如 CLI）改写后，Web 服务侧能立刻看到
// - 自己写入后主动刷新缓存 mtime，避免「自己触发自己重读」
import fsp from 'node:fs/promises';
import { dirname } from 'node:path';
import { CRAWL_ENGINES, DEFAULT_CRAWL_ENGINE, storePathFromEnv } from './paths.js';

// 项目自己的初始结构。改这里即可扩展存储，老数据由 normalize 自动补齐。
export function initialState() {
  return {
    version: 1,
    settings: {},
    // 知识库域（modules/kb）：**多个** vault，每个库各自一份索引与 embedding 模型。
    // 存在这里而不是 settings，是因为 settings 是「用户可任意填的偏好」，
    // 而这里放的是 kb 域自己的工作参数，写入口在 kb add / kb remove / index。
    //
    // 为什么是数组而不是单个 vault：zg 的索引是**按 workspace 根**组织的
    // （`<root>/.zvec-grep/`），两个 vault 天然是两个索引；要「一起搜」就得
    // 记住多个根，检索时逐库召回再合并。单值字段表达不了这件事。
    kb: { vaults: [] },
    // 资料采集域（modules/crawl）：外部文档站的抓取源。
    // 与 kb.vaults **分列**：一个是「本地已有目录」，一个是「要去抓的站点」，
    // 语义不同、生命周期也不同（源可增删，抓下来的目录会顺带登记成 vault）。
    // 每页的 url→{file,hash} 映射写在源目录内的 .nx-kn-crawl.json，
    // 不塞进 store（几百页的映射会让这个文件变得又大又吵）。
    crawl: { sources: [] },
  };
}

let cache = null;
let cacheMtime = -1;

export function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export async function loadStore(explicitPath) {
  const p = explicitPath || storePathFromEnv();
  try {
    const st = await fsp.stat(p);
    if (cache && cacheMtime === st.mtimeMs) return cache;
    const raw = await fsp.readFile(p, 'utf8');
    cache = normalize(JSON.parse(raw));
    cacheMtime = st.mtimeMs;
    return cache;
  } catch {
    // 文件不存在或损坏：返回空结构（首次运行 / 允许外部修复后恢复）
    cache = normalize(null);
    cacheMtime = -1;
    return cache;
  }
}

export async function saveStore(next, explicitPath) {
  const p = explicitPath || storePathFromEnv();
  const data = normalize(next);
  await fsp.mkdir(dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fsp.rename(tmp, p);
  cache = data;
  try {
    cacheMtime = (await fsp.stat(p)).mtimeMs;
  } catch {
    cacheMtime = -1;
  }
  return data;
}

// 读-改-写事务：fn 直接修改传入的深拷贝 store；fn 抛错则不落盘。
// 这条语义很重要——半个事务写进磁盘比不写更糟。
export async function mutateStore(fn, explicitPath) {
  const cur = structuredClone(await loadStore(explicitPath));
  const result = fn(cur);
  await saveStore(cur, explicitPath);
  return result === undefined ? cur : result;
}

// 归一化：以 initialState() 为底，把已有数据合并上去。
// 新增字段自动获得默认值，因此**不需要迁移脚本**——
// 老 store.json 缺的键会在这里补齐，多出来的键也原样带过来。
export function normalize(data) {
  const base = initialState();
  if (!data || typeof data !== 'object') return base;

  base.version = data.version ?? base.version;
  if (base.settings && typeof base.settings === 'object') {
    base.settings = { ...base.settings, ...(data.settings || {}) };
  }

  // 其余顶层键：base 里声明过的按 base 的形状兜底，没声明过的原样带过来
  for (const [k, v] of Object.entries(data)) {
    if (k === 'version' || k === 'settings' || k === 'kb' || k === 'crawl') continue;
    if (Array.isArray(v)) {
      base[k] = v;
    } else if (v && typeof v === 'object') {
      base[k] = { ...(base[k] || {}), ...v };
    } else {
      base[k] = v;
    }
  }

  // kb 走专用分支：它需要**结构性迁移**（单值 vault → vaults 数组），
  // 而上面那个通用分支对对象只做浅合并——旧数据的 `vault` / `model` 会被原样带过来，
  // `vaults` 则永远拿不到值。所以迁移必须在这里做完。
  base.kb = normalizeKb(data.kb);
  base.crawl = normalizeCrawl(data.crawl);
  return base;
}

// ---- kb 域的结构化归一化 ----

// 迁移路径（0.1.0 单库 → 多库）：
//   旧：kb = { vault: "D:\\Notes\\Vault", model: "local/qwen3-embedding-0.6b" }
//   新：kb = { vaults: [ { path, name, model, addedAt } ] }
// 旧字段读完后**不再保留**：留着会让「到底以哪个为准」变成一个悬而未决的问题。
//
// 注意迁移是**惰性**的：读命令（status / query / list）只 normalize 内存里的对象，
// 不写盘（读操作去改用户的文件是个坏习惯）；迁移结果会随下一次写入
// （kb add / kb remove / index）一起落盘，那一刻旧键才真正消失。
export function normalizeKb(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { vaults: [] };
  const seen = new Set();

  const push = (rec) => {
    if (!rec || seen.has(rec.path)) return; // 按绝对路径去重，避免同一目录被登记两次
    seen.add(rec.path);
    out.vaults.push(rec);
  };

  if (Array.isArray(src.vaults)) for (const v of src.vaults) push(normalizeVault(v));
  // 老结构：单值 vault + 一个**全局** model。
  //
  // model 刻意**不迁移**。理由不是「懒得带」，而是那个值已经被证实不可信：
  // 它是全局单值，`kb use` 切库时被原样保留，于是会出现「store 里记着 A 模型、
  // 磁盘上根本没有任何 A 模型的索引、实际索引用的是 B 模型」这种状态
  // （本机真实发生过）。把它写进每库记录，等于把一个已知脏值升级成
  // 「下次建索引时静默生效的参数」——比丢掉它危险得多。
  // 丢掉之后建索引会用 paths.js 的 DEFAULT_EMBEDDING（本机离线模型），
  // 而且面板会把「将用哪个模型」显示出来，用户看得见、改得动。
  if (typeof src.vault === 'string' && src.vault.trim()) {
    push(normalizeVault({ path: src.vault }));
  }

  return out;
}

// 单条 vault 记录：只认 path 必填，其余字段缺了给安全默认。
// name 只是**显示用**的短名（面板与结果里标注来源库），不参与任何路径拼接。
function normalizeVault(v) {
  const path = typeof v === 'string' ? v : v && v.path;
  if (typeof path !== 'string' || !path.trim()) return null;
  const obj = v && typeof v === 'object' ? v : {};
  return {
    path: String(path),
    name: obj.name ? String(obj.name) : displayNameOf(String(path)),
    model: obj.model ? String(obj.model) : null,
    addedAt: obj.addedAt ? String(obj.addedAt) : null,
  };
}

// 取路径最后一段当显示名。**刻意不用 path.basename**：它只认当前平台的分隔符，
// 而这里读的是「可能由另一个系统写下的」store.json —— POSIX 上
// `basename('D:\\Notes\\Vault')` 返回的是整串路径（反斜杠不是分隔符），
// 于是迁移出来的 name 变成一条完整路径。显示名与平台无关，两种分隔符都要认。
function displayNameOf(p) {
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(p);
}

// ---- 采集域（crawl）的结构化归一化 ----

// 一条采集源记录。name 是目录名（必填，决定抓取产物落哪），url 是起点。
// include / max 是「抓哪些、抓多少」的边界，缺省给安全值（全收 / 上限 200）。
// engine / enhanceLevel / agent 是抓取引擎参数：老记录（没有这些键）一律按默认引擎补齐，
// 于是「老 store 读进来就能用」这条约定对采集域同样成立，不需要迁移脚本。
function normalizeSource(s) {
  if (!s || typeof s !== 'object') return null;
  const name = s.name ? String(s.name) : null;
  const url = s.url ? String(s.url) : null;
  if (!name || !url) return null; // 缺 name 或 url 的记录无法工作，直接丢弃
  const max = Number(s.max);
  const engine = CRAWL_ENGINES.includes(s.engine) ? String(s.engine) : DEFAULT_CRAWL_ENGINE;
  const level = Number(s.enhanceLevel);
  return {
    name,
    url,
    engine,
    // 只认 0~3 的整数；其余（含 undefined / NaN / 越界）回落到 0 = 纯抓取，不调 LLM。
    enhanceLevel: Number.isInteger(level) && level >= 0 && level <= 3 ? level : 0,
    agent: s.agent ? String(s.agent) : null,
    include: s.include ? String(s.include) : '**',
    max: Number.isFinite(max) && max > 0 ? Math.floor(max) : 200,
    addedAt: s.addedAt ? String(s.addedAt) : null,
    lastRunAt: s.lastRunAt ? String(s.lastRunAt) : null,
    // 上一次抓取的统计（面板/列表展示用；权威数据在源目录的 manifest 里）
    pages: Number.isFinite(Number(s.pages)) ? Number(s.pages) : null,
    failed: Number.isFinite(Number(s.failed)) ? Number(s.failed) : null,
    via: s.via ? String(s.via) : null,
  };
}

export function normalizeCrawl(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { sources: [] };
  const seen = new Set();
  if (Array.isArray(src.sources)) {
    for (const s of src.sources) {
      const rec = normalizeSource(s);
      if (!rec || seen.has(rec.name)) continue; // 按 name 去重（name 就是目录名）
      seen.add(rec.name);
      out.sources.push(rec);
    }
  }
  return out;
}

// 测试与调试用：清掉进程内缓存，强制下次重读
export function clearCache() {
  cache = null;
  cacheMtime = -1;
}

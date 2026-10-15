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
import { dirname, resolve } from 'node:path';
import {
  APP_NAME,
  CRAWL_ENGINES,
  DEFAULT_CRAWL_ENGINE,
  NEEDDO_FILE_EXTS,
  sourceDirOf,
  storePathFromEnv,
} from './paths.js';

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
    // NeedDo 收件箱域（modules/needdo）：随手丢进来的文字/链接/文档条目。
    // 条目元数据在这里，原件与提取文本落 needdoDir() 下的文件——与 crawl 的
    // 「索引进 store、内容进文件」同一个分工。逐条校验见 normalizeNeeddo。
    // trash 是回收站：删除先进这里（软删除），--empty 或超期才真删。
    needdo: { items: [], trash: [] },
  };
}

let cache = null;
let cacheMtime = -1;

// 最近一次「读时发现 store 损坏并被隔离」的记录。null = 本次进程没发生过。
// 导出给 home.health 这类自检命令用——静默修复等于没修，得让用户看得见。
let lastRecovery = null;

export function storeRecovery() {
  return lastRecovery;
}

export function newId(prefix) {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// 把坏掉的 store 挪成带时间戳的备份，返回备份路径。
// 用 rename 而不是复制：坏文件留在原处的话，下次读又会走一遍这个分支。
async function quarantine(p) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const backup = `${p}.corrupt-${stamp}`;
  try {
    await fsp.rename(p, backup);
    return backup;
  } catch {
    // rename 失败（被占用 / 跨设备）：退回复制，至少把内容留下来
    try {
      await fsp.copyFile(p, backup);
      return backup;
    } catch {
      return '(备份失败——请立刻手动复制这个文件)';
    }
  }
}

export async function loadStore(explicitPath) {
  const p = explicitPath || storePathFromEnv();

  // ① 文件不存在 —— **只有这一种情况**才是「首次运行」。
  let st;
  try {
    st = await fsp.stat(p);
  } catch {
    cache = normalize(null);
    cacheMtime = -1;
    return cache;
  }

  if (cache && cacheMtime === st.mtimeMs) return cache;

  // ② 存在但读不动（权限 / 被占用）：**不能**当成空结构，否则下一次写入会盖掉它。
  let raw;
  try {
    raw = await fsp.readFile(p, 'utf8');
  } catch (err) {
    throw new Error(`存储文件读不出来: ${p}（${(err && err.code) || (err && err.message) || err}）`);
  }

  // ③ 内容不是合法 JSON —— 与 ① 是两件事，绝不能共用一个分支。
  // 当成空结构继续的话，下一次 `kb add` / `settings set` 的原子写会**把原文件覆盖掉**，
  // 全程零报错。本机真实发生过（当时靠人工备份 store.json.bak-20261004 才救回来）。
  // 处置：先把原文件留成可恢复的备份，再按空结构继续——既不静默破坏数据，也不把用户卡死。
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const backup = await quarantine(p);
    lastRecovery = {
      path: p,
      backup,
      at: new Date().toISOString(),
      reason: String((err && err.message) || err),
    };
    // core 一般不该往控制台写字，但「数据被隔离」属于必须当场可见的事件：
    // 它既不是调用方能处理的失败（那该 throw），也不该悄悄过去。
    console.error(
      '[nx-kn] 存储文件不是合法 JSON，已留备份并按空结构继续：\n' +
        `  原文件 ${p}\n` +
        `  备份   ${backup}\n` +
        `  原因   ${lastRecovery.reason}\n` +
        `  要恢复：确认备份内容无误后，把它改回上面的原文件路径（${APP_NAME} health 也会报这一条）。`
    );
    cache = normalize(null);
    cacheMtime = -1;
    return cache;
  }

  cache = normalize(parsed);
  cacheMtime = st.mtimeMs;
  return cache;
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
    if (k === 'version' || k === 'settings' || k === 'kb' || k === 'crawl' || k === 'needdo') continue;
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
  base.needdo = normalizeNeeddo(data.needdo);
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
//
// origin 记的是「这条记录是谁写进来的」，是三态而不是布尔：
//   'crawl'  抓取完成后自动登记（产物目录，内容可能与它的源目录重复）
//   'user'   用户显式添加（kb add / 面板「添加目录」）
//   null     历史数据，当时还没有这个字段
// 为什么必须区分 null 与 'user'：'user' 是「我确认要它」的明确表达，
// 一旦是它就必须**永不**被自动规则排除；而 null 只是「没记录」，
// 允许由 crawlProductVaults() 的谱系推导兜底。把两者并成一个 false 就分不出来了。
function normalizeVault(v) {
  const path = typeof v === 'string' ? v : v && v.path;
  if (typeof path !== 'string' || !path.trim()) return null;
  const obj = v && typeof v === 'object' ? v : {};
  return {
    path: String(path),
    name: obj.name ? String(obj.name) : displayNameOf(String(path)),
    model: obj.model ? String(obj.model) : null,
    addedAt: obj.addedAt ? String(obj.addedAt) : null,
    origin: obj.origin === 'crawl' || obj.origin === 'user' ? obj.origin : null,
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
    // 源类型：web = 文档站（url 是 http(s) 起点），local = 本地目录（url 是绝对路径，
    // 典型是 Obsidian vault——crawl 负责把它「整理」成干净 markdown 再入库）。
    // 老记录没有这个键 → web，与既有语义完全一致。
    kind: s.kind === 'local' ? 'local' : 'web',
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

// ---- NeedDo 收件箱域的结构化归一化 ----
//
// 一条收件箱条目。kind 三态：text（粘贴的文字）/ link（URL）/ file（上传的原件）。
// file 条目的 content 只存摘录（提取文本的前几百字），全文在 needdoDir() 下的文件里——
// store.json 是「条目清单」，不是文档仓库，塞全文会让每次读-改-写都搬运几 MB。
//
// topicSource 与 ai 是 round3（agent 交接协议）加的：
//   topicSource  'rule'（规则表定的）| 'ai'（AI 建议被接受后生效）| 'user' | null
//                —— kb 的 origin: 'user' | 'crawl' 的直系同类，人显式定的永不被 AI 覆盖
//   ai           AI 的**附注**（可空）：建议主题/摘要/标签/置信度 + 状态机
//                pending → suggested → accepted | rejected。
//                它绝不覆盖确定性字段（content/title/excerpt/topic/status 一个都不动）。
function normalizeNeeddoItem(it) {
  if (!it || typeof it !== 'object') return null;
  const id = it.id ? String(it.id) : null;
  if (!id) return null; // 无 id 的条目无法被 remove / open 定位，直接丢弃
  const kind = ['text', 'link', 'file'].includes(it.kind) ? it.kind : 'text';
  const ext = NEEDDO_FILE_EXTS.includes(it.ext) ? it.ext : null;
  if (kind === 'file' && !ext) return null; // file 条目没有合法扩展名 = 无法解析，丢弃
  // size 的空值陷阱：Number(null) 与 Number('') 都是 0，不是 NaN——
  // 「没记录体积」会被归一化成「0 字节」。空值显式拦下，只认真正的数字。
  const size = it.size === null || it.size === undefined || it.size === '' ? NaN : Number(it.size);
  return {
    id,
    kind,
    title: it.title ? String(it.title) : '',
    content: typeof it.content === 'string' ? it.content : '',
    excerpt: typeof it.excerpt === 'string' ? it.excerpt : '',
    // 文字条目里可能夹着链接（「看一下这个 https://… 再决定」）——原文保持不动，
    // 抽出来的 URL 附在这里，详情视图给可点、整理报告里单列。空数组 = 没夹链接。
    links: Array.isArray(it.links) ? it.links.filter((x) => typeof x === 'string' && x) : [],
    file: it.file ? String(it.file) : null,
    textFile: it.textFile ? String(it.textFile) : null,
    ext,
    size: Number.isFinite(size) ? size : null,
    topic: typeof it.topic === 'string' && it.topic ? it.topic : null,
    topicSource: ['rule', 'ai', 'user'].includes(it.topicSource) ? it.topicSource : null,
    ai: normalizeNeeddoAi(it.ai),
    status: it.status === 'done' ? 'done' : 'inbox',
    agent: it.agent ? String(it.agent) : null,
    addedAt: it.addedAt ? String(it.addedAt) : null,
    // editedAt 必须在白名单里：归一化是逐字段重建的，漏掉就等于「编辑痕迹被静默抹掉」
    // （条目标题看着没变，但「这条改过」这件事丢了）。
    editedAt: it.editedAt ? String(it.editedAt) : null,
    processedAt: it.processedAt ? String(it.processedAt) : null,
    // 只有回收站里的条目有值；在册条目恒为 null（删除时写上，恢复时清掉）。
    deletedAt: it.deletedAt ? String(it.deletedAt) : null,
  };
}

// AI 附注（round3）。status 四态：pending（排队待复核）→ suggested（agent 已给建议，
// 等人/面板接受）→ accepted | rejected。level 照 crawl 的 0-3（0 = 没调 LLM，
// 也不该有附注——但真出现了就照实留着，归一化的职责是校验不是抹除）。
function normalizeNeeddoAi(ai) {
  if (!ai || typeof ai !== 'object') return null;
  const status = ['pending', 'suggested', 'accepted', 'rejected'].includes(ai.status) ? ai.status : null;
  if (!status) return null;
  const level = Number(ai.level);
  // confidence 与 size 同一个坑：Number(null) === 0 会把「没给置信度」变成「置信 0」，
  // 而 0 在面板上是个有意义的读数（看起来像 AI 很不确定）。空值显式拦下。
  const conf =
    ai.confidence === null || ai.confidence === undefined || ai.confidence === ''
      ? NaN
      : Number(ai.confidence);
  return {
    status,
    level: Number.isInteger(level) && level >= 0 && level <= 3 ? level : 0,
    agent: ai.agent ? String(ai.agent) : null,
    at: ai.at ? String(ai.at) : null,
    rev: ai.rev ? String(ai.rev) : null,
    batchId: ai.batchId ? String(ai.batchId) : null,
    topic: typeof ai.topic === 'string' && ai.topic ? ai.topic : null,
    summary: typeof ai.summary === 'string' && ai.summary ? ai.summary : '',
    tags: Array.isArray(ai.tags) ? ai.tags.filter((x) => typeof x === 'string' && x) : [],
    confidence: Number.isFinite(conf) ? conf : null,
  };
}

export function normalizeNeeddo(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { items: [], trash: [] };
  const seen = new Set();
  if (Array.isArray(src.items)) {
    for (const it of src.items) {
      const rec = normalizeNeeddoItem(it);
      if (!rec || seen.has(rec.id)) continue; // 按 id 去重
      seen.add(rec.id);
      out.items.push(rec);
    }
  }
  // 回收站与在册条目同一套逐字段校验（同一形状），只是多一个 deletedAt；
  // id 去重跨两个列表一起算——同一条不该同时躺在两处。
  if (Array.isArray(src.trash)) {
    for (const it of src.trash) {
      const rec = normalizeNeeddoItem(it);
      if (!rec || seen.has(rec.id)) continue;
      seen.add(rec.id);
      out.trash.push(rec);
    }
  }
  return out;
}

// ---- 库之间的谱系：抓取产物 ←→ 它的源目录 ----
//
// 为什么需要这条判据：`crawl run` 会把产物目录**自动登记为知识库**，而本地目录源
// （kind: 'local'，典型是 Obsidian vault）的源目录本身往往也是一个登记库。
// 于是同一批笔记在列表里出现两份，检索时各给一条命中、各占一个 --limit 名额——
// 而 nx-kn 是「逐库召回再按融合分合并」，没有跨库去重这一步。
//
// 为什么不用内容相似度去重：两份内容**并不相同**（产物被加了 source/engine/fetchedAt
// 头部、目录结构也被重排过），哈希与路径都对不上，只剩标题可猜。猜错了
// 把两篇真不同的笔记当成同一篇吞掉一条命中，比不去重更糟。
//
// 而谱系是**已知的**、不需要猜：产物目录 = sourceDirOf(源名)，源目录 = 源的 url。
// 两条都是我们自己写下的值。判据因此是完全确定的。
//
// 刻意**只**在「源目录也是一个登记库」时成立：
//   - web 源（url 是 https://…）没有对应的本地库，产物就是唯一副本，绝不能收起来；
//   - 本地目录源但用户从未 kb add 过那个目录，同理——收起来等于内容凭空消失。
// 只收「确实重复」的那一类，是这条规则唯一的安全边界。
//
// 路径比较沿用本仓既有约定（resolve 后严格相等），不额外做大小写折叠：
// 同一份代码里出现第二套路径比较规则，是比大小写更难查的问题。
export function crawlProductVaults(store) {
  const vaults = (store && store.kb && store.kb.vaults) || [];
  const sources = (store && store.crawl && store.crawl.sources) || [];
  const known = new Set(vaults.map((v) => resolve(String(v.path))));

  const out = new Map(); // 产物库路径 → 源库路径
  for (const s of sources) {
    if (!s || !s.name || !s.url) continue;
    const product = resolve(sourceDirOf(s.name));
    if (!known.has(product)) continue; // 产物没登记：无所谓
    const src = resolve(String(s.url));
    if (src === product) continue; // 源就是产物（病态数据），不构成「两份」
    if (!known.has(src)) continue; // 源目录不是登记库：产物是唯一副本，不能收
    out.set(product, src);
  }
  return out;
}

// 「默认不参与检索」的库 → 原因是哪个源库。
//
// 只有 origin !== 'user' 的才可能被收起来：用户显式 kb add 过的记录，
// 无论它长得多像某个源的产物，都按「我确认要它」处理，永不自动排除。
// 这也正是 kb add 能当「启用」用的原因——不需要再造一个 kb standby 命令。
export function standbyVaults(store) {
  const lineage = crawlProductVaults(store);
  const out = new Map();
  for (const v of (store && store.kb && store.kb.vaults) || []) {
    if (v.origin === 'user') continue;
    const key = resolve(String(v.path));
    if (lineage.has(key)) out.set(key, lineage.get(key));
  }
  return out;
}

// 测试与调试用：清掉进程内状态（缓存 + 上一次的隔离记录），强制下次重读
export function clearCache() {
  cache = null;
  cacheMtime = -1;
  lastRecovery = null;
}

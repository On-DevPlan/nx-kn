// needdo 域：混乱输入收件箱的业务逻辑。
//
// 三种输入（粘贴文字 / 链接 / 上传文档）统一落成「条目」：元数据进 store.json 的
// needdo.items，文档原件与提取文本落 needdoDir() 下的文件。整理（process）把
// 收件箱条目按主题归类产出 markdown，并归档条目——「捕获 → 整理 → 归档」一圈。
//
// 与其他域同一个纪律：所有「放哪」的路径从 core/paths.js 取，所有读写走
// core/store.js 的事务接口，这里不直接拼路径、不绕过 mutateStore。
import fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  NEEDDO_FILE_EXTS,
  NEEDDO_FILE_MAX_BYTES,
  needdoDir,
} from '../../core/paths.js';
import { loadStore, mutateStore, newId } from '../../core/store.js';
import { badInput, notFound } from '../../core/errors/index.js';
import { extractText } from './extract.js';

const TITLE_LEN = 60;
const EXCERPT_LEN = 200;

// 从一段混排文字里抽 URL。原文不动（收件箱的第一原则是忠实收下），
// 抽出的链接附在条目上：详情里可点、报告里单列——「这条里藏着链接」因此可见。
// 排除集带全角标点：中文句读不是 URL 的一部分（「https://b.com/y，第一遍」的
// 逗号必须断开）；再修剪尾部 ASCII 标点——「(见 https://a.com/x)」的右括号同理。
const URL_RE = /https?:\/\/[^\s<>"'，。；！？、：（）《》【】「」『』·—…]+/g;

export function extractLinks(text) {
  return [...new Set((String(text || '').match(URL_RE) || []).map((u) => u.replace(/[.,;:!?'")\]]+$/, '')))];
}

// 主题分类。刻意做成有序规则表而不是关键词大杂烩：**可执行的比可读的优先**——
// 一条带「截止」的公告，对收件箱的主人来说是待办，不是读物。规则自上而下首个命中生效。
const TOPIC_RULES = [
  {
    topic: '待办事项',
    re: /\btodo\b|待办|记得|别忘|需要做|尽快|抓紧|deadline|截止|到期|提交/i,
  },
  {
    topic: '公告通知',
    re: /公告|通知|周知|会议|放假|调休|安排|转发|纪要|请示|审批/,
  },
];

const TOPIC_DOC = '文档资料'; // file 条目的固定主题（有原件在，内容形态即主题）
const TOPIC_LINK = '链接收藏'; // link 条目的固定主题
const TOPIC_MISC = '杂项收集'; // 兜底：收件箱 philosophy 是「先收进来」，不硬猜

function titleOf(kind, raw) {
  if (kind === 'file') return String(raw).slice(0, TITLE_LEN);
  if (kind === 'link') return String(raw).replace(/^https?:\/\//, '').slice(0, TITLE_LEN);
  const first = String(raw).split('\n').map((s) => s.trim()).find(Boolean) || '(空)';
  return first.slice(0, TITLE_LEN);
}

function excerptOf(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > EXCERPT_LEN ? s.slice(0, EXCERPT_LEN - 1) + '…' : s;
}

export function classifyTopic(item) {
  if (item.kind === 'file') return TOPIC_DOC;
  if (item.kind === 'link') return TOPIC_LINK;
  for (const r of TOPIC_RULES) {
    if (r.re.test(item.content)) return r.topic;
  }
  return TOPIC_MISC;
}

// ---- 入库 ----

async function pushItem(item) {
  return mutateStore((store) => {
    store.needdo.items.push(item);
    return item;
  });
}

export async function addText(text, title) {
  const body = String(text || '').trim();
  if (!body) throw badInput('文字内容不能为空');
  return pushItem({
    id: newId('nd'),
    kind: 'text',
    title: title ? String(title).slice(0, TITLE_LEN) : titleOf('text', body),
    content: body,
    excerpt: excerptOf(body),
    links: extractLinks(body),
    status: 'inbox',
    addedAt: new Date().toISOString(),
  });
}

export async function addLink(url) {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) throw badInput(`链接必须以 http(s) 开头: ${u}`);
  return pushItem({
    id: newId('nd'),
    kind: 'link',
    title: titleOf('link', u),
    content: u,
    excerpt: u,
    status: 'inbox',
    addedAt: new Date().toISOString(),
  });
}

// 文件入库（原件落盘 + 尽力提取文本）。CLI 与 HTTP 上传共用这一条路：
// CLI 从 --file 路径读出 buffer，HTTP 把 base64 解码成 buffer，之后完全同构。
export async function addFileData(name, buf, title) {
  const cleanName = String(name || '').trim() || '未命名';
  const ext = (cleanName.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  if (!NEEDDO_FILE_EXTS.includes(ext)) {
    throw badInput(`不支持的文件类型: ${cleanName}（目前收 ${NEEDDO_FILE_EXTS.join(' / ')}）`);
  }
  const bin = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf || ''), 'binary');
  if (!bin.length) throw badInput(`文件为空: ${cleanName}`);
  if (bin.length > NEEDDO_FILE_MAX_BYTES) {
    throw badInput(`文件超过上限（${Math.floor(NEEDDO_FILE_MAX_BYTES / 1024 / 1024)}MB）: ${cleanName}`);
  }

  const id = newId('nd');
  const dir = needdoDir();
  await fsp.mkdir(dir, { recursive: true });
  const fileName = `${id}.${ext}`;
  await fsp.writeFile(join(dir, fileName), bin);

  // 提取失败不挡入库：收件箱第一承诺是「收进来」，提取是加分项。
  const text = extractText(ext, bin);
  let textFile = null;
  if (text) {
    textFile = `${id}.txt`;
    await fsp.writeFile(join(dir, textFile), text, 'utf8');
  }

  return pushItem({
    id,
    kind: 'file',
    title: title ? String(title).slice(0, TITLE_LEN) : titleOf('file', cleanName),
    content: '',
    excerpt: text ? excerptOf(text) : '（未能提取文本，原件已保留）',
    file: fileName,
    textFile,
    ext,
    size: bin.length,
    status: 'inbox',
    addedAt: new Date().toISOString(),
  });
}

export async function addFileFromPath(path, title) {
  const p = String(path || '').trim();
  if (!p) throw badInput('缺少文件路径');
  let buf;
  try {
    buf = await fsp.readFile(p);
  } catch (e) {
    throw badInput(`文件读不出来: ${p}（${(e && e.code) || e}）`);
  }
  return addFileData(basename(p), buf, title);
}

// 统一入口：按给了什么分发。一条命令吃四种输入，UI 的大输入框也走这里。
export async function add(ctx = {}) {
  const text = Array.isArray(ctx.text) ? ctx.text.join(' ').trim() : String(ctx.text || '').trim();
  if (ctx.file) return addFileFromPath(ctx.file, ctx.title);
  if (ctx.data) return addFileData(ctx.name, Buffer.from(String(ctx.data), 'base64'), ctx.title);
  if (ctx.link) return addLink(ctx.link);
  if (text) return addText(text, ctx.title);
  throw badInput('没有可入库的内容 —— 给 <text>、--link <url> 或 --data/--name（文件上传）');
}

// ---- 查看 ----

function itemsOf(store) {
  return store.needdo.items;
}

export async function list({ status, topic } = {}) {
  const store = await loadStore();
  const all = itemsOf(store);
  let items = all.slice().sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  if (status) items = items.filter((x) => x.status === status);
  if (topic) items = items.filter((x) => x.topic === topic);
  return {
    count: items.length,
    total: all.length,
    inbox: all.filter((x) => x.status === 'inbox').length,
    items,
  };
}

// 单条详情：text/link 直接带全文，file 带提取文本全文（没有就 null）——
// 给 agent 与「点开细看」用一条命令拿全上下文，而不是再去摸文件。
export async function show({ id } = {}) {
  const store = await loadStore();
  const item = itemsOf(store).find((x) => x.id === id);
  if (!item) throw notFound(`没有这条条目: ${id}`);
  let text = null;
  if (item.kind === 'file' && item.textFile) {
    try {
      text = await fsp.readFile(join(needdoDir(), item.textFile), 'utf8');
    } catch {
      text = null; // 文件被手动清走：详情降级为无全文，条目仍在
    }
  }
  return { item, text: text ?? (item.kind === 'text' ? item.content : item.content || null) };
}

// 原件绝对路径（面板下载 / CLI 提示「在文件管理器里看」用）。
export function filePathOf(item) {
  return item && item.file ? join(needdoDir(), item.file) : null;
}

// 原件内容（base64）：面板「下载原件」走 JSON API 的通道——HTTP 层是纯 JSON 的，
// 二进制以 base64 过境（3MB 上限内），CLI 侧同一条 action 只打印路径与尺寸。
export async function fileData({ id } = {}) {
  const store = await loadStore();
  const item = itemsOf(store).find((x) => x.id === id);
  if (!item) throw notFound(`没有这条条目: ${id}`);
  if (!item.file) throw badInput(`这条条目没有原件（${item.kind === 'file' ? '原件文件丢失' : '非文件条目'}）`);
  let buf;
  try {
    buf = await fsp.readFile(join(needdoDir(), item.file));
  } catch (e) {
    throw notFound(`原件读不出来（可能被手动移走）: ${item.file}（${(e && e.code) || e}）`);
  }
  return {
    id: item.id,
    name: item.title || item.file,
    ext: item.ext,
    size: buf.length,
    path: join(needdoDir(), item.file),
    data: buf.toString('base64'),
  };
}

// ---- 整理与移除 ----

// 整理收件箱：给未归档条目定主题、写整理报告、归档（inbox → done）。
// --ids 选择子集（面板多选与 CLI 的 `--ids a,b` 同源）；不给 = 全部 inbox 条目。
// --agent 是预留的 AI 接入点：v1 只做确定性分类，agent 名先记录在案——
// 接入后这里换成「先跑规则、再交给 agent 复核」的两段式，输出结构不变。
export async function process({ agent, ids } = {}) {
  const dir = join(needdoDir(), 'processed');
  await fsp.mkdir(dir, { recursive: true });
  const wanted = Array.isArray(ids) ? new Set(ids) : ids ? new Set([ids]) : null;

  const at = new Date();
  const result = await mutateStore((store) => {
    const pending = itemsOf(store).filter((x) => x.status === 'inbox' && (!wanted || wanted.has(x.id)));
    for (const it of pending) {
      it.topic = classifyTopic(it);
      it.status = 'done';
      it.processedAt = at.toISOString();
      if (agent) it.agent = String(agent);
    }
    return pending;
  });

  const byTopic = new Map();
  for (const it of result) {
    if (!byTopic.has(it.topic)) byTopic.set(it.topic, []);
    byTopic.get(it.topic).push(it);
  }

  // 报告文件名用本地时间（用户看得懂），条目时间戳仍走 ISO。
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}-${p2(at.getMonth() + 1)}-${p2(at.getDate())}` +
    `_${p2(at.getHours())}-${p2(at.getMinutes())}-${p2(at.getSeconds())}`;
  const file = join(dir, `${stamp}.md`);
  const lines = [
    `# NeedDo 整理报告 · ${new Date().toLocaleString()}`,
    '',
    `共整理 ${result.length} 条收件箱条目` +
      (agent ? `（--agent ${agent}；AI 深度整理待接入，本次为确定性主题分类）` : '（确定性主题分类）') +
      '',
  ];
  for (const [topic, list] of byTopic) {
    lines.push(`## ${topic}（${list.length} 条）`, '');
    for (const it of list) {
      lines.push(`- [${it.id}] ${it.title}`);
      if (it.excerpt && it.excerpt !== it.title) lines.push(`  ${it.excerpt}`);
      if (it.kind === 'link') lines.push(`  ${it.content}`);
      if (it.links && it.links.length) lines.push(`  内含链接: ${it.links.join('  ')}`);
      if (it.file) lines.push(`  原件: ${filePathOf(it)}`);
      lines.push(`  收于 ${String(it.addedAt).replace('T', ' ').slice(0, 16)}`);
    }
    lines.push('');
  }
  if (result.length) await fsp.writeFile(file, lines.join('\n'), 'utf8');

  return {
    processed: result.length,
    byTopic: [...byTopic.entries()].map(([topic, list]) => ({ topic, count: list.length })),
    report: result.length ? file : null,
    agent: agent || null,
  };
}

// 归档 / 还原：不经过整理的流转。收件箱的心智是「处理掉 = 移出视野」
// 而不是删掉——条目二态 inbox | done，归档随时可逆（undo）。
// 单条（id）与批量（ids）一个入口：面板多选与 CLI 的 `--ids a,b` 走同一契约。
// 批量里部分条目不存在不算失败（可能已被别处删掉），missing 如实回报；
// 但全部都不存在时按 notFound 报——静默的空操作比报错更难排查。
export async function archive({ id, ids, undo } = {}) {
  const wanted = Array.isArray(ids) ? ids : ids ? [ids] : id ? [id] : [];
  if (!wanted.length) throw badInput('缺少条目 id（单个 id 或 ids 数组）');
  return mutateStore((store) => {
    const touched = [];
    for (const it of itemsOf(store)) {
      if (!wanted.includes(it.id)) continue;
      it.status = undo ? 'inbox' : 'done';
      if (!undo && !it.processedAt) it.processedAt = new Date().toISOString();
      touched.push(it.id);
    }
    if (!touched.length) throw notFound(`没有这些条目: ${wanted.join(', ')}`);
    return {
      count: touched.length,
      ids: touched,
      missing: wanted.filter((x) => !touched.includes(x)),
      status: undo ? 'inbox' : 'done',
    };
  });
}

// 移除：单条（id）、批量（ids）或全部（all）。条目关联的原件与提取文本一起清，
// 但整理报告（processed/*.md）永不自动删——它是历史，不是收件箱的一部分。
// 文件清理放在事务**之后**：mutateStore 的 fn 是同步的（抛错则不落盘），
// 异步清文件混进去会让「半个事务」语义失效。
export async function remove({ id, ids, all } = {}) {
  const result = await mutateStore((store) => {
    const items = itemsOf(store);
    if (all) {
      const gone = items.splice(0, items.length);
      return { gone, removed: gone.length, ids: gone.map((x) => x.id), missing: [] };
    }
    const wanted = Array.isArray(ids) ? ids : ids ? [ids] : id ? [id] : [];
    if (!wanted.length) throw badInput('缺少条目 id（单个 id、ids 数组或 --all）');
    const wantedSet = new Set(wanted);
    const gone = items.filter((x) => wantedSet.has(x.id));
    if (!gone.length) throw notFound(`没有这些条目: ${wanted.join(', ')}`);
    const goneIds = new Set(gone.map((x) => x.id));
    // 过滤重建而不是按下标 splice：批量选中的条目在列表里不连续，
    // 「从首个命中处删 N 个」会把夹在中间的无辜条目一起带走。
    store.needdo.items = items.filter((x) => !goneIds.has(x.id));
    return {
      gone,
      removed: gone.length,
      ids: gone.map((x) => x.id),
      missing: wanted.filter((x) => !goneIds.has(x)),
    };
  });
  await removeFiles(result.gone);
  return { removed: result.removed, ids: result.ids, missing: result.missing };
}

async function removeFiles(items) {
  const dir = needdoDir();
  for (const it of items) {
    for (const f of [it.file, it.textFile]) {
      if (!f) continue;
      try {
        await fsp.rm(join(dir, f), { force: true });
      } catch {
        // 清不掉就留着（孤儿文件无害，health 类命令可以后续清扫）
      }
    }
  }
}

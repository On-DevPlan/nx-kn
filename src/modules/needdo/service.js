// needdo 域：混乱输入收件箱的业务逻辑。
//
// 三种输入（粘贴文字 / 链接 / 上传文档）统一落成「条目」：元数据进 store.json 的
// needdo.items，文档原件与提取文本落 needdoDir() 下的文件。整理（process）把
// 收件箱条目按主题归类产出 markdown，并归档条目——「捕获 → 整理 → 归档」一圈。
//
// 与其他域同一个纪律：所有「放哪」的路径从 core/paths.js 取，所有读写走
// core/store.js 的事务接口，这里不直接拼路径、不绕过 mutateStore。
import fsp from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

// ---- agent 交接协议（round3）----
//
// 三步两个命令：brief（一次拿全的自足 JSON）→ agent 离线加工 → apply（一份计划文件
// 单次写回）→ review（人/面板接受或拒绝建议）。设计纪律借自三处既有先例：
//   · crawl 的 `--enhance-level 0-3`：LLM 用量用显式级别表达，0 = 零 LLM、可离线可 CI
//   · kb 的 `origin`：来源字段三态，人显式定的永不被自动规则覆盖 → topicSource
//   · round2 的 links[]：原文一字不动，产出**附挂**在条目上 → ai 段只追加、不覆盖
//
// 为什么 AI 只能写 `ai.*` 而不能直接改 `topic`：确定性规则「可解释、可回归测试」
// 是这套收件箱的地基，AI 结果会漂移、要人拍板。两者分列之后，规则表永远可重放，
// AI 建议则带完整 provenance（谁、哪一级、什么时候、基于哪一版内容）。

// 级别 0-3 的语义（与 crawl 同一把尺子）。0 是默认值，且必须是「什么都不调」。
const LEVEL_TASK = {
  0: '纯规则分类（不调用任何 AI）',
  1: '复核主题：只对明显该改的条目给 topic，拿不准就给 null',
  2: '复核主题 + 一句话摘要 summary',
  3: '复核主题 + 一句话摘要 summary + 3-5 个标签 tags',
};

export function assertLevel(level) {
  const n = Number(level ?? 0);
  // 非 0-3 直接报错，**不静默回落**——crawl 那条纪律：级别写错必须当场知道，
  // 悄悄按 0 跑会让人以为 AI 参与了（或相反），两种误解都比报错贵。
  if (!Number.isInteger(n) || n < 0 || n > 3) {
    throw badInput(`enhance-level 只能是 0-3 的整数，收到: ${level}`);
  }
  return n;
}

// 条目内容指纹。给「这份 brief 是在哪一版内容上做的」一个确定性锚点：
// apply 时重算比对，不一致说明 agent 加工期间条目被人动过（改了、归档了、删了），
// 该跳过而不是硬写。topic 也进指纹——别人刚接受过另一份建议也算「动过」。
export function revOf(item) {
  const h = createHash('sha256');
  h.update(
    [item.kind, item.title, item.content, item.file || '', item.ext || '', item.topic || ''].join('\n')
  );
  return h.digest('hex').slice(0, 8);
}

// 文件条目的提取文本全文（brief 要「自足」：agent 不该再回去摸 needdo/ 目录）。
// 超长截断——一个几 MB 的文档塞进简报只会让 agent 的上下文白烧。
const BRIEF_TEXT_MAX = 100_000;

async function fullTextOf(item) {
  if (item.kind !== 'file') return item.content;
  if (!item.textFile) return null;
  try {
    const text = await fsp.readFile(join(needdoDir(), item.textFile), 'utf8');
    return text.length > BRIEF_TEXT_MAX ? text.slice(0, BRIEF_TEXT_MAX) + '\n（后文截断）' : text;
  } catch {
    return null; // 提取文本被手动清走：简报降级为无全文，条目仍在
  }
}

function newBatchId(at) {
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp =
    `${at.getFullYear()}${p2(at.getMonth() + 1)}${p2(at.getDate())}` +
    `-${p2(at.getHours())}${p2(at.getMinutes())}`;
  return `nb-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
}

// 导出简报：**一次调用拿全**（一份 brief = 一次 agent 会话），不要逐条拉。
// 默认只导出「还没被 AI 处理过」的条目；--redo 才把已有建议的也带上（重跑不重复喂）。
export async function brief({ ids, level = 1, redo } = {}) {
  const lv = assertLevel(level);
  if (lv === 0) {
    throw badInput('brief 的 --enhance-level 至少是 1（0 = 纯规则分类，用 process 就行）');
  }
  const store = await loadStore();
  const wanted = Array.isArray(ids) ? new Set(ids) : ids ? new Set([ids]) : null;

  let picked = itemsOf(store);
  if (wanted) picked = picked.filter((x) => wanted.has(x.id));
  else if (!redo) picked = picked.filter((x) => !x.ai || x.ai.status === 'pending');
  // 先收的先看：简报按入库时间升序，agent 的输出顺序才与人的直觉一致
  picked = picked.slice().sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));

  const at = new Date();
  const items = [];
  for (const it of picked) {
    items.push({
      id: it.id,
      kind: it.kind,
      title: it.title,
      excerpt: it.excerpt,
      links: it.links,
      addedAt: it.addedAt,
      status: it.status,
      ruleTopic: classifyTopic(it), // 规则表的预判——给 agent 一个「要不要修正」的基线
      rev: revOf(it),
      text: await fullTextOf(it),
    });
  }

  return {
    batchId: newBatchId(at),
    level: lv,
    task: LEVEL_TASK[lv],
    generatedAt: at.toISOString(),
    count: items.length,
    items,
    howto: [
      '把这份 JSON 交给 agent（如 Claude Code），按 task 逐条给出建议。',
      '写好计划文件后：nx-kn needdo apply --plan <计划.json>',
      '计划形状：{ batchId, agent, level, results: [{ id, rev, topic?, summary?, tags?, confidence? }] }',
      '想改就改、不想改就给 null/省略——建议会先落成「待复核」，不会直接改主题。',
    ],
  };
}

// 写回计划：只追加 `ai` 段，绝不覆盖 content/title/excerpt/topic/status。
// 幂等键 (batchId, id, rev)：同一份计划重复 apply = no-op（报 unchanged）。
export async function apply({ plan, planPath, agent } = {}) {
  let doc = plan;
  // CLI 走 --plan <路径>（与 needdo add --file 同一种「从路径读」的通道），
  // 面板/HTTP 走 body.planData 直接带对象（未声明键原样透传是 api.js 的既有行为）。
  if (!doc && planPath) {
    let raw;
    try {
      raw = await fsp.readFile(String(planPath), 'utf8');
    } catch (e) {
      throw badInput(`计划文件读不出来: ${planPath}（${(e && e.code) || e}）`);
    }
    try {
      doc = JSON.parse(raw);
    } catch (e) {
      throw badInput(`计划文件不是合法 JSON: ${planPath}（${e.message}）`);
    }
  }
  if (!doc || typeof doc !== 'object') {
    throw badInput('缺少计划 —— CLI 用 --plan <计划.json>，面板走 body.planData');
  }
  const results = Array.isArray(doc.results) ? doc.results : null;
  if (!results || !results.length) throw badInput('计划里没有 results 数组（或它是空的）');
  const lv = assertLevel(doc.level ?? 1);
  const agentName = agent || (doc.agent ? String(doc.agent) : null);
  const batchId = doc.batchId ? String(doc.batchId) : null;
  const at = new Date().toISOString();

  const out = { applied: 0, unchanged: 0, stale: 0, missing: 0, staleIds: [], missingIds: [], batchId };
  await mutateStore((store) => {
    const byId = new Map(itemsOf(store).map((x) => [x.id, x]));
    for (const r of results) {
      const item = byId.get(String(r.id));
      if (!item) {
        out.missing++;
        out.missingIds.push(String(r.id));
        continue;
      }
      const cur = revOf(item);
      if (r.rev && String(r.rev) !== cur) {
        // 内容变过：简报已过期。跳过不报错——对齐 archive 的 missing 口径，
        // 部分失效不算失败，但数字要说话（人会知道有几条得重跑）。
        out.stale++;
        out.staleIds.push(item.id);
        continue;
      }
      if (batchId && item.ai && item.ai.batchId === batchId && item.ai.status === 'suggested') {
        out.unchanged++; // 同一份计划重放
        continue;
      }
      item.ai = {
        status: 'suggested',
        level: lv,
        agent: agentName,
        at,
        rev: cur,
        batchId,
        topic: r.topic == null ? null : String(r.topic),
        summary: r.summary == null ? '' : String(r.summary),
        tags: Array.isArray(r.tags) ? r.tags.map(String) : [],
        confidence: r.confidence == null ? null : Number(r.confidence),
      };
      out.applied++;
    }
    if (!out.applied && !out.unchanged && (out.stale || out.missing)) {
      // 一条都没落上：把原因说清（全 stale / 全 missing 各有各的处置）
      throw badInput(
        `计划里没有可写入的结果（过期 ${out.stale} 条 / 不存在 ${out.missing} 条）——重跑 ${'nx-kn needdo brief'} 拿最新一版`
      );
    }
  });
  return out;
}

// 复核：接受（写 topic 并记 topicSource='ai'）或拒绝（只清状态）。
// 只是标记「这条建议被人看过并拍板了」，不归档——归档仍归 process。
export async function review({ id, ids, reject } = {}) {
  const wanted = Array.isArray(ids) ? ids : ids ? [ids] : id ? [id] : [];
  if (!wanted.length) throw badInput('缺少条目 id（单个 id 或 ids 数组）');
  return mutateStore((store) => {
    const byId = new Map(itemsOf(store).map((x) => [x.id, x]));
    const res = { accepted: 0, rejected: 0, noSuggestion: [], missing: [] };
    for (const wid of wanted.map(String)) {
      const item = byId.get(wid);
      if (!item) {
        res.missing.push(wid);
        continue;
      }
      if (!item.ai || item.ai.status !== 'suggested') {
        res.noSuggestion.push(wid);
        continue;
      }
      if (reject) {
        item.ai.status = 'rejected';
        res.rejected++;
      } else {
        item.ai.status = 'accepted';
        if (item.ai.topic) {
          item.topic = item.ai.topic;
          item.topicSource = 'ai'; // 来源留痕：这条主题是 AI 建议被人接受的，不是规则定的
        }
        res.accepted++;
      }
    }
    if (!res.accepted && !res.rejected) {
      throw notFound(`没有待复核的 AI 建议: ${[...res.noSuggestion, ...res.missing].join(', ')}`);
    }
    return res;
  });
}

// 整理收件箱：给未归档条目定主题、写整理报告、归档（inbox → done）。
// --ids 选择子集（面板多选与 CLI 的 `--ids a,b` 同源）；不给 = 全部 inbox 条目。
// --enhance-level ≥1 时，同时把条目标成「待 AI 复核」（ai.status='pending'）——
// 规则照跑、照归档，AI 只是在这之后补一层建议（brief → apply → review）。
// 级别只影响「要不要挂上 AI 队列」，绝不影响规则分类的结果（那必须是可复现的）。
export async function process({ agent, ids, level = 0 } = {}) {
  const lv = assertLevel(level);
  const dir = join(needdoDir(), 'processed');
  await fsp.mkdir(dir, { recursive: true });
  const wanted = Array.isArray(ids) ? new Set(ids) : ids ? new Set([ids]) : null;

  const at = new Date();
  const result = await mutateStore((store) => {
    const pending = itemsOf(store).filter((x) => x.status === 'inbox' && (!wanted || wanted.has(x.id)));
    for (const it of pending) {
      it.topic = classifyTopic(it);
      it.topicSource = 'rule';
      it.status = 'done';
      it.processedAt = at.toISOString();
      if (agent) it.agent = String(agent);
      if (lv >= 1) {
        it.ai = {
          status: 'pending',
          level: lv,
          agent: agent ? String(agent) : null,
          at: at.toISOString(),
          rev: revOf(it),
          batchId: null,
          topic: null,
          summary: '',
          tags: [],
          confidence: null,
        };
      }
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
    `共整理 ${result.length} 条收件箱条目（确定性主题分类；级别 ${lv}）` +
      (agent ? `· agent ${agent}` : '') +
      (lv >= 1 ? ` · 已排队等 AI 复核：${`needdo brief --level ${lv}`}` : ''),
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
      // AI 建议只作附注行；accepted 之后才并进正题（人拍板过的才算结论）
      if (it.ai && it.ai.status === 'accepted' && it.ai.summary) lines.push(`  摘要(AI): ${it.ai.summary}`);
      if (it.ai && it.ai.status === 'suggested') {
        lines.push(`  AI 建议(${it.ai.agent || 'agent'}${it.ai.confidence != null ? ` ${it.ai.confidence}` : ''}): 主题 → ${it.ai.topic || '(不改)'}（待复核）`);
      }
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
    level: lv,
    pendingAi: lv >= 1 ? result.length : 0,
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

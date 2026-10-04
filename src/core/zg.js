// zg（zvec-grep）驱动：进程调用 + 输出解析。
//
// 分层位置：core（零业务语义）。只回答两件事——
//   1. 怎么把 zg 跑起来（含 Windows 的 .cmd 与 cwd 约束）
//   2. zg 打出来的文字是什么意思（解析成结构，供上层与面板消费）
// 「知识库是哪个目录、要排除什么、结果怎么呈现」属于业务，在 modules/kb/service.js。
//
// 三条来自 zg 0.2.2 本机实测的硬约束：
//   1. Windows 上 zg 是 .cmd：直接 spawn 会 ENOENT，必须经 cmd.exe /d /s /c。
//   2. `zg query` **没有位置参数 root**：workspace 由**子进程 cwd** 解析，
//      所以 runZg 必须支持 cwd（这是 nx-rp 实测踩出来的）。
//   3. `zg query --json` 已被移除（报错「--json has been removed; use the default
//      agent markdown output or --human」）——输出解析因此是本文件的正式组成部分，
//      不是顺手加的小工具。解析规则有单测盯着（tests/unit/zg-parser.test.mjs）。
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { badInput, external } from './errors/index.js';

export const ZG_BIN = process.platform === 'win32' ? 'zg.cmd' : 'zg';

// zg 的索引目录名（zg 自己拥有，我们只判断在不在）
export const INDEX_DIR = '.zvec-grep';

export function indexDirOf(root) {
  return join(root, INDEX_DIR);
}

export function hasIndex(root) {
  try {
    return existsSync(indexDirOf(root));
  } catch {
    return false;
  }
}

// ---- 进程调用 ----

// cmd.exe 会把 `%VAR%` 展开、把 `"` 当引号边界，两者都能把一次调用变形成另一次调用。
// 我们无法在 cmd 里可靠地转义它们（在命令行上下文的转义规则与批处理不同），
// 所以宁可当场报错，也不要把一个可疑的字符串拼进命令行。
const CMD_UNSAFE = /["%]/;

function quoteArg(a) {
  const s = String(a);
  return /[\s"^&|<>]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * 一次性调用 zg（--mode direct 是上层的选择，这里不预设）。
 * 永不在失败时抛——返回 { ok, code, stdout, stderr }，由上层决定是「业务结果」
 * 还是「失败」。
 */
export function runZg(args, { cwd, timeoutMs = 120_000 } = {}) {
  for (const a of args) {
    if (CMD_UNSAFE.test(String(a))) {
      throw badInput(
        `参数含不允许的字符（" 或 %）: ${a} —— Windows 下这些字符会改变命令行语义，请改写措辞后重试`
      );
    }
  }

  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    const finish = (code, error) =>
      resolve({
        ok: !error && code === 0,
        code: error ? (error.code ?? 1) : code,
        stdout,
        stderr: stderr || (error && error.code === 'ENOENT' ? String(error.message) : ''),
        error: error ? String(error.message) : undefined,
        elapsedMs: Date.now() - started,
      });

    let child;
    if (process.platform === 'win32') {
      // 走 cmd.exe：zg.cmd 是个批处理垫片，shell:false 下不可执行。
      const line = [ZG_BIN, ...args].map(quoteArg).join(' ');
      child = spawn('cmd.exe', ['/d', '/s', '/c', line], {
        cwd,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
      });
    } else {
      child = spawn(`sh`, ['-c', [ZG_BIN, ...args].map(quoteArg).join(' ')], {
        cwd,
        timeout: timeoutMs,
      });
    }

    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', (err) => finish(1, err));
    child.on('close', (code) => finish(code === null ? 124 : code, null));
  });
}

// 可用性探测：zg 在不在、什么版本。install/probe 类只读动作都用它。
export async function probe() {
  const r = await runZg(['version'], { timeoutMs: 20_000 });
  // `zg version` 输出裸版本号（如 0.2.2）
  const version = r.ok ? (r.stdout.trim().split('\n')[0] || '').trim() : null;
  return {
    installed: r.ok,
    version: version || null,
    error: r.ok ? undefined : (r.stderr || r.error || `zg version 退出码 ${r.code}`),
  };
}

// 调用失败时的统一转换：把 zg 的 stderr 变成一条可展示的 EXTERNAL 错误。
export function assertZgOk(r, what) {
  if (r.ok) return r;
  const detail = (r.stderr || r.stdout || r.error || '').trim().split('\n').slice(0, 8).join('\n');
  throw external(`${what}失败（zg 退出码 ${r.code}）${detail ? '：\n' + detail : ''}`);
}

// ---- 输出解析 ----

// `zg status` 的三种形态（实测 0.2.2）：
//   ready：     ✔ Workspace index is ready        Coverage ####…#### 100%  11 / 11 files
//   需更新：    ! Workspace index needs an update Coverage ####…----  79%  11 / 14 files
//                 + Changes 3 added · 0 modified · 0 deleted
//   未配置：    ? Workspace index is not configured … Policy undecided … Next zg index
//
// 进度条是 `#` 与 `-` 混排（已覆盖 vs 待覆盖），字符类必须把它俩都吃进去——
// 只写 `#` 时 Coverage 会整条匹配失败，表现为「状态里覆盖度永远是 ?」。
export function parseStatus(stdout) {
  const text = String(stdout || '');
  const num = (re) => {
    const m = text.match(re);
    return m ? Number(String(m[1]).replace(/,/g, '')) : null;
  };
  const coverage = text.match(/Coverage\s+[^\d\n]*(\d+)%\s+(\d+)\s*\/\s*(\d+)\s+files/);
  const dims = text.match(/([\d,]+)\s+dimensions\s*(?:\u00b7|\u2022)?\s*(\w+)?/);
  const queue = text.match(/Queue\s+(\d+)\s+pending\s*\S*\s*(\d+)\s+failed/);
  const changes = text.match(
    /Changes\s+(\d+)\s+added\s*\S*\s*(\d+)\s+modified\s*\S*\s*(\d+)\s+deleted/
  );

  return {
    configured: !/index is not configured/i.test(text),
    ready: /index is ready/i.test(text),
    stale: /needs an update/i.test(text),
    root: (text.match(/^\s{2}([A-Za-z]:[\\/][^\s]*|\/[^\s]*)\s*$/m) || [])[1] || null,
    coveragePercent: coverage ? Number(coverage[1]) : null,
    files: coverage ? Number(coverage[2]) : null,
    filesTotal: coverage ? Number(coverage[3]) : null,
    entities: num(/Entities\s+(\d+)/),
    truncated: num(/Truncated\s+(\d+)/),
    pending: queue ? Number(queue[1]) : null,
    failed: queue ? Number(queue[2]) : null,
    changes: changes
      ? { added: Number(changes[1]), modified: Number(changes[2]), deleted: Number(changes[3]) }
      : null,
    embedding: dims
      ? {
          model: (text.match(/Embedding\s+(\S+)/) || [])[1] || null,
          dims: Number(dims[1].replace(/,/g, '')),
          metric: dims[2] || null,
        }
      : null,
    storage: (text.match(/Storage\s+(.+)$/m) || [])[1]?.trim() || null,
    next: (text.match(/Next\s+(.+)$/m) || [])[1]?.trim() || null,
  };
}

// `zg index` 的收尾统计（实测 0.2.2）：
//
//   files	3 scanned, 1 added, 0 modified, 0 retried, 2 unchanged, 0 deleted, 0 failed
//   entities	1
//   duration	11s (11307ms)
//
// 这行是「index 默认就是增量」的直接证据：`1 added` 与 `2 unchanged` 并列出现时，
// 说明只有新文件被嵌入、已有向量原样保留。解析出来给 CLI 与面板展示，
// 免得「跑了一次索引」到底是全量重算还是只补了增量，只能靠用户猜。
export function parseIndexSummary(stdout) {
  const text = String(stdout || '');
  const pick = (word) => {
    const m = text.match(new RegExp('([\\d,]+)\\s+' + word + '\\b'));
    return m ? Number(m[1].replace(/,/g, '')) : null;
  };
  const ent = text.match(/entities\s+([\d,]+)/i);
  const dur = text.match(/duration\s+([\d.]+)\s*(ms|s)\b/);

  return {
    scanned: pick('scanned'),
    added: pick('added'),
    modified: pick('modified'),
    changed: pick('changed'),
    unchanged: pick('unchanged'),
    deleted: pick('deleted'),
    failed: pick('failed'),
    entities: ent ? Number(ent[1].replace(/,/g, '')) : null,
    durationMs: dur ? Math.round(Number(dur[1]) * (dur[2] === 's' ? 1000 : 1)) : null,
  };
}

// `zg query` 的 agent markdown 形态（0.2.2 实测，--json 已不可用）：
//
//   query groups (1):
//   Q1 [primary]: 登录页为什么提示超时
//   hits: 3
//
//   #1 matchedBy=fts+vector notes/登录超时排查.md:1-2
//   1	---
//
//   #2 matchedBy=fts+vector notes/登录超时排查.md:6-15
//   heading: 登录超时排查记录
//   heading_level: 1
//   6	# 登录超时排查记录
//
//   results: served_from_current_index
//   background_refresh: idle (3/4)
//
// 解析要点：命中头是行首的 `#<n> matchedBy=`，而**片段正文里的 `#` 标题在行号
// 之后**（`6\t# xxx`），两者不会混淆——所以 HIT_RE 必须锚定行首。
//
// ---- 关于 score（多库合并排序的依据）----
//
// 加 `--trace` 后，命中头会多出一个 `score=` 字段（实测 0.2.2）：
//
//   #1 matchedBy=fts+vector score=0.0328 a.md:1-3
//
// 该值是 zg 的内部融合分（标准 RRF：`2/61 = 0.032787`、`1/61 ≈ 0.0164`），
// 由**排名**派生而非原始相似度，因此**跨 workspace / 跨索引可以相互比较**——
// 这正是「多个知识库一起检索」时能把命中排成一张统一列表的唯一依据。
//
// ⚠️ 陷阱：score 出现在 path 之前，若正则不显式吃掉它，`(.+)` 会贪婪地把
// `score=0.0328 ` 连同路径一起匹配进去，`hit.path` 静默变成 `"score=0.0328 a.md"`。
// 不报错、不崩，只是命中路径全错——所以 score 必须是**显式可选捕获组**。
const HIT_RE = /^#(\d+)\s+matchedBy=(\S+)\s+(?:score=([\d.eE+-]+)\s+)?(.+):(\d+)-(\d+)\s*$/;
const GROUP_RE = /^Q(\d+)\s+\[([^\]]+)\]:\s*(.*)$/;
const SNIPPET_RE = /^(\d+)\t(.*)$/;

export function parseQuery(stdout) {
  const groups = [];
  const hits = [];
  const notes = [];
  let cur = null;

  for (const raw of String(stdout || '').split(/\r?\n/)) {
    // 只剥 \r，**不能 trimEnd**：空的源码行在输出里是 `7\t`，字符被吃掉后
    // 这一行就不再匹配片段规则，片段中的空行会整段丢失（笔记读起来连成一片）。
    const line = raw.replace(/\r$/, '');

    const hit = line.match(HIT_RE);
    if (hit) {
      const score = hit[3] === undefined ? NaN : Number(hit[3]);
      cur = {
        n: Number(hit[1]),
        matchedBy: hit[2].split('+').filter(Boolean),
        // 没加 --trace 时为 null（不是 0）：0 会被上层当成「最差命中」，
        // 而 null 明确表示「本次没取到分数」。
        score: Number.isFinite(score) ? score : null,
        path: hit[4],
        start: Number(hit[5]),
        end: Number(hit[6]),
        heading: null,
        headingLevel: null,
        snippet: '',
      };
      hits.push(cur);
      continue;
    }

    const group = line.match(GROUP_RE);
    if (group) {
      cur = null;
      groups.push({
        n: Number(group[1]),
        flag: group[2],
        query: group[3].trim(),
        hits: null,
      });
      continue;
    }

    const hitsCount = line.match(/^hits:\s*(\d+)\s*$/);
    if (hitsCount) {
      if (groups.length) groups[groups.length - 1].hits = Number(hitsCount[1]);
      cur = null;
      continue;
    }

    if (cur) {
      const level = line.match(/^heading_level:\s*(\d+)\s*$/);
      if (level) {
        cur.headingLevel = Number(level[1]);
        continue;
      }
      const heading = line.match(/^heading:\s*(.*)$/);
      if (heading) {
        cur.heading = heading[1].trim() || null;
        continue;
      }
      const snip = line.match(SNIPPET_RE);
      if (snip) {
        cur.snippet += (cur.snippet ? '\n' : '') + snip[2];
        continue;
      }
    }

    // 尾注（results / background_refresh / status …）：保持原文，让上层能透传给 agent
    const note = line.match(/^(results|background_refresh|status|[a-z_]*warning):\s*(.*)$/i);
    if (note) notes.push(line.trim());
  }

  return {
    groups,
    hits,
    notes,
    declaredGroups: (String(stdout || '').match(/^query groups \((\d+)\)/m) || [])[1]
      ? Number((String(stdout || '').match(/^query groups \((\d+)\)/m) || [])[1])
      : null,
  };
}

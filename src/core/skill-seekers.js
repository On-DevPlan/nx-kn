// 外部抓取引擎 Skill Seekers 的进程驱动。
//
// 分层位置：core（零业务语义）。只回答两件事——
//   1. 怎么把 skill-seekers 跑起来（本机装了就直接用；没有就经 uvx 免安装拉起）
//   2. 它到底跑成没有（沿用 core/zg.js 的纪律：**永不抛**，只回 { ok, code, stdout, stderr }）
//
// ---- 为什么不复用 zg.js 的 cmd.exe 垫片 ----
// zg 在 Windows 上是 `.cmd`，非 shell 下不可执行，只能经 `cmd.exe /d /s /c`；而 cmd 会把
// `%VAR%` 展开、把 `"` 当引号边界，所以 zg.js 宁可当场拒绝含 `"` / `%` 的参数。
// **但 URL 里天然带 `%`**（`%20`、`%E4%B8%AD` …），这条禁令在抓取场景直接不成立。
//
// 因此这里改走 `spawn(bin, argsArray)`：参数以**数组**传递，不经过任何 shell，
// 空格与 `%` 都不会被二次解释，也不需要任何引号规则。代价是 Windows 下只能执行
// 真正的 `.exe` —— 而 pip 装的 skill-seekers 与 uv 装的 uvx 恰好都是 `.exe`，
// 「只有 .cmd 垫片」这种情形不存在，故不为它留分支。
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import { join } from 'node:path';

// 逃生舱：显式指定怎么调用 skill-seekers。
// 值是**单个可执行文件路径**，或 JSON 数组（如 `["uvx","--from","skill-seekers","skill-seekers"]`）。
// 存在的理由有二：(1) 用户已经把 skill-seekers 装在某个 venv 里，路径不在 PATH 上；
// (2) 测试要能在**完全离线**的前提下驱动整条链路——指向一个假脚本即可。
export const SKILL_SEEKERS_ENV = 'NX_KN_SKILL_SEEKERS_CMD';

// 抓一个站可能很久（Skill Seekers 内部会遍历、分类、可选增强）。
// 给 30 分钟：比任何一次合理抓取都宽，又不至于挂死到天荒地老。
export const SKILL_SEEKERS_TIMEOUT_MS = 30 * 60 * 1000;

// stdout/stderr 上限：防止一个话痨的增强过程把内存吃光。
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

// 候选调用方式，按优先级排列：
//   1. 环境变量显式指定（唯一候选，不再回退——用户说了算）
//   2. PATH 上的 skill-seekers（用户自己装的）
//   3. uvx 免安装拉起（不需要用户预装，代价是首次要联网拉包）
export function candidateCommands(env = process.env) {
  const raw = env && env[SKILL_SEEKERS_ENV];
  if (raw && String(raw).trim()) {
    const v = String(raw).trim();
    if (v.startsWith('[')) {
      try {
        const arr = JSON.parse(v);
        if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === 'string')) {
          const [bin, ...args] = arr;
          return [{ bin, args, source: 'env' }];
        }
      } catch {
        /* JSON 坏了就按「单路径」处理，不因此报错 */
      }
    }
    return [{ bin: v, args: [], source: 'env' }];
  }
  return [
    { bin: 'skill-seekers', args: [], source: 'path' },
    { bin: 'uvx', args: ['--from', 'skill-seekers', 'skill-seekers'], source: 'uvx' },
  ];
}

// 候选的人类可读描述（错误信息里要能说清「我试过哪些、都怎么试的」）。
export function describeCandidate(c) {
  return c.args.length ? `${c.bin} ${c.args.join(' ')}` : c.bin;
}

/**
 * 跑一次 skill-seekers。**永不抛**——返回
 * `{ ok, code, stdout, stderr, error, bin, via, tried }`，由调用方决定
 * 「这是业务结果还是失败」。
 *
 * 候选按顺序尝试，且**只在「起不来」时才换下一个**（ENOENT / EACCES 等 spawn error）。
 * 一旦进程真的跑起来并返回了退出码，就是最终结果——哪怕它非 0，
 * 那也是 skill-seekers 的业务失败（如「抓不到这个站」），换 uvx 重跑一遍毫无意义。
 *
 * @param {string[]} args  传给 skill-seekers 的参数（不含程序名）
 */
export function runSkillSeekers(args, { cwd, timeoutMs = SKILL_SEEKERS_TIMEOUT_MS, env = process.env } = {}) {
  const candidates = candidateCommands(env);

  return new Promise((resolve) => {
    const tried = [];
    let idx = 0;

    const next = () => {
      const c = candidates[idx++];
      if (!c) {
        resolve({
          ok: false,
          code: 127,
          stdout: '',
          stderr: '',
          bin: null,
          via: null,
          tried,
          error:
            `找不到 skill-seekers（已尝试：${tried.join(' / ')}）\n` +
            `  装它：pip install skill-seekers（需 Python 3.10+），或确保 uv/uvx 可用\n` +
            `  换引擎：--engine node（用内置的纯 Node 抓取，不需要 Python）\n` +
            `  指定命令：环境变量 ${SKILL_SEEKERS_ENV}`,
        });
        return;
      }

      const started = Date.now();
      let stdout = '';
      let stderr = '';
      let overLimit = false;
      tried.push(describeCandidate(c));

      // finish 必须在 try 之前定义：catch 分支要用它，而 const 有暂时性死区
      // （在声明前引用会直接抛 ReferenceError，把「换个候选重试」变成「整个崩掉」）。
      //
      // done 闸门也是必需的：spawn 失败时 Node 可能先后发出 'error' 与 'close'，
      // 两个都跑到这里就会「后一次覆盖前一次」——最坏情况是把已经换候选成功的
      // 结果又被覆盖成第一个候选的失败。
      let done = false;
      const finish = (code, error) => {
        if (done) return;
        done = true;
        clearTimer();
        resolve({
          ok: !error && code === 0,
          code: error ? (error.code ?? 1) : code,
          stdout,
          stderr: stderr || (error ? String(error.message || error) : ''),
          bin: c.bin,
          via: c.source,
          tried,
          error: error ? String(error.message || error) : undefined,
          elapsedMs: Date.now() - started,
        });
      };

      let child;
      try {
        child = spawn(c.bin, [...c.args, ...args], {
          cwd,
          windowsHide: true,
          // 不设 shell：参数以数组直达子进程，URL 里的 % 与空格都不必转义。
          shell: false,
        });
      } catch {
        // spawn 的同步抛（典型是 Windows 上把一个 `.cmd` 当可执行文件）：换下一个候选。
        next();
        return;
      }

      // 超时自己管，**不用 spawn 的 timeout 选项**：实测（Node 22 / Windows）该选项在
      // ENOENT 路径上会把事件循环钉住到超时才放——error 已触发、promise 已 resolve，
      // 进程却要多活 timeoutMs（默认 30 分钟）。这曾让整个单测进程挂 30 分钟。
      // unref 保证它绝不独自持有事件循环；kill 照常生效。
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              try {
                child.kill();
              } catch {
                /* 已经退了 */
              }
            }, timeoutMs)
          : null;
      timer?.unref?.();
      const clearTimer = () => {
        if (timer) clearTimeout(timer);
      };

      const take = (buf, which) => {
        if (which === 'out') stdout += buf;
        else stderr += buf;
        if (stdout.length + stderr.length > MAX_OUTPUT_BYTES) {
          overLimit = true;
          try {
            child.kill();
          } catch {
            /* 已经退了 */
          }
        }
      };

      child.stdout?.on('data', (b) => take(String(b), 'out'));
      child.stderr?.on('data', (b) => take(String(b), 'err'));
      child.on('error', (err) => {
        // 只有「起不来」才换候选（ENOENT = 没这个命令，EINVAL = Windows 上的 .cmd）。
        // 进程真的跑起来之后的失败是业务失败，换 uvx 重跑一遍毫无意义。
        if (err && (err.code === 'ENOENT' || err.code === 'EACCES' || err.code === 'EINVAL')) {
          if (done) return;
          done = true;
          clearTimer();
          next();
          return;
        }
        finish(1, err);
      });
      child.on('close', (code) => {
        if (overLimit) {
          if (done) return;
          done = true;
          clearTimer();
          resolve({
            ok: false,
            code: 1,
            stdout,
            stderr,
            bin: c.bin,
            via: c.source,
            tried,
            error: `skill-seekers 输出超过 ${MAX_OUTPUT_BYTES} 字节，已中止`,
          });
          return;
        }
        finish(code === null ? 124 : code, null);
      });
    };

    next();
  });
}

/**
 * 递归枚举目录下的全部 `.md`（按路径排序，保证两次运行顺序一致）。
 * 只读，不抛——目录不存在时回空数组。
 */
export async function listMarkdownFiles(dir) {
  const out = [];
  const walk = async (d) => {
    let entries;
    try {
      entries = await fsp.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p);
    }
  };
  await walk(dir);
  return out;
}

/**
 * 可用性探测：**只在真要抓取时用**，不要放进任何读命令。
 *
 * 理由：uvx 这条路首次调用会联网拉约 50 MB 的依赖。`crawl list` 这种读命令
 * 若顺手探一下，用户会看到「只是列个表，怎么卡了两分钟」。
 */
export async function probeSkillSeekers({ env = process.env } = {}) {
  const r = await runSkillSeekers(['--help'], { timeoutMs: 120_000, env });
  return {
    available: r.ok,
    via: r.via,
    bin: r.bin,
    tried: r.tried,
    error: r.ok ? undefined : r.error || r.stderr || `退出码 ${r.code}`,
  };
}

// 外部 obsidian CLI 的进程驱动：探测 + 调用未解析链接列表。
//
// 分层位置：core（零业务语义）。只回答两件事——
//   1. 「这台机器上有没有可用的 obsidian CLI」（没有就用内置解析）
//   2. 「跑它拿到未解析链接列表」
//
// 沿用 core/skill-seekers.js 的纪律：**永不抛**，只回 { ok, ... }，由调用方决定
// 「这是业务结果还是失败」。
//
// ---- 为什么不能把它当硬依赖 ----
//
// 本机实测（2026-10-21，`D:\apps\app\dev\obsidian\Obsidian.exe`）：
//
//   $ obsidian unresolved verbose format=json
//   Your Obsidian installer is out of date. Please download the latest installer
//   which includes better CLI support: https://obsidian.md/download
//   No unresolved links found.
//
// **「No unresolved links found.」这句话是假的**——那个库里明明有红链。
// 旧 postcheck.py 正是信了它，于是把「有红链」报成「0 个未解析双链」，
// 而且不报错、不提示（退出码 0）。这是比「工具缺失」更糟的失败：
// 缺失至少会报错，**撒谎的答案会让整个校验流程失去意义**。
//
// 所以这里的纪律是：
//   1. 命令行**起得来**不等于**答案可信**——要认输出里的「不受支持」标记
//   2. 拿不到可信答案就回退内置解析，并把原因写进 note（别悄悄换答案）
//   3. 图形界面本体在**没运行**时不去调它——那会把用户的 Obsidian 启动起来
//
// 定位是「**有就用，没有就回退**」，绝不因为它不可用而让整条链路失败。
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, delimiter } from 'node:path';

// 逃生舱：显式指定怎么调用 obsidian CLI。
// 值是单个可执行文件路径，或 JSON 数组（["obsidian","--some-flag"]）。
export const OBSIDIAN_CLI_ENV = 'NX_KN_OBSIDIAN_CMD';

// 关闭开关：设成 0 / false / no 时**只用内置解析**，完全不碰外部命令。
export const OBSIDIAN_CLI_OFF_ENV = 'NX_KN_OBSIDIAN_CLI';

// 真扫一次未解析链接的超时（vault 大时 Obsidian 内部要建索引）。
const SCAN_TIMEOUT_MS = 120_000;

const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export function cliDisabled(env = process.env) {
  const v = env && env[OBSIDIAN_CLI_OFF_ENV];
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
}

// 候选调用方式，按优先级：
//   1. 环境变量显式指定（唯一候选，不再回退——用户说了算）
//   2. PATH 上的 obsidian
export function candidateCommands(env = process.env) {
  const raw = env && env[OBSIDIAN_CLI_ENV];
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
  return [{ bin: 'obsidian', args: [], source: 'path' }];
}

// 在 PATH 上找可执行文件（纯 JS，不起进程）。
// 返回**磁盘上的真实文件名**（而不是我们拼出来的路径）——判断「是不是 GUI 本体」
// 必须看真实文件名：Windows 上文件系统不区分大小写，我们拼出来的
// 'D:\\apps\\...\\obsidian.EXE' 看着像 CLI，磁盘上却叫 'Obsidian.exe'（图形界面）。
export function resolveOnPath(bin, env = process.env) {
  if (bin.includes('/') || bin.includes('\\')) {
    try {
      return { path: bin, realName: basename(bin) };
    } catch {
      return null;
    }
  }
  const pathEnv = env.PATH || env.Path || env.path || '';
  const dirs = pathEnv.split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : [''];
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      try {
        if (!statSync(p).isFile()) continue;
      } catch {
        continue;
      }
      // 目录里可能还有别的同名变体（Obsidian.exe / obsidian.exe）——按真实名字取
      let realName = basename(p);
      try {
        const hit = readdirSync(d).find((n) => n.toLowerCase() === (bin + ext).toLowerCase());
        if (hit) realName = hit;
      } catch {
        /* 读不到目录就退回拼出来的名字 */
      }
      return { path: p, realName };
    }
  }
  return null;
}

// GUI 本体的文件名（首字母大写）。CLI 的转发器是小写 obsidian.exe / obsidian.cmd。
//
// 为什么要在意这个：**GUI 本体也是命令行的入口**——Obsidian 1.13.x 的
// Obsidian.exe 接受 `obsidian unresolved …` 这样的参数（但它不是真正的 CLI：
// 本机实测它对任何 vault 都回 "No unresolved links found."，哪怕库里满是红链）。
// 所以「命令起得来」**不等于**「答案是对的」——判定见下面的可用性标记。
const GUI_BASENAME = 'Obsidian.exe';

// 识别「这个二进制其实不是可用的 CLI」的标记。
// 本机实测：PATH 上的 obsidian 是图形界面本体，它会打印
//   "Your Obsidian installer is out of date. Please download the latest installer
//    which includes better CLI support: …"
// 然后回一句 "No unresolved links found."——**无论库里有没有红链**。
// 旧 postcheck.py 正是信了这句话，于是把「有红链」报成「0 个未解析双链」。
const UNSUPPORTED_MARKERS = ['better CLI support', 'installer is out of date'];

export function looksLikeGui(resolved) {
  if (!resolved) return false;
  return resolved.realName === GUI_BASENAME;
}

// 图形界面有没有在跑（Windows）。不在跑就别去调它——那会把用户的 Obsidian
// 启动起来，而「扫个红链」不该有这种副作用。
export async function obsidianRunning() {
  if (process.platform !== 'win32') return true; // 其他平台的 CLI 通常是独立转发器
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  try {
    const { stdout } = await run('tasklist', ['/FI', 'IMAGENAME eq Obsidian.exe', '/NH'], { timeoutMs: 10_000 });
    return /Obsidian\.exe/i.test(stdout);
  } catch {
    return true; // 查不到就当它在跑（宁可用 CLI，也不擅自跳过）
  }
}

/**
 * 探测 obsidian CLI 是否**可用**（而不只是「起没起得来」）。
 *
 * **进程内缓存一次**——探测要起进程，每次扫描都探一遍是白花开销。
 *
 * 三种不可用：
 * 1. 用户用环境变量关掉了
 * 2. PATH 上根本没有这个命令
 * 3. PATH 上的是图形界面本体、而 Obsidian **没在运行**——这时去调它等于
 *    把用户的 Obsidian 启动起来（扫个红链不该有这种副作用）
 */
let probeCache = null;

export async function probeObsidianCli({ env = process.env, force = false } = {}) {
  if (probeCache && !force) return probeCache;

  if (cliDisabled(env)) {
    probeCache = { available: false, reason: `环境变量 ${OBSIDIAN_CLI_OFF_ENV} 已关闭外部 CLI` };
    return probeCache;
  }

  const c = candidateCommands(env)[0];
  const resolved = resolveOnPath(c.bin, env);
  if (!resolved) {
    probeCache = { available: false, reason: `PATH 上没有 ${c.bin} 命令` };
    return probeCache;
  }

  if (looksLikeGui(resolved) && !(await obsidianRunning())) {
    probeCache = {
      available: false,
      bin: resolved.path,
      reason: `${resolved.realName} 是 Obsidian 图形界面本体且当前没在运行 —— 调它会把 Obsidian 启动起来，故跳过`,
    };
    return probeCache;
  }

  probeCache = { available: true, bin: resolved.path };
  return probeCache;
}

/**
 * 跑 `obsidian unresolved verbose format=json`，返回未解析链接数组。
 *
 * 返回 `{ ok, items, error }`：
 * - ok=true  → items 是数组（可能为空）
 * - ok=false → 调用失败或输出里找不到 JSON 数组（调用方应回退内置解析）
 *
 * JSON 数组的截取方式照搬 Python 版：stdout+stderr 拼起来，取**首个 `[`** 到
 * **末个 `]`** 之间——因为 CLI 会在 stdout 前后夹带人类可读的行。
 */
export async function runObsidianUnresolved(vault, { env = process.env } = {}) {
  const c = candidateCommands(env)[0];
  const r = await runProcess(c.bin, [...c.args, 'unresolved', 'verbose', 'format=json'], {
    cwd: vault,
    timeoutMs: SCAN_TIMEOUT_MS,
    env,
  });

  const blob = `${r.stdout}\n${r.stderr}`;

  // 「这个二进制其实不是可用的 CLI」——本机实测：图形界面本体会打印
  // "installer is out of date … better CLI support"，然后对任何 vault 都回
  // "No unresolved links found."。**这句话不能当答案**——信它就会把
  // 「有红链」报成「0 个未解析双链」（旧 postcheck.py 就是这么错的）。
  for (const marker of UNSUPPORTED_MARKERS) {
    if (blob.includes(marker)) {
      return {
        ok: false,
        items: [],
        error: `obsidian 命令行不受支持（${marker}）——它的回答不可信`,
      };
    }
  }

  if (!r.ok) {
    return { ok: false, items: [], error: `obsidian CLI 退出码 ${r.code}${r.stderr ? '：' + r.stderr.trim() : ''}` };
  }

  const start = blob.indexOf('[');
  const end = blob.lastIndexOf(']');
  if (start < 0 || end <= start) {
    if (blob.includes('No unresolved links found.')) return { ok: true, items: [] };
    return { ok: false, items: [], error: 'obsidian CLI 输出里没有 JSON 数组' };
  }
  try {
    const items = JSON.parse(blob.slice(start, end + 1));
    if (!Array.isArray(items)) return { ok: false, items: [], error: 'obsidian CLI 输出不是数组' };
    return { ok: true, items };
  } catch (e) {
    return { ok: false, items: [], error: `obsidian CLI 输出解析失败：${(e && e.message) || e}` };
  }
}

/**
 * 起一个进程跑命令，**永不抛**。
 *
 * 参数以数组传给子进程，不经过 shell——Windows 上 `cmd` 会把 `%VAR%` 展开、
 * 把 `"` 当引号边界，参数里有空格或引号就会被二次解释。
 *
 * 超时自己管（不用 spawn 的 timeout 选项）：该选项在 ENOENT 路径上会把事件循环
 * 钉住到超时才放，探一个不存在的命令会把整个进程挂住。
 */
function runProcess(bin, args, { cwd, timeoutMs, env = process.env } = {}) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let overLimit = false;
    let done = false;

    const finish = (code, error) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: !error && code === 0,
        code: error ? (error.code ?? 1) : code,
        stdout,
        stderr: stderr || (error ? String(error.message || error) : ''),
        error: error ? String(error.message || error) : undefined,
      });
    };

    let child;
    try {
      child = spawn(bin, args, { cwd, windowsHide: true, shell: false, env });
    } catch (err) {
      finish(1, err);
      return;
    }

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
    child.on('error', (err) => finish(1, err));
    child.on('close', (code) => {
      if (overLimit) {
        finish(1, new Error(`输出超过 ${MAX_OUTPUT_BYTES} 字节，已中止`));
        return;
      }
      finish(code === null ? 124 : code, null);
    });
  });
}

// 仅供测试：清掉探测缓存。
export function resetObsidianCliProbe() {
  probeCache = null;
}

// 供测试：环境变量里的命令是否存在（不真跑）。
export function commandExists(bin, env = process.env) {
  const r = resolveOnPath(bin, env);
  return !!(r && existsSync(r.path));
}

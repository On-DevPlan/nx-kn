// HTTP 路由表：由 action.http 编译而来，与 CLI 同源。
//
// 这里没有手写路由 —— 每条路由都来自某个模块的 action 声明，
// 所以「面板上有按钮、CLI 里没命令」在结构上不可能发生。
//
// 传文件（下载 zip / 拖拽上传 zip）也走这条规则，只是多两个**显式**能力开关，
// 由 action 自己声明，不靠 content-type 猜：
//   - `httpFile: true`      响应可能是文件：run 返回 `{ download: { buffer, filename } }` 时
//                           直接写字节流（否则照旧 JSON）。
//   - `httpUpload: { maxBytes }` 请求体是原始字节（浏览器拿不到本地路径，只能交内容）：
//                           落成临时文件 → ctx.file = 该路径 → run 结束即删。
//                           于是导入逻辑只有一份（认路径），上传只是「怎么把字节变成路径」。
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import fsp from 'node:fs/promises';
import { ACTIONS } from './registry.js';
import { compileRoute, applySpec } from './spec.js';
import { toErrorPayload, httpStatusOf, CODES, badInput } from '../core/errors/index.js';

// 逐段比较两条模式，决定谁该先匹配：**字面量段优先于参数段**，段数多的优先。
//
// 为什么要排序而不是按声明顺序：本仓目前全是字面量路由，但只要有人加了
// `GET /api/kb/:name`，它就会与 `GET /api/kb/status` 同时匹配 `/api/kb/status`，
// 谁先声明谁赢。调整一次 actions 顺序，具体的那条就被参数那条抢走——
// 这种 bug 只在运行时、且只在特定路径上出现，极难排查。
//
// 排序后，声明顺序不再影响匹配结果。
//
// 历史上的坑：只按「同位置字面量优先」判定，会让 `/api/x/status` 与
// `/api/x/:name` **平局**（都在第 3 段，a 是字面量 b 是参数，按本应字面量胜出，
// 但当数组长度正好相同时，sort 把后面声明的放前面——而 `:name` 这条通常声明在
// status 之后，于是 `/api/x/list` 落到 `:name` 上，把 `list` 当变量名去查了）。
//
// 正确比较：算"前 N 段里**字面量段**的总个数"，多者优先；同字数时
// 按"从左到右遇到的第一处分歧段"——字面量胜出。
function routeSpecificity([, pattern]) {
  return pattern.split('/').filter(Boolean);
}

function compareRoutes(a, b) {
  const pa = routeSpecificity(a.action.http);
  const pb = routeSpecificity(b.action.http);
  const litA = pa.filter((s) => !s.startsWith(':')).length;
  const litB = pb.filter((s) => !s.startsWith(':')).length;
  if (litA !== litB) return litB - litA; // 字面量段越多越具体
  if (pa.length !== pb.length) return pb.length - pa.length;
  for (let i = 0; i < pa.length; i++) {
    const litA2 = !pa[i].startsWith(':');
    const litB2 = !pb[i].startsWith(':');
    if (litA2 !== litB2) return litA2 ? -1 : 1;
  }
  return 0;
}

const ROUTES = ACTIONS.filter((a) => a.http)
  .map((action) => ({ action, route: compileRoute(action) }))
  .sort(compareRoutes);

export function sendJson(res, status, obj) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

// 下载文件名可能含中文（项目名就是中文的）：
//   filename=       给老客户端看的 ASCII 兜底（非 ASCII 一律换成 _）
//   filename*=      按 RFC 5987 给真名，浏览器优先用它
// 只写 filename= 会把中文变成乱码或直接丢掉扩展名。
function contentDisposition(filename) {
  const name = String(filename || 'download.bin');
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function sendDownload(res, { buffer, filename, contentType }) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  res.writeHead(200, {
    'content-type': contentType || 'application/octet-stream',
    'content-length': String(buf.length),
    'content-disposition': contentDisposition(filename),
    'cache-control': 'no-store',
  });
  res.end(buf);
}

const DEFAULT_UPLOAD_MAX = 256 * 1024 * 1024;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// 把上传的字节落成临时文件，返回 { file, uploadName }。
// 先量 content-length：明显超限的请求不必真的读进内存再报错。
async function readUpload(req, action, tmpFiles) {
  const max = Number(action.httpUpload && action.httpUpload.maxBytes) || DEFAULT_UPLOAD_MAX;
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > max) {
    throw badInput(`上传文件过大：${fmtBytes(declared)}（上限 ${fmtBytes(max)}）`);
  }

  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) throw badInput(`上传文件过大：超过上限 ${fmtBytes(max)}`);
    chunks.push(c);
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw badInput('上传的文件是空的');

  const file = join(tmpdir(), `kn-upload-${Date.now()}-${randomBytes(4).toString('hex')}.zip`);
  await fsp.writeFile(file, buf);
  tmpFiles.push(file);

  // 原始文件名只用于**显示**（结果里回显的是它，而不是机器上看不见的临时路径）。
  // 过一遍 basename：有的客户端会把整个路径塞进来。
  const rawName = req.headers['x-kn-filename'];
  let uploadName;
  if (rawName) {
    try {
      uploadName = basename(decodeURIComponent(String(rawName)));
    } catch {
      uploadName = basename(String(rawName));
    }
  }
  return { file, uploadName };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 4 * 1024 * 1024) throw badInput('请求体过大（上限 4MB）');
    chunks.push(c);
  }
  // 空 body 是合法的（很多 POST 不带参数）——与「body 坏了」是两回事，别混。
  if (!chunks.length) return {};
  // 坏 JSON **必须报错**，不能当成空 body。
  //
  // 曾经的写法是 `.catch(() => ({}))`：解析失败一律降级成空对象，于是
  // 「请求体被截断 / 编码坏了」变成了「参数为空」——action 收到空 patch，
  // 返回 skipped，HTTP 200，界面上弹「已保存」，**实际什么都没写**。
  // 这类「静默失效」比直接报错难查得多：用户看到的是成功的提示。
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) {
    throw badInput(`请求体不是合法 JSON: ${(e && e.message) || e}`);
  }
}

// 跨站防护。服务虽然只绑 127.0.0.1，但用户浏览器里的任意页面都能向它发起请求——
// 少了这道校验，一个恶意网页就能 POST /api/kb/index 或 /api/crawl/run。
// 浏览器发跨域请求必带 Origin，非浏览器客户端（curl / agent / 测试）不带，故放行。
function originAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const h = new URL(origin).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

export async function handleApi(req, res, url) {
  const method = (req.method || 'GET').toUpperCase();

  for (const { action, route } of ROUTES) {
    if (route.method !== method) continue;
    const m = route.regex.exec(url.pathname);
    if (!m) continue;

    if (method !== 'GET' && method !== 'HEAD' && !originAllowed(req)) {
      sendJson(res, 403, {
        ok: false,
        error: '跨站请求被拒绝（面板仅接受本机来源）',
        code: CODES.BLOCKED,
      });
      return;
    }

    try {
      const raw = {};
      route.keys.forEach((k, i) => {
        raw[k] = decodeURIComponent(m[i + 1]);
      });
      // 上传落下的临时文件：run 跑完（无论成败）就删，绝不留到下一轮
      const tmpFiles = [];
      try {
        const ctype = String(req.headers['content-type'] || '').toLowerCase();
        if (method === 'GET' || method === 'HEAD') {
          for (const [k, v] of url.searchParams) raw[k] = v;
        } else if (action.httpUpload && ctype && !ctype.includes('application/json')) {
          // 原始字节上传：body 是文件本身，其余参数只能走 query string。
          for (const [k, v] of url.searchParams) raw[k] = v;
          Object.assign(raw, await readUpload(req, action, tmpFiles));
        } else {
          // 解析失败要冒出去（400），不能降级成空 body —— 见 readBody 的注释。
          Object.assign(raw, await readBody(req));
        }
        const data = await action.run(applySpec(action, raw), { transport: 'http' });
        if (action.httpFile && data && data.download) {
          sendDownload(res, data.download);
        } else {
          sendJson(res, 200, { ok: true, data });
        }
      } finally {
        for (const f of tmpFiles) await fsp.unlink(f).catch(() => {});
      }
    } catch (err) {
      // 错误码 → HTTP 状态只在这一处映射（core/errors/index.js 提供表）
      const p = toErrorPayload(err);
      const payload = { ok: false, error: p.message, code: p.code };
      if (p.details !== undefined) payload.details = p.details;
      sendJson(res, httpStatusOf(p.code), payload);
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: '接口不存在: ' + method + ' ' + url.pathname });
}

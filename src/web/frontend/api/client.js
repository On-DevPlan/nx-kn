// API 客户端：全部面板操作走 /api，与 CLI 共享同一份 action 声明。
//
// 响应包约定 { ok: true, data } / { ok: false, error, code }。
// 失败时抛 Error 并带上 .code —— 调用方可据此区分「业务冲突」与「参数错误」，
// 而不是像改造前那样只能对错误文案做字符串匹配。
const DEFAULT_TIMEOUT_MS = 30000;

export async function api(path, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  try {
    const res = await fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      signal: ctrl.signal,
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!json.ok) {
      const err = new Error(json.error || '请求失败');
      err.code = json.code;
      err.details = json.details;
      throw err;
    }
    return json.data;
  } catch (e) {
    // AbortError 的原生文案是「The operation was aborted」，对用户没有意义
    if (e && e.name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 从 content-disposition 里取文件名：优先 RFC 5987 的 filename*（中文名就靠它），
// 退回 ASCII 的 filename="..."。两个都没有就给个中性名字。
export function filenameFromDisposition(header, fallback = 'download.zip') {
  const s = String(header || '');
  const star = /filename\*=UTF-8''([^;]+)/i.exec(s);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      /* 编码坏了就走下面的兜底 */
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(s);
  return plain ? plain[1].trim() : fallback;
}

// 文件下载：导出要带项目名，只能 POST（参数进 body），所以不能用一个 <a href> 跳过去。
// 拿到 blob 再交给浏览器保存——这也是唯一能读到失败原因（JSON 错误体）的写法：
// 直接跳转的话，出错时用户看到的是一页 JSON，面板还留在原地不知道发生了什么。
export async function apiDownload(path, body = {}, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      let code;
      try {
        const json = await res.json();
        msg = json.error || msg;
        code = json.code;
      } catch {
        /* 非 JSON 错误体：保留状态码文案 */
      }
      const err = new Error(msg);
      err.code = code;
      throw err;
    }
    const blob = await res.blob();
    return {
      blob,
      filename: filenameFromDisposition(res.headers.get('content-disposition'), 'kn-export.zip'),
      bytes: blob.size,
    };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 文件上传：浏览器拿不到本地路径，只能把字节交上去。
// 参数走 query string（因为 body 整个让给文件本身），文件名放头部只用于回显。
export async function apiUpload(path, file, params = {}, opts = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    qs.set(k, v === true ? '1' : String(v));
  }
  const url = qs.toString() ? `${path}?${qs}` : path;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/zip',
        'x-kn-filename': encodeURIComponent(file.name || 'upload.zip'),
      },
      body: file,
      signal: ctrl.signal,
    });
    let json;
    try {
      json = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}`);
    }
    if (!json.ok) {
      const err = new Error(json.error || '请求失败');
      err.code = json.code;
      throw err;
    }
    return json.data;
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('请求超时（本地服务无响应）');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 把 blob 交给浏览器「另存为」。同样不能在拿到 blob 后直接丢掉：objectURL 要等点击后再回收。
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

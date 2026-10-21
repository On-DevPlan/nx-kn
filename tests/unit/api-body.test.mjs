// HTTP 层的请求体处理：空 body 与坏 body 是**两件事**，不能混。
//
// 背景（本机实测）：POST 传了一段坏 JSON（被截断 / 转义坏了），
// 旧写法 `.catch(() => ({}))` 把解析失败降级成空对象——action 收到空参数，
// 返回 skipped，HTTP 200，界面上弹「已保存」，**实际什么都没写**。
//
// 这类「静默失效」比直接报错难查得多：用户看到的是成功提示。
// 所以：空 body 合法（很多 POST 不带参数），坏 body 必须 400。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleApi } from '../../src/runtime/api.js';

// 一个够用的假 req：async iterable（body）+ method + headers。
function fakeReq(method, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')];
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

// 一个够用的假 res：把状态码与响应体记下来。
function fakeRes() {
  const out = { status: null, payload: null };
  return {
    writeHead(status) {
      out.status = status;
    },
    end(text) {
      out.payload = JSON.parse(text);
    },
    out,
  };
}

const URL_OBSIDIAN = new URL('http://127.0.0.1:7881/api/obsidian');

test('坏 JSON body → 400 INVALID_INPUT（不是「空参数 + 200」）', async () => {
  const res = fakeRes();
  await handleApi(fakeReq('POST', '{"vault":'), res, URL_OBSIDIAN);
  assert.equal(res.out.status, 400);
  assert.equal(res.out.payload.ok, false);
  assert.equal(res.out.payload.code, 'INVALID_INPUT');
  assert.match(res.out.payload.error, /不是合法 JSON/);
});

test('空 body → 正常走「没有要写的键」（200 + skipped），不是错误', async () => {
  const res = fakeRes();
  await handleApi(fakeReq('POST', undefined), res, URL_OBSIDIAN);
  assert.equal(res.out.status, 200);
  assert.equal(res.out.payload.ok, true);
  assert.equal(res.out.payload.data.skipped, true);
});

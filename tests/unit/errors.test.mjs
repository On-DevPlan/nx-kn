// 错误契约的单测：**失败抛 NxError，code 必须真的传得出去**。
//
// 为什么值得单独钉住：`toErrorPayload` 只对 `instanceof NxError` 读 code，
// 非 NxError 一律归成 INTERNAL。于是 `new Error(...)` 之后手动赋 `err.code = 'INVALID_INPUT'`
// 这种写法**看起来对、实际无效**——CLI 的 code 字段与 HTTP 的状态码会一起变错
// （400 变 500），而这个错误是静默的：message 文本照旧带「用法:」，
// 靠字符串匹配的消费方完全察觉不到。本仓历史上真有过 5 处这种写法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODES,
  NxError,
  badInput,
  blocked,
  conflict,
  exitCodeOf,
  external,
  httpStatusOf,
  notFound,
  specError,
  toErrorPayload,
} from '../../src/core/errors/index.js';

test('构造器产出的都是 NxError，且 code 就是指定的那个', () => {
  const cases = [
    [badInput('x'), CODES.INVALID_INPUT],
    [notFound('x'), CODES.NOT_FOUND],
    [conflict('x'), CODES.CONFLICT],
    [blocked('x'), CODES.BLOCKED],
    [external('x'), CODES.EXTERNAL],
    [specError('x'), CODES.SPEC_ERROR],
  ];
  for (const [err, code] of cases) {
    assert.ok(err instanceof NxError, `${code} 应由 NxError 构造`);
    assert.equal(err.code, code);
    assert.equal(toErrorPayload(err).code, code, 'code 必须原样穿过 toErrorPayload');
  }
});

test('toErrorPayload：details 只在给了的时候才出现（--json 的形状要稳定）', () => {
  assert.deepEqual(toErrorPayload(badInput('缺参数')), {
    code: CODES.INVALID_INPUT,
    message: '缺参数',
  });
  assert.deepEqual(toErrorPayload(badInput('缺参数', { flag: 'depth' })), {
    code: CODES.INVALID_INPUT,
    message: '缺参数',
    details: { flag: 'depth' },
  });
});

test('⚠️ 回归闸门：非 NxError 上手动赋 code **无效**，一律是 INTERNAL', () => {
  // 这条测的不是「我们希望的行为」，而是「必须被记住的陷阱」：
  // 一旦有人再写出 `const e = new Error(m); e.code = 'INVALID_INPUT'; throw e;`，
  // 上面那行的 code 会被丢掉。正确写法是 throw badInput(m)。
  const naive = new Error('设置项需形如 k=v');
  naive.code = 'INVALID_INPUT';
  const p = toErrorPayload(naive);
  assert.equal(p.code, CODES.INTERNAL, '手赋的 code 传不出去——这正是要修的那类 bug');
  assert.equal(p.message, '设置项需形如 k=v', 'message 仍要保住（字符串契约不能断）');
});

test('NxError 声明了不存在的 code 时回落到 INTERNAL（不把错值透出去）', () => {
  assert.equal(new NxError('NO_SUCH_CODE', 'x').code, CODES.INTERNAL);
});

test('code → HTTP 状态：只在 core/errors 映射一次', () => {
  assert.equal(httpStatusOf(CODES.INVALID_INPUT), 400);
  assert.equal(httpStatusOf(CODES.NOT_FOUND), 404);
  assert.equal(httpStatusOf(CODES.CONFLICT), 409);
  assert.equal(httpStatusOf(CODES.BLOCKED), 409);
  assert.equal(httpStatusOf(CODES.EXTERNAL), 502);
  assert.equal(httpStatusOf(CODES.SPEC_ERROR), 500);
  assert.equal(httpStatusOf(CODES.INTERNAL), 500);
  assert.equal(httpStatusOf('UNKNOWN'), 500, '未知 code 不能变成 2xx');
});

test('code → 退出码：CLI 只区分成功 / 失败', () => {
  for (const c of Object.values(CODES)) assert.equal(exitCodeOf(c), 1, `${c} 失败即 exit 1`);
  assert.equal(exitCodeOf('UNKNOWN'), 1);
});

test('message 里必须保住「用法:」「不存在」等子串（agent 按文本分类的旧契约）', () => {
  // assets/nx-kn/SKILL.md 教 agent 用这三个子串判断失败类型；
  // 改成结构化 code 是「追加」，不是「替换」——字符串契约不能断。
  assert.match(badInput('用法: nx-kn kb add <path> —— 缺少参数').message, /用法:/);
  assert.match(notFound('未找到内置 skill: nx-kn').message, /未找到/);
});

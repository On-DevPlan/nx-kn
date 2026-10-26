// HTTP 层的文件传输：导出回 zip 字节、导入收原始字节（面板拖拽）。
//
// 这两条路径的共同点是**浏览器与终端的能力不对等**：
//   - 终端能指定「写到哪个路径」，浏览器只能「下载」（保存目录由浏览器/系统决定）；
//   - 终端能给出本地路径，浏览器拖进来的 File **只有内容，没有路径**。
//
// 所以服务端必须提供两种搬运方式，但业务逻辑只能有一份：导出把 zip 交给 HTTP 层去发，
// 导入把上传的字节落成临时文件后仍然按「路径」处理。这里钉住的是这条边界，
// 以及「临时文件不许留在盘上」。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { clearCache } from '../../src/core/store.js';
import { readZip } from '../../src/core/zip.js';
import * as obsidian from '../../src/modules/obsidian/service.js';
import { handleApi } from '../../src/runtime/api.js';

function tmpData() {
  const dir = mkdtempSync(join(tmpdir(), 'nx-kn-transfer-'));
  process.env.NX_KN_STORE = join(dir, 'store.json');
  delete process.env.NX_OBSIDIAN_VAULT;
  clearCache();
  return dir;
}

function writeNote(vault, rel, text) {
  const abs = join(vault, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, text, 'utf8');
  return abs;
}

// 一个最小但真实的项目：根文档 + 一篇正文（导出包里会有 manifest + 2 个文件）
function seedVault() {
  const vault = mkdtempSync(join(tmpdir(), 'nx-kn-transfer-vault-'));
  mkdirSync(join(vault, '.obsidian'));
  writeNote(
    vault,
    'projects/alpha/Base-alpha.md',
    ['---', 'creatime: 2026-10-26 10:00:00', 'tags: []', 'bklink: []', '---', '', '# alpha', ''].join('\n')
  );
  writeNote(vault, 'projects/alpha/总纲.md', '# 总纲\n\n[[Base-alpha]]\n');
  return vault;
}

async function setup() {
  tmpData();
  const vault = seedVault();
  clearCache();
  await obsidian.set({ patch: { vault } });
  return vault;
}

function fakeReq(method, body, headers = {}) {
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')];
  return {
    method,
    headers,
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

function fakeRes() {
  const out = { status: null, headers: null, body: null, json: null };
  return {
    writeHead(status, headers) {
      out.status = status;
      out.headers = headers || {};
    },
    end(chunk) {
      if (chunk === undefined) return;
      out.body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      if (String((out.headers || {})['content-type'] || '').includes('application/json')) {
        out.json = JSON.parse(out.body.toString('utf8'));
      }
    },
    out,
  };
}

const URL_EXPORT = new URL('http://127.0.0.1:7881/api/obsidian/export');
const URL_IMPORT = new URL('http://127.0.0.1:7881/api/obsidian/import');

// 导出的两种去处：给 out → 落盘；不给 → 字节回给 HTTP 客户端
test('HTTP 导出不给 out：响应是 zip 字节（不是 JSON），并带下载文件名', async () => {
  await setup();
  const res = fakeRes();
  await handleApi(fakeReq('POST', JSON.stringify({ name: 'alpha' }), { 'content-type': 'application/json' }), res, URL_EXPORT);

  assert.equal(res.out.status, 200);
  assert.equal(res.out.json, null, '下载模式不能返回 JSON 包体');
  assert.equal(res.out.headers['content-type'], 'application/zip');
  assert.match(res.out.headers['content-disposition'], /attachment;/);
  // 中文项目名要靠 RFC 5987 的 filename* 才不至于变成乱码
  assert.match(res.out.headers['content-disposition'], /filename\*=UTF-8''/);
  assert.equal(res.out.headers['content-length'], String(res.out.body.length));

  const names = readZip(res.out.body).map((e) => e.name);
  assert.ok(names.includes('manifest.json'), '包里必须有 manifest');
  assert.ok(names.includes('projects/alpha/总纲.md'));
});

test('导出不给 out 且走 CLI：就地落在当前工作目录，包名与面板下载同一套规则', async () => {
  await setup();
  const cwd = process.cwd();
  const work = mkdtempSync(join(tmpdir(), 'nx-kn-cli-out-'));
  process.chdir(work);
  try {
    const r = await obsidian.exportProjects({ names: 'alpha' });
    assert.equal(r.defaultedOut, true, '必须标记这是默认落点，CLI 才能提示「已落在当前目录」');
    assert.equal(dirname(r.out), work);
    assert.match(basename(r.out), /^kn-alpha-\d{8}-\d{6}\.zip$/);
    // 不是「回报了路径但盘上没有」——真的写出来了，而且是合法 zip
    const names = readZip(readFileSync(r.out)).map((e) => e.name);
    assert.ok(names.includes('manifest.json'));
    assert.ok(names.includes('projects/alpha/总纲.md'));

    // 同一秒再导一次：不能静默盖掉上一个包
    const again = await obsidian.exportProjects({ names: 'alpha' });
    assert.notEqual(again.out, r.out);
    assert.ok(existsSync(r.out), '前一个包必须还在');
  } finally {
    process.chdir(cwd);
  }
});

test('上传 zip（原始字节）+ query 参数 → 正常预演，回显原始文件名而不是临时路径', async () => {
  await setup();
  const pack = (await obsidian.exportProjects({ names: 'alpha', transport: 'http' })).download.buffer;

  const before = readdirSync(tmpdir()).filter((n) => n.startsWith('kn-upload-'));
  const res = fakeRes();
  await handleApi(
    fakeReq('POST', pack, {
      'content-type': 'application/zip',
      'content-length': String(pack.length),
      'x-kn-filename': encodeURIComponent('我的迁移包.zip'),
    }),
    res,
    new URL('http://127.0.0.1:7881/api/obsidian/import?dry-run=1')
  );

  assert.equal(res.out.status, 200, JSON.stringify(res.out.json));
  assert.equal(res.out.json.ok, true);
  assert.equal(res.out.json.data.dryRun, true);
  assert.equal(res.out.json.data.wouldImport[0].name, 'alpha');
  assert.equal(res.out.json.data.file, '我的迁移包.zip', '回显必须是原始文件名，不能是临时路径');

  const after = readdirSync(tmpdir()).filter((n) => n.startsWith('kn-upload-'));
  assert.equal(after.length, before.length, '上传的临时文件必须在请求结束后删掉');
});

test('上传时 content-type 仍是 JSON → 照旧走 JSON 路径（两种调用方式共存）', async () => {
  await setup();
  const pack = (await obsidian.exportProjects({ names: 'alpha', transport: 'http' })).download.buffer;
  const zipPath = join(mkdtempSync(join(tmpdir(), 'nx-kn-pack-')), 'pack.zip');
  writeFileSync(zipPath, pack);

  const res = fakeRes();
  await handleApi(
    fakeReq('POST', JSON.stringify({ file: zipPath, 'dry-run': true }), { 'content-type': 'application/json' }),
    res,
    URL_IMPORT
  );
  assert.equal(res.out.status, 200, JSON.stringify(res.out.json));
  assert.equal(res.out.json.data.wouldImport[0].name, 'alpha');
  assert.equal(res.out.json.data.file, zipPath);
});

test('上传超过上限：按 content-length 先拒绝（不把整段读进内存）', async () => {
  await setup();
  const res = fakeRes();
  await handleApi(
    fakeReq('POST', Buffer.from('PK'), {
      'content-type': 'application/zip',
      'content-length': String(1024 * 1024 * 1024),
    }),
    res,
    URL_IMPORT
  );
  assert.equal(res.out.status, 400);
  assert.equal(res.out.json.code, 'INVALID_INPUT');
  assert.match(res.out.json.error, /上传文件过大/);
});

// 端口占用处理的单测：撞端口时的两个分支 + 全局不开浏览器的开关。
//
// 为什么值得钉住：端口被占绝大多数情况是「我自己已经开着呢」，
// 这时面板应该**直接复用**那个实例，而不是报错退出让人以为坏了；
// 而占用者是别的服务时又必须**顺延**到下一个空闲端口，不能硬撞。
//
// 两者的判定依据只有一个：GET /api/bootstrap 里的 app.name ——
// 所以下面的 reuse 用例必须用**本项目真实的 APP_NAME**，
// 否则 reuse 分支永远测不到（这正是要防的坑）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { APP_NAME } from '../../src/core/paths.js';
import {
  NO_OPEN_ENV,
  autoOpenEnabled,
  probePanel,
  findFreePort,
  resolvePortConflict,
  describeOccupant,
} from '../../src/core/serve-port.js';

// 起一个假的 /api/bootstrap：返回 { ok:true, data:{ app:{ name } } }。
async function startFakePanel(appName) {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/bootstrap') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { app: { name: appName } } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_));
  return {
    port: server.address().port,
    close: () => new Promise((resolve_) => server.close(resolve_)),
  };
}

// 占着端口但**不说 HTTP 语言**的临时服务：探测应当认不出它是面板。
async function startBlackHole() {
  const sockets = new Set();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });
  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_));
  return {
    port: server.address().port,
    close: () =>
      new Promise((resolve_) => {
        for (const s of sockets) s.destroy();
        server.close(resolve_);
      }),
  };
}

test('autoOpenEnabled：--no-open 与 NX_SERVE_NO_OPEN 任一为真即不开浏览器', () => {
  const saved = process.env[NO_OPEN_ENV];
  try {
    delete process.env[NO_OPEN_ENV];
    assert.equal(autoOpenEnabled(false), true, '环境变量未设且无 flag → 允许开');
    assert.equal(autoOpenEnabled(true), false, 'flag 为真 → 不开（即使环境变量没设）');

    for (const v of ['1', 'true', 'yes', 'on', 'ON', 'True']) {
      process.env[NO_OPEN_ENV] = v;
      assert.equal(autoOpenEnabled(false), false, `NX_SERVE_NO_OPEN=${v} → 不开`);
    }

    process.env[NO_OPEN_ENV] = '0';
    assert.equal(autoOpenEnabled(false), true, '0 不算真值 → 仍然开');
  } finally {
    if (saved === undefined) delete process.env[NO_OPEN_ENV];
    else process.env[NO_OPEN_ENV] = saved;
  }
});

test('probePanel：端口上不是面板时返回 null', async () => {
  const hole = await startBlackHole();
  try {
    assert.equal(await probePanel(hole.port, '127.0.0.1', 300), null);
  } finally {
    await hole.close();
  }
});

test('findFreePort：返回的端口确实能监听', async () => {
  const taken = await startBlackHole();
  try {
    const port = await findFreePort(taken.port, '127.0.0.1');
    assert.ok(port > taken.port, '被占的端口应当被跳过');

    const probe = net.createServer();
    await new Promise((resolve_, reject) => {
      probe.once('error', reject);
      probe.listen(port, '127.0.0.1', resolve_);
    });
    await new Promise((resolve_) => probe.close(resolve_));
  } finally {
    await taken.close();
  }
});

test('resolvePortConflict：自己的面板 → reuse；别人的 → shift 且换到更大的端口', async () => {
  const mine = await startFakePanel(APP_NAME);
  try {
    const d = await resolvePortConflict(mine.port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'reuse', 'app.name 与本项目一致时应当复用');
    assert.equal(d.port, mine.port, '复用时端口不变');
  } finally {
    await mine.close();
  }

  const other = await startFakePanel('someone-else');
  try {
    const d = await resolvePortConflict(other.port, APP_NAME, '127.0.0.1');
    assert.equal(d.action, 'shift', 'app.name 不是本项目时应当顺延端口');
    assert.ok(d.port > other.port, 'shift 分支必须换到更大的端口');
    assert.equal(describeOccupant(d.occupant), 'someone-else');
  } finally {
    await other.close();
  }

  assert.equal(describeOccupant(null), '未知服务', '探测不到占用者时的描述');
});

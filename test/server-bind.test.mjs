// #64 测试先行：测试服务器必须绑在 IPv4 loopback 上。
//
// 背景：真实 HTTP 用例以前一律 `app.listen(0)`。macOS 上这会绑成 [::]:P
// （tcp46 通配），而客户端 fetch 走 127.0.0.1（IPv4）。两个地址族对不上，
// 端口号可能从 IPv6 空间借到一个已被本机代理占着的 IPv4 端口，
// fetch 便命中代理而不是应用，报 UND_ERR_SOCKET other side closed。
//
// 这类故障是低频随机的，靠「多跑几次」发现不了，只能靠断言把「绑在哪」钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { listenLoopback, LOOPBACK_HOST } from './helpers/server.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
// 允许「故意演示默认行为」的对照样本豁免守护，标记必须显式写在行尾。
const ALLOW_DEFAULT_LISTEN = 'allow-default-listen';

function makeApp() {
  return http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: req.url }));
  });
}

async function start(app) {
  const server = listenLoopback(app);
  await new Promise((resolve) => server.once('listening', resolve));
  return server;
}

test('#64 测试服务器绑在 127.0.0.1，不是 IPv6 通配口', async (t) => {
  const server = await start(makeApp());
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const address = server.address();
  assert.equal(address.address, '127.0.0.1');
  assert.equal(address.family, 'IPv4');
});

test('#64 端口被别人占着时，测试服务器拿到的端口不是那个', async (t) => {
  // 占一个 IPv4 端口，模拟本机代理占位。
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const taken = blocker.address().port;
  t.after(() => new Promise((resolve) => {
    blocker.closeAllConnections();
    blocker.close(resolve);
  }));

  const server = await start(makeApp());
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  assert.notEqual(server.address().port, taken);
});

test('#64 真实请求每次都命中应用，不会掉进别人的 socket', async (t) => {
  const server = await start(makeApp());
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  const port = server.address().port;
  for (let i = 0; i < 30; i += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/api/probe?i=${i}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.url, `/api/probe?i=${i}`);
  }
});

test('#64 默认 listen(0) 并不是 IPv4 loopback——这正是必须显式传 host 的理由', async (t) => {
  const server = makeApp().listen(0); // allow-default-listen：故意演示默认行为
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));

  assert.notEqual(server.address().address, '127.0.0.1');
});

test('#64 静态守护：所有 listen 调用都必须绑 127.0.0.1', () => {
  const files = [
    ...readdirSync(HERE).filter((name) => name.endsWith('.test.mjs')).map((name) => join(HERE, name)),
    join(REPO, 'scripts', 'acceptance.mjs'),
  ];

  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      // 对照样本（专门用来演示默认行为有多危险）可以显式豁免，但必须留下标记，
      // 让例外可审计，而不是靠文件名开白名单。
      if (line.includes(ALLOW_DEFAULT_LISTEN)) return;
      const code = line.replace(/\/\/.*$/, '');
      for (const match of code.matchAll(/\.listen\(([^)]*)\)/g)) {
        assert.match(
          match[1],
          /'127\.0\.0\.1'/,
          `${file.replace(`${REPO}/`, '')} 第 ${index + 1} 行的 listen 必须绑 127.0.0.1，或改用 listenLoopback()`,
        );
      }
    });
  }
});

test('#64 helper 是唯一的绑定入口，且它的 host 与验收脚本一致', () => {
  const helper = readFileSync(join(HERE, 'helpers', 'server.mjs'), 'utf8');
  const helperCode = helper.split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n');
  const listens = helperCode.match(/\.listen\(/g) ?? [];
  assert.equal(listens.length, 1, 'helper 里应只有一处 listen 调用');
  assert.match(helperCode, /LOOPBACK_HOST = '127\.0\.0\.1'/);

  const acceptance = readFileSync(join(REPO, 'scripts', 'acceptance.mjs'), 'utf8');
  assert.ok(
    acceptance.includes(`'${LOOPBACK_HOST}'`),
    `验收脚本的 loopback 必须是 ${LOOPBACK_HOST}，与 helper 保持一致`,
  );
});

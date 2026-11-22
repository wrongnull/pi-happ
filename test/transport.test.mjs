import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { ProtectedTransport, installAuthFetch, protectProvider } from '../src/transport.mjs';

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

test('provider transport and scoped OAuth use CONNECT; unrelated fetch is unaffected; fail closed', async () => {
  let hits = 0;
  let connects = 0;
  const sockets = new Set();
  const origin = http.createServer((_req, res) => { hits++; res.end('ok'); });
  const originPort = await listen(origin);
  const proxy = http.createServer();
  proxy.on('connect', (req, client, head) => {
    connects++;
    // Test proxy is restricted to the synthetic local target.
    assert.equal(req.url, `127.0.0.1:${originPort}`);
    const upstream = net.connect(originPort, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket); socket.on('error', () => {});
      socket.once('close', () => sockets.delete(socket));
    }
  });
  const port = await listen(proxy);
  const tunnel = { running: true, port };
  const transport = new ProtectedTransport(tunnel);
  transport.setDirect(false);
  const uninstall = installAuthFetch();
  const url = `http://127.0.0.1:${originPort}/`;
  try {
    assert.equal(await (await transport.fetch(url)).text(), 'ok');
    assert.equal(connects, 1);
    assert.equal(await transport.runAuth(async () => (await fetch(url)).text()), 'ok');
    const before = connects;
    assert.equal(await (await fetch(url)).text(), 'ok');
    assert.equal(connects, before);
    const opts = transport.options({ transport: 'websocket' });
    assert.equal(opts.transport, 'sse');
    transport.invalidate();
    assert.equal(opts.signal.aborted, true);
    tunnel.running = false;
    const count = hits;
    await assert.rejects(transport.fetch(url), /VPN required/);
    await assert.rejects(transport.runAuth(() => fetch(url)), /VPN required/);
    assert.equal(hits, count);
    // Even if the child state is stale, dead proxy must not fall back to origin.
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => proxy.close(resolve));
    tunnel.running = true;
    await assert.rejects(transport.fetch(url));
    assert.equal(hits, count);
  } finally {
    uninstall(); transport.invalidate();
    for (const socket of sockets) socket.destroy();
    proxy.close(); origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
  }
});

test('direct access works initially and after intentional stop, but not after a crash', async () => {
  const server = http.createServer((_req, res) => res.end('direct'));
  const port = await listen(server);
  const tunnel = { running: false, start: async () => { tunnel.running = true; }, stop: async () => { tunnel.running = false; } };
  const transport = new ProtectedTransport(tunnel);
  const uninstall = installAuthFetch();
  const url = `http://127.0.0.1:${port}`;
  try {
    assert.equal(transport.direct, true);
    assert.equal(await (await transport.fetch(url)).text(), 'direct');
    assert.equal(await transport.runAuth(async () => (await fetch(url)).text()), 'direct');
    await transport.connect({});
    assert.equal(transport.direct, false);
    tunnel.running = false; // unexpected Xray exit
    transport.invalidate();
    assert.throws(() => transport.options(), /VPN required/);
    await assert.rejects(transport.fetch(url), /VPN required/);
    await assert.rejects(transport.runAuth(() => fetch(url)), /VPN required/);
    await transport.stopByUser();
    assert.equal(transport.direct, true);
    assert.equal(await (await transport.fetch(url)).text(), 'direct');
  } finally {
    uninstall(); transport.invalidate(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('failed connection remains protected; explicit cancellation restores direct access', async () => {
  const tunnel = { running: false, start: async () => { throw new Error('connection failed'); }, stop: async () => {} };
  const transport = new ProtectedTransport(tunnel);
  await assert.rejects(transport.connect({}), /connection failed/);
  assert.equal(transport.direct, false);
  assert.throws(() => transport.options(), /VPN required/);
  const controller = new AbortController();
  controller.abort(new DOMException('user cancelled', 'AbortError'));
  await assert.rejects(transport.connect({}, controller.signal));
  assert.equal(transport.direct, true);
  // Session shutdown is not an explicit request to continue directly.
  const shutdown = new AbortController();
  shutdown.abort(new Error('session ended'));
  await assert.rejects(transport.connect({}, shutdown.signal));
  assert.equal(transport.direct, false);
});

test('connecting blocks requests even if the child process has already started', async () => {
  let finish;
  const tunnel = { running: true, start: () => new Promise(resolve => { finish = resolve; }) };
  const transport = new ProtectedTransport(tunnel);
  const connecting = transport.connect({});
  assert.throws(() => transport.options(), /VPN required/);
  finish();
  await connecting;
  assert.equal(transport.direct, false);
  assert.doesNotThrow(() => transport.options());
  transport.invalidate();
});

test('provider wrapping preserves catalog and OAuth callbacks', async () => {
  const tunnel = { running: false };
  const transport = new ProtectedTransport(tunnel);
  const provider = {
    id: 'test', getModels: () => ['model'],
    auth: { oauth: { name: 'OAuth', login: async () => 'login', refresh: async () => 'refresh' } },
    streamSimple: (_model, _ctx, options) => options,
  };
  const wrapped = protectProvider(provider, transport);
  assert.deepEqual(wrapped.getModels(), ['model']);
  assert.equal(await wrapped.auth.oauth.login(), 'login');
  assert.equal(wrapped.streamSimple({}, {}, { transport: 'auto' }).transport, 'auto');
  transport.setDirect(false);
  assert.throws(() => wrapped.streamSimple({}, {}), /VPN required/);
  transport.setDirect(true);
  assert.equal(wrapped.streamSimple({}, {}, { transport: 'auto' }).transport, 'auto');
});

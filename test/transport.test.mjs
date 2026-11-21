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
  assert.throws(() => wrapped.streamSimple({}, {}), /VPN required/);
  transport.setDirect(true);
  assert.equal(wrapped.streamSimple({}, {}, { transport: 'auto' }).transport, 'auto');
});

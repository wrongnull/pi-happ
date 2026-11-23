import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { profileEndpoint, tcpPing, checkLocations } from '../src/latency.mjs';

const profile = (port = 443, host = 'example.invalid') => ({ outbounds: [{ protocol: 'vless', tag: 'entry', settings: { vnext: [{ address: host, port }] } }] });

test('extracts TCP endpoints without mutating profiles, rejects UDP and invalid profiles', () => {
  const source = profile();
  assert.deepEqual(profileEndpoint(source), { host: 'example.invalid', port: 443 });
  assert.equal(source.outbounds[0].tag, 'entry');
  assert.deepEqual(profileEndpoint(profile(443, '[::1]')), { host: '::1', port: 443 });
  for (const invalid of [profile(0), profile(65536), profile(443, 'bad\nhost'), { outbounds: [] }]) {
    assert.equal(profileEndpoint(invalid), undefined);
  }
  const udp = profile();
  udp.outbounds[0].streamSettings = { network: 'kcp' };
  assert.equal(profileEndpoint(udp), undefined);
  assert.equal(profileEndpoint({ outbounds: [{ protocol: 'hysteria', settings: { servers: [{ address: 'example.invalid', port: 443 }] } }] }), undefined);
});

test('chain probes the physical first hop, not the final destination', () => {
  const source = profile();
  source.outbounds[0].proxySettings = { tag: 'hop' };
  source.outbounds.push({ protocol: 'trojan', tag: 'hop', settings: { servers: [{ address: 'hop.invalid', port: 8443 }] } });
  assert.deepEqual(profileEndpoint(source), { host: 'hop.invalid', port: 8443 });
  source.outbounds[1].proxySettings = { tag: 'entry' };
  assert.equal(profileEndpoint(source), undefined);
});

test('TCP probe connects to a real local listener and reports closed ports without leaking errors', async () => {
  const server = createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const endpoint = { host: '127.0.0.1', port: server.address().port };
  try {
    const result = await tcpPing(endpoint);
    assert.equal(result.status, 'ok');
    assert.ok(result.latencyMs >= 0);
    assert.ok(result.checkedAt > 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
  const result = await tcpPing(endpoint);
  assert.equal(result.status, 'unreachable');
  assert.equal(result.latencyMs, undefined);
});

test('timeout and cancellation destroy pending sockets', async () => {
  let destroyed = 0;
  const connect = () => Object.assign(new EventEmitter(), { destroy() { destroyed++; } });
  assert.equal((await tcpPing({ host: 'unused', port: 443 }, { timeoutMs: 10, connect })).status, 'timeout');
  const controller = new AbortController();
  const pending = tcpPing({ host: 'unused', port: 443 }, { signal: controller.signal, connect });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(destroyed, 2);
});

test('bounded parallelism, deduplication and stable profile order', async () => {
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const profiles = [profile(1), profile(2), profile(1), profile(3), { outbounds: [] }];
  const results = await checkLocations(profiles, { concurrency: 2, probe: async endpoint => {
    calls++; active++; maximum = Math.max(maximum, active);
    await delay(10);
    active--;
    return { status: 'ok', latencyMs: endpoint.port, checkedAt: Date.now() };
  } });
  assert.equal(calls, 3);
  assert.ok(maximum <= 2);
  assert.deepEqual(results.map(r => r.latencyMs), [1, 2, 1, 3, undefined]);
  assert.equal(results[4].status, 'unsupported');
});

test('cancellation aborts workers and does not start queued probes', async () => {
  const controller = new AbortController();
  let calls = 0;
  const pending = checkLocations([profile(1), profile(2), profile(3)], { signal: controller.signal, concurrency: 1,
    probe: async (_endpoint, { signal }) => { calls++; await delay(1000, undefined, { signal }); } });
  controller.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(calls, 1);
});

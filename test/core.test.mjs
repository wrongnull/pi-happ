import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildConfig, parseSubscription, parseIPCheck, cleanLabel, Tunnel, loadState, saveState } from '../src/core.mjs';

const profile = { remarks: 'Test', outbounds: [{ protocol: 'vless', tag: 'proxy', settings: {} }, { protocol: 'freedom' }] };

test('imports multiple JSON profiles without exposing them', () => {
  assert.equal(parseSubscription(JSON.stringify([profile, profile])).length, 2);
  for (const value of ['secret-invalid', '{}', '[]', '[null]']) {
    assert.throws(() => parseSubscription(value));
  }
});
test('rebuilds config: loopback only, no remote routing or direct outbounds', () => {
  const source = { ...profile, inbounds: [{ listen: '0.0.0.0' }], routing: { rules: ['unsafe'] }, api: {} };
  const config = buildConfig(source, 12345);
  assert.equal(config.inbounds[0].listen, '127.0.0.1');
  assert.equal(config.inbounds[0].protocol, 'http');
  assert.deepEqual(config.outbounds.map(o => o.protocol), ['vless']);
  assert.equal(config.routing, undefined);
  assert.equal(config.api, undefined);
  assert.equal(source.outbounds[0].tag, 'proxy');
});
test('rejects direct-only profiles and broken chain references', () => {
  assert.throws(() => buildConfig({ outbounds: [{ protocol: 'freedom' }] }, 12345));
  assert.throws(() => buildConfig({ outbounds: [{ protocol: 'vless', proxySettings: { tag: 'direct' } }] }, 12345));
});
test('IP check fails closed without a running child', async () => {
  const tunnel = new Tunnel();
  await assert.rejects(tunnel.checkIP(), /not running/);
  await tunnel.stop();
  await tunnel.stop();
});
test('missing Xray binary fails and cleans up', async () => {
  const tunnel = new Tunnel();
  await assert.rejects(tunnel.start(profile, '/nonexistent/pi-happ-xray'), /failed to start/);
  assert.equal(tunnel.running, false);
  assert.equal(tunnel.directory, undefined);
  await tunnel.stop();
});
test('private atomic subscription storage', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-happ-test-'));
  try {
    assert.deepEqual((await loadState(dir)).subscriptions, []);
    const state = { version: 1, subscriptions: [{ name: 'Test', profiles: [profile] }] };
    await saveState(state, dir);
    assert.deepEqual(await loadState(dir), state);
    assert.equal((await stat(join(dir, 'subscriptions.json'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('IP check parses IPv4/IPv6 and HTTPS duration in milliseconds', () => {
  assert.deepEqual(parseIPCheck('203.0.113.1\n', 123.456), { ip: '203.0.113.1', latencyMs: 123 });
  assert.deepEqual(parseIPCheck('2001:db8::1\n', 45), { ip: '2001:db8::1', latencyMs: 45 });
  for (const [output, ms] of [['invalid', 1], ['203.0.113.1', NaN], ['203.0.113.1', -1], ['203.0.113.1 extra', 1]]) {
    assert.throws(() => parseIPCheck(output, ms));
  }
});
test('sanitizes remote terminal labels', () => {
  assert.equal(cleanLabel('hello\x1b\nworld'), 'helloworld');
});

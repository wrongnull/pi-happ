import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, Tunnel, downloadSubscription } from '../src/core.mjs';
import { ensureRuntime } from '../src/runtime.mjs';
import { diagnoseXray } from '../src/diagnostics.mjs';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from '../src/watchdog.mjs';

const proxy = (tag, next) => ({ protocol: 'vless', tag, settings: {}, ...(next ? { proxySettings: { tag: next } } : {}) });
test('retains reachable chains and excludes direct/unrelated outbounds', () => {
  const root = proxy('entry', 'exit');
  const exit = proxy('exit');
  const profile = { outbounds: [root, { protocol: 'freedom', tag: 'direct' }, exit, proxy('unused')] };
  const result = buildConfig(profile, 12345);
  assert.deepEqual(result.outbounds.map(o => o.tag), ['entry', 'exit']);
  assert.equal(result.outbounds[0].proxySettings.tag, 'exit');
  assert.equal(result.routing, undefined);
  result.outbounds[0].tag = 'changed';
  assert.equal(root.tag, 'entry');
});
test('supports dialerProxy but rejects cycles, duplicate, missing and direct references', () => {
  const entry = proxy('entry');
  entry.streamSettings = { sockopt: { dialerProxy: 'exit' } };
  assert.equal(buildConfig({ outbounds: [entry, proxy('exit')] }, 12345).outbounds.length, 2);
  for (const outbounds of [
    [proxy('a', 'b'), proxy('b', 'a')],
    [proxy('a'), proxy('a')],
    [proxy('a', 'missing')],
    [proxy('a', 'direct'), { protocol: 'freedom', tag: 'direct' }],
  ]) assert.throws(() => buildConfig({ outbounds }, 12345));
});
test('pre-aborted operations do not download or launch a process', async () => {
  const controller = new AbortController();
  controller.abort(new DOMException('cancelled', 'AbortError'));
  let downloaded = false;
  await assert.rejects(ensureRuntime({ signal: controller.signal, download: async () => { downloaded = true; } }), { name: 'AbortError' });
  await assert.rejects(downloadSubscription('https://example.invalid/secret', controller.signal), { name: 'AbortError' });
  const tunnel = new Tunnel();
  await assert.rejects(tunnel.start({ outbounds: [proxy('a')] }, '/nonexistent', undefined, controller.signal), { name: 'AbortError' });
  assert.equal(tunnel.child, undefined);
  assert.equal(downloaded, false);
});
test('cancelling a runtime download leaves no installation files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-happ-download-cancel-'));
  const controller = new AbortController();
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const installing = ensureRuntime({ root, signal: controller.signal, download: async (_url, _fetch, signal) => {
    started();
    await delay(10000, undefined, { signal });
    return Buffer.from('unused');
  } });
  const rejected = assert.rejects(installing, { name: 'AbortError' });
  try {
    await ready;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await rejected;
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(root), []);
  } finally { controller.abort(); await rejected; await rm(root, { recursive: true, force: true }); }
});

test('cancelling an active connection removes child, watchdog and config', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-happ-cancel-test-'));
  const binary = join(root, 'fake-xray');
  await writeFile(binary, '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o700 });
  const tunnel = new Tunnel();
  const controller = new AbortController();
  tunnel.checkIP = async signal => { await delay(10000, undefined, { signal }); };
  const starting = tunnel.start({ outbounds: [proxy('entry')] }, binary, undefined, controller.signal);
  const rejected = assert.rejects(starting, { name: 'AbortError' });
  try {
    const deadline = Date.now() + 5000;
    while (!tunnel.watchdog && Date.now() < deadline) await delay(25);
    assert.ok(tunnel.watchdog);
    const pid = tunnel.child.pid;
    const watcher = tunnel.watchdog.pid;
    const directory = tunnel.directory;
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await rejected;
    assert.equal(await processIdentity(pid), undefined);
    assert.equal(await processIdentity(watcher), undefined);
    await assert.rejects(access(directory));
    assert.equal(tunnel.running, false);
  } finally {
    controller.abort();
    await rejected;
    await tunnel.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('diagnostics never disclose untrusted output', () => {
  const secret = 'vless://secret-uuid@private.example:1234/path?token=secret';
  for (const text of ['address already in use', 'failed to build', 'permission denied', 'no such host', 'connection refused', 'tls handshake']) {
    const result = diagnoseXray(`${text}: ${secret}`);
    assert.ok(result);
    assert.ok(!result.includes('secret') && !result.includes('private.example'));
  }
  assert.equal(diagnoseXray(secret), undefined);
});

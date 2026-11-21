import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { processIdentity } from '../src/watchdog.mjs';

async function waitFor(fn, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; await delay(50); }
  throw new Error('Timed out waiting for watchdog cleanup');
}

for (const mode of ['parent-killed', 'parent-killed-ignore-term', 'watchdog-killed', 'normal-stop']) {
  test(`watchdog lifecycle: ${mode}`, { skip: process.platform !== 'linux', timeout: 15000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-happ-watch-test-'));
    const binary = join(root, 'fake-xray');
    await writeFile(binary, `#!/usr/bin/env node\n${mode.includes('ignore-term') ? "process.on('SIGTERM', () => {});" : ''}\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const coreUrl = new URL('../src/core.mjs', import.meta.url).href;
    const source = `
      import { Tunnel } from ${JSON.stringify(coreUrl)};
      const tunnel = new Tunnel();
      tunnel.checkIP = async () => ({ ip: '203.0.113.1', latencyMs: 1 });
      await tunnel.start({ outbounds: [{ protocol: 'vless', settings: {} }] }, ${JSON.stringify(binary)});
      console.log(JSON.stringify({ xray: tunnel.child.pid, watcher: tunnel.watchdog.pid, directory: tunnel.directory }));
      ${mode === 'normal-stop' ? 'await tunnel.stop();' : 'setInterval(() => {}, 1000);'}
    `;
    const parent = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'pipe', 'pipe'] });
    let info;
    let stderr = '';
    parent.stderr.on('data', data => { stderr += data; });
    const parentClosed = new Promise(resolve => parent.once('close', resolve));
    try {
      info = await new Promise((resolve, reject) => {
        let buffer = '';
        parent.stdout.on('data', data => {
          buffer += data;
          if (buffer.includes('\n')) {
            try { resolve(JSON.parse(buffer.split('\n')[0])); } catch (error) { reject(error); }
          }
        });
        parent.once('error', reject);
        parent.once('close', () => reject(new Error(`Parent exited: ${stderr}`)));
      });
      assert.ok(await processIdentity(info.xray) || mode === 'normal-stop');
      if (mode.startsWith('parent-killed')) parent.kill('SIGKILL');
      if (mode === 'watchdog-killed') process.kill(info.watcher, 'SIGKILL');
      await waitFor(async () => !(await processIdentity(info.xray)));
      await waitFor(async () => { try { await access(info.directory); return false; } catch { return true; } });
      if (mode === 'normal-stop') await parentClosed;
    } finally {
      parent.kill('SIGKILL');
      if (info) for (const pid of [info.xray, info.watcher]) {
        if (await processIdentity(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      await parentClosed;
      if (info) await rm(info.directory, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
}

test('watchdog handles closed control/output pipes before readiness', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-happ-watch-early-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const childClosed = new Promise(resolve => child.once('close', resolve));
  let watcher;
  let watcherClosed;
  try {
    const identity = await processIdentity(child.pid);
    assert.ok(identity);
    watcher = spawn(process.execPath, [new URL('../src/watchdog-runner.mjs', import.meta.url).pathname,
      String(child.pid), identity, directory], { stdio: ['pipe', 'pipe', 'ignore'] });
    watcherClosed = new Promise(resolve => watcher.once('close', resolve));
    // Simulate Pi dying before reading the watchdog's readiness message.
    watcher.stdin.on('error', () => {});
    watcher.stdout.destroy();
    watcher.stdin.end();
    await waitFor(async () => !(await processIdentity(child.pid)));
    await watcherClosed;
    await assert.rejects(access(directory));
    assert.equal(watcher.exitCode, 0);
  } finally {
    child.kill('SIGKILL');
    watcher?.kill('SIGKILL');
    await childClosed;
    if (watcherClosed) await watcherClosed;
    await rm(directory, { recursive: true, force: true });
  }
});

test('watchdog does not signal a PID with a different starttime', { skip: process.platform !== 'linux', timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-happ-watch-identity-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  const childClosed = new Promise(resolve => child.once('close', resolve));
  const watcher = spawn(process.execPath, [new URL('../src/watchdog-runner.mjs', import.meta.url).pathname,
    String(child.pid), '0', directory], { stdio: ['pipe', 'ignore', 'ignore'] });
  const watcherClosed = new Promise(resolve => watcher.once('close', resolve));
  watcher.stdin.on('error', () => {});
  watcher.stdin.end();
  try {
    await watcherClosed;
    assert.ok(await processIdentity(child.pid));
    assert.equal(watcher.exitCode, 0);
    await assert.rejects(access(directory));
  } finally {
    child.kill('SIGKILL'); watcher.kill('SIGKILL');
    await childClosed; await watcherClosed;
    await rm(directory, { recursive: true, force: true });
  }
});

test('identity handles nonexistent processes', async () => {
  assert.equal(await processIdentity(2147483647), undefined);
});

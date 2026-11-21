import { spawn } from 'node:child_process';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import { resolveRuntime } from './runtime.mjs';
import { watchChild } from './watch-child.mjs';
import { diagnoseXray } from './diagnostics.mjs';
import { mkdir, readFile, writeFile, rename, mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isIP, createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const stateDir = join(homedir(), '.config', 'pi-happ');
export const cleanLabel = (text) => String(text).replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 160);

export function parseSubscription(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Expected a Happ Xray JSON subscription'); }
  if (!Array.isArray(data) || !data.length || data.length > 2000 ||
      data.some(p => !p || !Array.isArray(p.outbounds) || !p.outbounds.length)) {
    throw new Error('Invalid or empty Xray profile list');
  }
  return data;
}

export async function downloadSubscription(url, signal) {
  signal?.throwIfAborted();
  try {
    const target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) throw new Error();
    const response = await fetch(target, {
      headers: { 'User-Agent': 'Happ/4.4.8' }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(25000)]) : AbortSignal.timeout(25000),
      redirect: 'error',
    });
    if (!response.ok) throw new Error();
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error();
      chunks.push(chunk);
    }
    return parseSubscription(Buffer.concat(chunks).toString('utf8'));
  } catch {
    signal?.throwIfAborted();
    // Never surface URLs, credentials, response bodies or fetch causes.
    throw new Error('Subscription download failed (HTTPS only, no redirects, 4 MiB limit), or unsupported format');
  }
}

export async function loadState(dir = stateDir) {
  try {
    const data = JSON.parse(await readFile(join(dir, 'subscriptions.json'), 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.subscriptions)) throw new Error();
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, subscriptions: [] };
    throw new Error('Cannot read subscription storage');
  }
}

export async function saveState(state, dir = stateDir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = join(dir, `${randomUUID()}.tmp`);
  try {
    await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
    await rename(temp, join(dir, 'subscriptions.json'));
  } finally { await rm(temp, { force: true }); }
}

// Keep only the reachable proxy chain; never import remote routing, listeners or DNS.
export function buildConfig(profile, port) {
  const allowed = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'socks', 'http']);
  const root = profile.outbounds.find(o => allowed.has(o.protocol));
  if (!root) throw new Error('No supported proxy outbound');
  const tags = new Map();
  for (const outbound of profile.outbounds) {
    if (!outbound.tag) continue;
    if (typeof outbound.tag !== 'string' || tags.has(outbound.tag)) throw new Error('Duplicate or invalid outbound tag');
    tags.set(outbound.tag, outbound);
  }
  const visiting = new Set();
  const visited = new Set();
  const outbounds = [];
  const visit = outbound => {
    if (visiting.has(outbound)) throw new Error('Cyclic proxy chain');
    if (visited.has(outbound)) return;
    if (!allowed.has(outbound.protocol)) throw new Error('Proxy chain references a direct or unsupported outbound');
    if (outbound.sendThrough || outbound.streamSettings?.sockopt?.interface) throw new Error('Interface-bound profiles are not supported');
    visiting.add(outbound);
    outbounds.push(structuredClone(outbound));
    const references = [outbound.proxySettings?.tag, outbound.streamSettings?.sockopt?.dialerProxy].filter(Boolean);
    if (outbound.proxySettings && !outbound.proxySettings.tag) throw new Error('Invalid proxy chain reference');
    for (const tag of references) {
      if (!tags.has(tag)) throw new Error('Missing proxy chain outbound');
      visit(tags.get(tag));
    }
    visiting.delete(outbound);
    visited.add(outbound);
  };
  visit(root);
  return {
    log: { loglevel: 'error' },
    inbounds: [{ tag: 'local', listen: '127.0.0.1', port, protocol: 'http', settings: {} }],
    outbounds,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export function parseIPCheck(output, latencyMs) {
  const ip = output.trim();
  if (!isIP(ip) || !Number.isFinite(latencyMs) || latencyMs < 0) {
    throw new Error('Invalid IP check response');
  }
  return { ip, latencyMs: Math.round(latencyMs) };
}

export class Tunnel {
  child;
  directory;
  port;
  label;
  onExit;
  watchdog;
  watchdogClosed;
  diagnostic;
  get running() { return !!this.child && this.child.exitCode === null && this.child.signalCode === null; }

  async start(profile, binary, onProgress, signal) {
    await this.stop();
    this.diagnostic = undefined;
    signal?.throwIfAborted();
    binary ??= await resolveRuntime(onProgress, signal);
    signal?.throwIfAborted();
    this.port = await freePort();
    const config = buildConfig(profile, this.port);
    this.directory = await mkdtemp(join(tmpdir(), 'pi-happ-'));
    const file = join(this.directory, 'config.json');
    const abort = () => { this.child?.kill('SIGTERM'); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      signal?.throwIfAborted();
      await writeFile(file, JSON.stringify(config), { mode: 0o600 });
      signal?.throwIfAborted();
      const child = spawn(binary, ['run', '-c', file], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
      let diagnosticBuffer = '';
      const inspect = data => {
        diagnosticBuffer = (diagnosticBuffer + data.toString('utf8')).slice(-8192);
        this.diagnostic = diagnoseXray(diagnosticBuffer) || this.diagnostic;
      };
      child.stdout.on('data', inspect);
      child.stderr.on('data', inspect);
      this.child = child;
      let failed = false;
      child.on('error', () => { failed = true; });
      child.once('close', () => { this.onExit?.(); });
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve);
        child.once('error', () => reject(new Error('Xray failed to start; check binary and profile compatibility')));
      });
      const directory = this.directory;
      const watcher = await watchChild(child, directory);
      this.watchdog = watcher;
      this.watchdogClosed = new Promise(resolve => watcher.once('close', resolve));
      watcher.once('close', () => {
        // Losing protection while Xray is still alive is a fail-closed condition.
        if (child.exitCode === null && child.signalCode === null) {
          this.onExit?.();
          child.once('close', () => { void rm(directory, { recursive: true, force: true }).catch(() => {}); });
          child.kill('SIGKILL');
        }
      });
      // Readiness is a successful HTTPS request, not merely an occupied port.
      for (let attempt = 0; attempt < 12; attempt++) {
        await delay(250, undefined, { signal });
        if (failed || !this.running) throw new Error(this.diagnostic || 'Xray failed to start; check binary and profile compatibility');
        try {
          await this.checkIP(signal);
          this.label = cleanLabel(profile.remarks || 'VPN');
          return;
        } catch { /* Retry while the child establishes a connection. */ }
      }
      throw new Error(this.diagnostic || 'Tunnel did not pass the external IP check; check VPN server availability');
    } catch (error) { await this.stop(); signal?.throwIfAborted(); throw error; }
    finally { signal?.removeEventListener('abort', abort); }
  }

  async checkIP(signal) {
    if (!this.running) throw new Error('Tunnel is not running');
    const agent = new ProxyAgent(`http://127.0.0.1:${this.port}`);
    const started = performance.now();
    try {
      const response = await proxyFetch('https://icanhazip.com', {
        dispatcher: agent, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000), redirect: 'error',
      });
      if (!response.ok) throw new Error();
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 128) throw new Error();
        chunks.push(chunk);
      }
      const result = parseIPCheck(Buffer.concat(chunks).toString('utf8'), performance.now() - started);
      if (!this.running) throw new Error();
      return result;
    } catch { throw new Error('IP check through VPN failed; no direct fallback'); }
    finally { await agent.destroy(); }
  }

  async stop() {
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('close', resolve));
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    this.watchdog?.stdin.end();
    if (this.watchdogClosed) await this.watchdogClosed;
    this.watchdog = undefined;
    this.watchdogClosed = undefined;
    this.child = undefined;
    this.label = undefined;
    if (this.directory) await rm(this.directory, { recursive: true, force: true });
    this.directory = undefined;
  }
}

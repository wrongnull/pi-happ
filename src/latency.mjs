import { createConnection } from 'node:net';
import { buildConfig } from './core.mjs';

// Measure the first physical hop from this host, not the far end of a chain.
export function profileEndpoint(profile) {
  let outbounds;
  try { outbounds = buildConfig(profile, 1).outbounds; } catch { return undefined; }
  let outbound = outbounds[0];
  const tags = new Map(outbounds.filter(o => o.tag).map(o => [o.tag, o]));
  const seen = new Set();
  while (outbound) {
    if (seen.has(outbound)) return undefined;
    seen.add(outbound);
    const refs = [outbound.proxySettings?.tag, outbound.streamSettings?.sockopt?.dialerProxy].filter(Boolean);
    if (new Set(refs).size > 1) return undefined;
    if (!refs.length) break;
    outbound = tags.get(refs[0]);
  }
  if (!outbound || outbound.protocol === 'hysteria' || ['kcp', 'mkcp', 'quic', 'hysteria'].includes(outbound.streamSettings?.network)) return undefined;
  const server = ['vless', 'vmess'].includes(outbound.protocol)
    ? outbound.settings?.vnext?.[0] : outbound.settings?.servers?.[0];
  const host = server?.address;
  const port = Number(server?.port);
  if (typeof host !== 'string' || !host.trim() || /[\s\x00-\x1f\x7f]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  return { host: host.replace(/^\[|\]$/g, ''), port };
}

/**
 * @param {{host: string, port: number}} endpoint
 * @param {{signal?: AbortSignal, timeoutMs?: number, connect?: typeof createConnection}} [options]
 */
export function tcpPing({ host, port }, { signal, timeoutMs = 3000, connect = createConnection } = {}) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let socket;
    let timer;
    let settled = false;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      socket?.destroy();
      if (error) reject(error);
      else resolve({ status, latencyMs: status === 'ok' ? Math.round(performance.now() - started) : undefined, checkedAt: Date.now() });
    };
    const abort = () => finish(undefined, signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      socket = connect({ host, port });
      socket.once('connect', () => finish('ok'));
      socket.once('error', () => finish('unreachable'));
    } catch { finish('unreachable'); }
  });
}

/**
 * @param {any[]} profiles
 * @param {{signal?: AbortSignal, concurrency?: number, probe?: typeof tcpPing}} [options]
 */
export async function checkLocations(profiles, { signal, concurrency = 8, probe = tcpPing } = {}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('Invalid probe concurrency');
  const results = new Array(profiles.length);
  const pending = new Map();
  let index = 0;
  const worker = async () => {
    while (index < profiles.length) {
      signal?.throwIfAborted();
      const current = index++;
      const endpoint = profileEndpoint(profiles[current]);
      if (!endpoint) { results[current] = { status: 'unsupported', checkedAt: Date.now() }; continue; }
      const key = JSON.stringify(endpoint);
      if (!pending.has(key)) pending.set(key, probe(endpoint, { signal }));
      results[current] = await pending.get(key);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, profiles.length) }, worker));
  signal?.throwIfAborted();
  return results;
}

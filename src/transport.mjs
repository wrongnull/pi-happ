import { AsyncLocalStorage } from 'node:async_hooks';
import { ProxyAgent, fetch as proxyFetch } from 'undici';

// OAuth implementations use global fetch and have no injectable transport.
// Only async work inside runAuth is intercepted; unrelated fetch stays untouched.
const scope = new AsyncLocalStorage();
const originalFetch = globalThis.fetch;
const scopedFetch = (input, init) => {
  const transport = scope.getStore();
  return transport ? transport.fetch(input, init) : originalFetch(input, init);
};
let users = 0;
export function installAuthFetch() {
  if (users++ === 0) globalThis.fetch = scopedFetch;
  return () => {
    if (--users === 0 && globalThis.fetch === scopedFetch) globalThis.fetch = originalFetch;
  };
}

export class ProtectedTransport {
  constructor(tunnel) {
    this.tunnel = tunnel;
    this.direct = false;
    this.generation = new AbortController();
    this.fetch = this.fetch.bind(this);
  }
  runAuth(fn) { return scope.run(this, fn); }
  invalidate() {
    this.generation.abort(new Error('VPN connection changed or stopped'));
    this.generation = new AbortController();
    if (this.agent) void this.agent.destroy().catch(() => {});
    this.agent = undefined;
    this.port = undefined;
  }
  setDirect(value) { this.invalidate(); this.direct = value; }
  options(options = {}) {
    if (this.direct) return options;
    this.assertReady();
    return { ...options, fetch: this.fetch, transport: 'sse',
      signal: options.signal ? AbortSignal.any([options.signal, this.generation.signal]) : this.generation.signal };
  }
  assertReady() {
    if (!this.tunnel.running) throw new Error('VPN required: connect a location using /happ');
  }
  async fetch(input, init = {}) {
    if (this.direct) return originalFetch(input, init);
    this.assertReady();
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported provider URL');
    if (!this.agent || this.port !== this.tunnel.port) {
      if (this.agent) void this.agent.destroy().catch(() => {});
      this.port = this.tunnel.port;
      this.agent = new ProxyAgent(`http://127.0.0.1:${this.port}`);
    }
    const signals = [this.generation.signal, init.signal, input?.signal].filter(Boolean);
    return proxyFetch(input, { ...init, dispatcher: this.agent, signal: AbortSignal.any(signals) });
  }
}

export function protectProvider(provider, transport) {
  const oauth = provider.auth.oauth;
  return {
    ...provider,
    auth: { ...provider.auth, ...(oauth ? { oauth: {
      ...oauth,
      login: (...args) => transport.runAuth(() => oauth.login(...args)),
      refresh: (...args) => transport.runAuth(() => oauth.refresh(...args)),
    } } : {}) },
    stream: (model, context, options) => provider.stream(model, context, transport.options(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, transport.options(options)),
  };
}

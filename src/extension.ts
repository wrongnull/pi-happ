import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { createHash, randomUUID } from 'node:crypto';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ProtectedTransport, installAuthFetch, protectProvider } from './transport.mjs';
import { Tunnel, cleanLabel, downloadSubscription, loadState, saveState } from './core.mjs';
import { resolveRuntime } from './runtime.mjs';
import { t, uiLocale } from './i18n.mjs';
import { checkLocations } from './latency.mjs';

export default function happ(pi: ExtensionAPI) {
  const tunnel = new Tunnel();
  const transport = new ProtectedTransport(tunnel);
  const uninstall = installAuthFetch();
  const latencies = new Map<string, { status: string; latencyMs?: number; checkedAt: number }>();
  const latencyKey = (profile: { outbounds: unknown[] }) => createHash('sha256').update(JSON.stringify(profile.outbounds)).digest('hex');
  const latencyText = (profile: { outbounds: unknown[] }) => {
    const result = latencies.get(latencyKey(profile));
    if (!result) return 'TCP: —';
    const age = Math.max(0, Math.floor((Date.now() - result.checkedAt) / 60000));
    const value = result.status === 'ok' ? `${result.latencyMs} ${t('ms', 'мс')}`
      : result.status === 'unsupported' ? 'n/a'
      : result.status === 'timeout' ? 'timeout' : t('unreachable', 'недоступен');
    return `TCP: ${value}${age ? ` · ${age} ${t('min ago', 'мин назад')}` : ''}`;
  };
  let busy = false;
  let operation: AbortController | undefined;
  const notifyError = (ctx: ExtensionContext, error: unknown) => ctx.ui.notify(
    error instanceof Error ? t(error.message) : t('Happ error', 'Ошибка Happ'), 'error');
  const runOperation = async <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    operation = controller;
    try {
      if (ctx.mode !== 'tui') return await work(controller.signal);
      const result = await ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, title);
        loader.onAbort = () => controller.abort(new DOMException(t('Operation cancelled', 'Операция отменена'), 'AbortError'));
        work(controller.signal).then(value => done({ value }), error => done({ error }));
        return loader;
      });
      if (result.error) throw result.error;
      controller.signal.throwIfAborted();
      return result.value as T;
    } finally { operation = undefined; }
  };
  for (const provider of builtinProviders().filter(p => ['openai', 'anthropic', 'openai-codex'].includes(p.id))) {
    pi.registerProvider(protectProvider(provider, transport));
  }
  tunnel.onExit = () => transport.invalidate();
  pi.on('session_shutdown', async () => {
    operation?.abort(new Error(t('Session ended', 'Сессия завершена')));
    transport.invalidate();
    await tunnel.stop();
    uninstall();
  });
  const ipText = (ip: string, ms: number) => `${ip} · ${t('HTTPS request', 'HTTPS-запрос')}: ${ms} ${t('ms', 'мс')}`;
  const checkIP = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      const label = tunnel.label || 'VPN';
      const { ip, latencyMs } = await tunnel.checkIP();
      ctx.ui.notify(`${label}: ${ipText(ip, latencyMs)} · ${new Date().toLocaleTimeString(uiLocale)}`, 'info');
    } catch (error) { notifyError(ctx, error); }
  };
  pi.registerCommand('happ-diagnostics', {
    description: t('Safe Xray status without server addresses or keys', 'Безопасное состояние Xray без адресов серверов и ключей'),
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Xray: ${tunnel.running ? t('running', 'запущен') : t('stopped', 'остановлен')} · ${tunnel.diagnostic || t('no recognized runtime errors', 'известных ошибок ядра нет')}`, 'info');
    },
  });
  pi.registerCommand('happ-runtime-install', {
    description: t('Install or verify the pinned Xray runtime without starting VPN', 'Установить или проверить закреплённое ядро Xray без запуска VPN'),
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || busy) return;
      busy = true;
      try {
        const binary = await runOperation(ctx, t('Installing Xray…', 'Установка Xray…'), signal => resolveRuntime(undefined, signal));
        ctx.ui.notify(`${t('Xray runtime ready', 'Ядро Xray готово')}: ${binary}`, 'info');
      } catch (error) { notifyError(ctx, error); }
      finally { busy = false; }
    },
  });
  pi.registerCommand('happ-ip-check', {
    description: t('Check public IP through VPN (icanhazip.com), no direct fallback', 'Проверить внешний IP через VPN (icanhazip.com), без прямого fallback'),
    handler: async (_args, ctx) => { await checkIP(ctx); },
  });
  const actions = {
    add: t('Add subscription', 'Добавить подписку'),
    update: t('Update subscription', 'Обновить подписку'),
    location: t('Select location', 'Выбрать локацию'),
    ip: t('Check public IP', 'Проверить внешний IP'),
    stop: t('Stop', 'Остановить'),
    mode: t('Switch direct/VPN mode', 'Переключить прямой/VPN режим'),
    updateAll: t('Update all subscriptions', 'Обновить все подписки'),
    remove: t('Remove subscription', 'Удалить подписку'),
    close: t('Close', 'Закрыть'),
  };
  pi.registerCommand('happ', {
    description: t('Happ subscriptions, locations, protected OpenAI/Anthropic/Codex transport and IP check', 'Подписки Happ, локации, VPN для OpenAI/Anthropic/Codex и проверка IP'),
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || busy) return;
      busy = true;
      try {
        const state: { version: number; subscriptions: Array<{
          id: string; name: string; url: string; updatedAt: string;
          profiles: Array<{ remarks?: string; outbounds: unknown[] }>;
        }> } = await loadState();
        while (true) {
          ctx.ui.setStatus('happ', tunnel.running ? `Happ: ${tunnel.label}` : undefined);
          const action = await ctx.ui.select(
            `Happ · ${tunnel.running ? tunnel.label : t('stopped', 'остановлен')} · ${transport.direct ? t('DIRECT mode', 'ПРЯМОЙ режим') : t('VPN required (SSE)', 'VPN обязателен (SSE)')}`,
            Object.values(actions),
          );
          if (!action || action === actions.close) break;
          if (action === actions.add) {
            const name = await ctx.ui.input(t('Subscription name', 'Название подписки'));
            if (!name?.trim()) continue;
            const url = await ctx.ui.input(t('Subscription HTTPS URL (secret; stored locally, not in the session)', 'HTTPS URL подписки (секрет; хранится локально, не в сессии)'));
            if (!url) continue;
            const profiles = await runOperation(ctx, t('Downloading subscription…', 'Загрузка подписки…'), signal => downloadSubscription(url, signal));
            state.subscriptions.push({ id: randomUUID(), name: cleanLabel(name), url, profiles, updatedAt: new Date().toISOString() });
            await saveState(state);
            ctx.ui.notify(`${t('Profiles imported', 'Импортировано профилей')}: ${profiles.length}`, 'info');
          } else if (action === actions.ip) {
            await checkIP(ctx);
          } else if (action === actions.mode) {
            if (transport.direct || await ctx.ui.confirm(t('Allow direct access?', 'Разрешить прямой доступ?'), t('OpenAI, Anthropic and Codex will work WITHOUT VPN.', 'OpenAI, Anthropic и Codex будут работать БЕЗ VPN.'))) {
              ctx.abort();
              transport.setDirect(!transport.direct);
            }
          } else if (action === actions.updateAll) {
            for (const subscription of state.subscriptions) {
              try {
                subscription.profiles = await runOperation(ctx, t('Updating subscription…', 'Обновление подписки…'), signal => downloadSubscription(subscription.url, signal));
                subscription.updatedAt = new Date().toISOString();
                await saveState(state);
              } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') throw error;
                ctx.ui.notify(`${t('Failed to update', 'Не удалось обновить')}: ${cleanLabel(subscription.name)}`, 'error');
              }
            }
          } else if (action === actions.stop) {
            ctx.abort();
            await transport.stopByUser();
          } else {
            const labels = state.subscriptions.map((s, i) => `${i + 1}. ${cleanLabel(s.name)} (${s.profiles.length})`);
            if (!labels.length) { ctx.ui.notify(t('Add a subscription first', 'Сначала добавьте подписку'), 'info'); continue; }
            const selected = await ctx.ui.select(t('Subscriptions', 'Подписки'), labels);
            if (!selected) continue;
            const index = labels.indexOf(selected);
            const subscription = state.subscriptions[index];
            if (action === actions.update) {
              const profiles = await runOperation(ctx, t('Updating subscription…', 'Обновление подписки…'), signal => downloadSubscription(subscription.url, signal));
              subscription.profiles = profiles;
              subscription.updatedAt = new Date().toISOString();
              await saveState(state);
            } else if (action === actions.remove) {
              if (await ctx.ui.confirm(t('Remove subscription?', 'Удалить подписку?'), cleanLabel(subscription.name))) {
                state.subscriptions.splice(index, 1);
                await saveState(state);
              }
            } else {
              while (true) {
                const checkAll = t('Check all locations (TCP)', 'Проверить все локации (TCP)');
                const names = subscription.profiles.map((p, i) => `${i + 1}. ${cleanLabel(p.remarks || t('Unnamed', 'Без названия'))} · ${latencyText(p)}`);
                const location = await ctx.ui.select(t('Location · TCP is not a tunnel test', 'Локация · TCP не проверяет туннель'), [checkAll, ...names]);
                if (!location) break;
                if (location === checkAll) {
                  try {
                    const results = await runOperation(ctx, t('Checking locations (TCP, Esc to cancel)…', 'Проверка локаций (TCP, Esc — отмена)…'), signal =>
                      checkLocations(subscription.profiles, { signal }));
                    subscription.profiles.forEach((profile, i) => latencies.set(latencyKey(profile), results[i]));
                    while (latencies.size > 10000) latencies.delete(latencies.keys().next().value!);
                  } catch (error) {
                    notifyError(ctx, error);
                    if (!(error instanceof Error && error.name === 'AbortError')) throw error;
                  }
                  continue;
                }
                const selectedIndex = names.indexOf(location);
                if (selectedIndex < 0) continue;
                ctx.ui.notify(t('Starting Xray and checking IP…', 'Запуск Xray и проверка IP…'), 'info');
                ctx.abort();
                await runOperation(ctx, t('Connecting VPN (Esc to cancel)…', 'Подключение VPN (Esc — отмена)…'), signal =>
                  transport.connect(subscription.profiles[selectedIndex], signal));
                const { ip, latencyMs } = await tunnel.checkIP();
                ctx.ui.notify(`${t('VPN ready', 'VPN готов')}: ${ipText(ip, latencyMs)}. OpenAI/Anthropic/Codex: VPN (SSE).`, 'info');
                break;
              }
            }
          }
        }
      } catch (error) { notifyError(ctx, error); }
      finally {
        busy = false;
        ctx.ui.setStatus('happ', tunnel.running ? `Happ: ${tunnel.label}` : undefined);
      }
    },
  });
}

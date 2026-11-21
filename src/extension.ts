import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { randomUUID } from 'node:crypto';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { ProtectedTransport, installAuthFetch, protectProvider } from './transport.mjs';
import { Tunnel, cleanLabel, downloadSubscription, loadState, saveState } from './core.mjs';
import { resolveRuntime } from './runtime.mjs';

export default function happ(pi: ExtensionAPI) {
  const tunnel = new Tunnel();
  const transport = new ProtectedTransport(tunnel);
  const uninstall = installAuthFetch();
  let busy = false;
  let operation: AbortController | undefined;
  const runOperation = async <T>(ctx: ExtensionContext, title: string, work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    operation = controller;
    try {
      if (ctx.mode !== 'tui') return await work(controller.signal);
      const result = await ctx.ui.custom<{ value?: T; error?: unknown }>((tui, theme, _keys, done) => {
        const loader = new BorderedLoader(tui, theme, title);
        loader.onAbort = () => controller.abort(new DOMException('Операция отменена', 'AbortError'));
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
    operation?.abort(new Error('Сессия завершена'));
    transport.invalidate();
    await tunnel.stop();
    uninstall();
  });
  const checkIP = async (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    try {
      const label = tunnel.label || 'VPN';
      const { ip, latencyMs } = await tunnel.checkIP();
      ctx.ui.notify(`${label}: ${ip} · HTTPS-запрос: ${latencyMs} мс · ${new Date().toLocaleTimeString()}`, 'info');
    } catch (error) {
      ctx.ui.notify(error instanceof Error ? error.message : 'Ошибка проверки IP', 'error');
    }
  };
  pi.registerCommand('happ-diagnostics', {
    description: 'Безопасное состояние Xray без адресов серверов и ключей',
    handler: async (_args, ctx) => {
      ctx.ui.notify(`Xray: ${tunnel.running ? 'запущен' : 'остановлен'} · ${tunnel.diagnostic || 'известных ошибок ядра нет'}`, 'info');
    },
  });
  pi.registerCommand('happ-runtime-install', {
    description: 'Установить или проверить закреплённое ядро Xray без запуска VPN',
    handler: async (_args, ctx) => {
      if (!ctx.hasUI || busy) return;
      busy = true;
      try {
        const binary = await runOperation(ctx, 'Установка Xray…', signal => resolveRuntime(undefined, signal));
        ctx.ui.notify(`Ядро Xray готово: ${binary}`, 'info');
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : 'Ошибка установки Xray', 'error');
      } finally { busy = false; }
    },
  });
  pi.registerCommand('happ-ip-check', {
    description: 'Проверить внешний IP через VPN (icanhazip.com), без прямого fallback',
    handler: async (_args, ctx) => { await checkIP(ctx); },
  });
  pi.registerCommand('happ', {
    description: 'Happ subscriptions, locations, protected OpenAI/Anthropic/Codex transport and IP check',
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
            `Happ · ${tunnel.running ? tunnel.label : 'остановлен'} · ${transport.direct ? 'ПРЯМОЙ режим' : 'VPN обязателен (SSE)'}`, 
            ['Добавить подписку', 'Обновить подписку', 'Выбрать локацию', 'Проверить внешний IP', 'Остановить', 'Переключить прямой/VPN режим', 'Обновить все подписки', 'Удалить подписку', 'Закрыть'],
          );
          if (!action || action === 'Закрыть') break;
          if (action === 'Добавить подписку') {
            const name = await ctx.ui.input('Название подписки');
            if (!name?.trim()) continue;
            const url = await ctx.ui.input('HTTPS URL подписки (секрет; хранится локально, не в сессии)');
            if (!url) continue;
            const profiles = await runOperation(ctx, 'Загрузка подписки…', signal => downloadSubscription(url, signal));
            state.subscriptions.push({ id: randomUUID(), name: cleanLabel(name), url, profiles, updatedAt: new Date().toISOString() });
            await saveState(state);
            ctx.ui.notify(`Импортировано профилей: ${profiles.length}`, 'info');
          } else if (action === 'Проверить внешний IP') {
            await checkIP(ctx);
          } else if (action === 'Переключить прямой/VPN режим') {
            if (transport.direct || await ctx.ui.confirm('Разрешить прямой доступ?', 'OpenAI, Anthropic и Codex будут работать БЕЗ VPN.')) {
              ctx.abort();
              transport.setDirect(!transport.direct);
            }
          } else if (action === 'Обновить все подписки') {
            for (const subscription of state.subscriptions) {
              try {
                subscription.profiles = await runOperation(ctx, 'Обновление подписки…', signal => downloadSubscription(subscription.url, signal));
                subscription.updatedAt = new Date().toISOString();
                await saveState(state);
              } catch (error) {
                if (error instanceof Error && error.name === 'AbortError') throw error;
                ctx.ui.notify(`Не удалось обновить: ${cleanLabel(subscription.name)}`, 'error');
              }
            }
          } else if (action === 'Остановить') {
            ctx.abort();
            transport.invalidate();
            await tunnel.stop();
          } else {
            const labels = state.subscriptions.map((s, i) => `${i + 1}. ${cleanLabel(s.name)} (${s.profiles.length})`);
            if (!labels.length) { ctx.ui.notify('Сначала добавьте подписку', 'info'); continue; }
            const selected = await ctx.ui.select('Подписки', labels);
            if (!selected) continue;
            const index = labels.indexOf(selected);
            const subscription = state.subscriptions[index];
            if (action === 'Обновить подписку') {
              const profiles = await runOperation(ctx, 'Обновление подписки…', signal => downloadSubscription(subscription.url, signal));
              subscription.profiles = profiles;
              subscription.updatedAt = new Date().toISOString();
              await saveState(state);
            } else if (action === 'Удалить подписку') {
              if (await ctx.ui.confirm('Удалить подписку?', cleanLabel(subscription.name))) {
                state.subscriptions.splice(index, 1);
                await saveState(state);
              }
            } else {
              const names = subscription.profiles.map((p, i) => `${i + 1}. ${cleanLabel(p.remarks || 'Без названия')}`);
              const location = await ctx.ui.select('Локация', names);
              if (location) {
                ctx.ui.notify('Запуск Xray и проверка IP…', 'info');
                ctx.abort();
                transport.setDirect(false);
                await runOperation(ctx, 'Подключение VPN (Esc — отмена)…', signal =>
                  tunnel.start(subscription.profiles[names.indexOf(location)], undefined, undefined, signal));
                const { ip, latencyMs } = await tunnel.checkIP();
                ctx.ui.notify(`VPN готов: ${ip} · HTTPS-запрос: ${latencyMs} мс. OpenAI/Anthropic/Codex: VPN (SSE).`, 'info');
              }
            }
          }
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : 'Ошибка Happ', 'error');
      } finally {
        busy = false;
        ctx.ui.setStatus('happ', tunnel.running ? `Happ: ${tunnel.label}` : undefined);
      }
    },
  });
}

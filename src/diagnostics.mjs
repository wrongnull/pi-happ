import { t } from './i18n.mjs';

// Map untrusted Xray output to fixed messages. Never display the raw output.
export function diagnoseXray(text) {
  if (/address already in use|failed to listen/i.test(text)) return t('Xray: local port is in use or unavailable', 'Xray: локальный порт занят или недоступен');
  if (/permission denied|operation not permitted/i.test(text)) return t('Xray: insufficient file or network permissions', 'Xray: недостаточно прав на файл или сетевую операцию');
  if (/unknown (?:protocol|transport)|unsupported|failed to (?:load|build)|invalid config|failed to parse/i.test(text)) return t('Xray: configuration or protocol is not supported by the runtime', 'Xray: конфигурация или протокол не поддерживается ядром');
  if (/certificate|tls handshake|reality.*(?:invalid|failed)/i.test(text)) return t('Xray: TLS/Reality error; check the profile and server clock', 'Xray: ошибка TLS/Reality, проверьте профиль и время сервера');
  if (/no such host|name resolution/i.test(text)) return t('Xray: cannot resolve the VPN server hostname', 'Xray: не удалось разрешить имя VPN-сервера');
  if (/connection refused|network is unreachable|i\/o timeout|connection timed out/i.test(text)) return t('Xray: VPN server is unreachable or the connection timed out', 'Xray: VPN-сервер недоступен или истёк таймаут');
  return undefined;
}

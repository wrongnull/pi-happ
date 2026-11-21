// Map untrusted Xray output to fixed messages. Never display the raw output.
export function diagnoseXray(text) {
  if (/address already in use|failed to listen/i.test(text)) return 'Xray: локальный порт занят или недоступен';
  if (/permission denied|operation not permitted/i.test(text)) return 'Xray: недостаточно прав на файл или сетевую операцию';
  if (/unknown (?:protocol|transport)|unsupported|failed to (?:load|build)|invalid config|failed to parse/i.test(text)) return 'Xray: конфигурация или протокол не поддерживается ядром';
  if (/certificate|tls handshake|reality.*(?:invalid|failed)/i.test(text)) return 'Xray: ошибка TLS/Reality, проверьте профиль и время сервера';
  if (/no such host|name resolution/i.test(text)) return 'Xray: не удалось разрешить имя VPN-сервера';
  if (/connection refused|network is unreachable|i\/o timeout|connection timed out/i.test(text)) return 'Xray: VPN-сервер недоступен или истёк таймаут';
  return undefined;
}

export function detectLanguage(env = process.env) {
  const locale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find(value => value?.trim());
  return /^ru(?:[_\-.@]|$)/i.test(locale?.trim() || '') ? 'ru' : 'en';
}

export const language = detectLanguage();
export const uiLocale = language === 'ru' ? 'ru-RU' : 'en-US';

// Technical errors have stable English source strings; translate at their origin.
export const errors = {
  'Expected a Happ Xray JSON subscription': 'Ожидалась подписка Happ в формате Xray JSON',
  'Invalid or empty Xray profile list': 'Список профилей Xray пуст или некорректен',
  'Subscription download failed (HTTPS only, no redirects, 4 MiB limit), or unsupported format': 'Не удалось загрузить подписку (только HTTPS, без перенаправлений, до 4 МиБ) или формат не поддерживается',
  'Cannot read subscription storage': 'Не удалось прочитать хранилище подписок',
  'No supported proxy outbound': 'Нет поддерживаемого исходящего прокси',
  'Duplicate or invalid outbound tag': 'Повторяющийся или некорректный тег исходящего подключения',
  'Cyclic proxy chain': 'Обнаружен цикл в цепочке прокси',
  'Proxy chain references a direct or unsupported outbound': 'Цепочка прокси ссылается на прямое или неподдерживаемое подключение',
  'Interface-bound profiles are not supported': 'Профили с привязкой к сетевому интерфейсу не поддерживаются',
  'Invalid proxy chain reference': 'Некорректная ссылка в цепочке прокси',
  'Missing proxy chain outbound': 'Не найдено подключение из цепочки прокси',
  'Invalid IP check response': 'Некорректный ответ проверки IP',
  'Xray failed to start; check binary and profile compatibility': 'Xray не запустился; проверьте совместимость ядра и профиля',
  'Tunnel did not pass the external IP check; check VPN server availability': 'Туннель не прошёл проверку внешнего IP; проверьте доступность VPN-сервера',
  'Tunnel is not running': 'Туннель не запущен',
  'IP check through VPN failed; no direct fallback': 'Проверка IP через VPN не удалась; прямой обход запрещён',
  'Automatic Xray installation supports Linux x64/arm64 only; set PI_HAPP_XRAY for a custom binary': 'Автоустановка Xray доступна только для Linux x64/arm64; укажите своё ядро через PI_HAPP_XRAY',
  'Xray download failed': 'Не удалось скачать Xray',
  'Xray archive exceeds 80 MiB limit': 'Архив Xray превышает лимит 80 МиБ',
  'Xray SHA-256 verification failed': 'Проверка SHA-256 архива Xray не пройдена',
  'Verified Xray archive contains no usable binary': 'Проверенный архив Xray не содержит пригодного исполняемого файла',
  'Cannot install Xray cache; remove the damaged version directory and retry': 'Не удалось установить Xray в кеш; удалите повреждённый каталог версии и повторите попытку',
  'PI_HAPP_XRAY is not an executable file': 'PI_HAPP_XRAY не указывает на исполняемый файл',
  'VPN required: connect a location using /happ': 'Требуется VPN: подключите локацию через /happ',
  'Unsupported provider URL': 'Неподдерживаемый URL провайдера',
  'VPN connection changed or stopped': 'VPN-соединение изменено или остановлено',
  'Xray watchdog currently requires Linux': 'Для watchdog Xray требуется Linux',
  'Xray exited before watchdog startup': 'Xray завершился до запуска watchdog',
  'Watchdog startup timed out': 'Истекло время ожидания запуска watchdog',
  'Cannot start Xray watchdog': 'Не удалось запустить watchdog Xray',
  'Xray watchdog exited before readiness': 'Watchdog Xray завершился до готовности',
};

export function t(english, russian = errors[english] || english, selectedLanguage = language) {
  return selectedLanguage === 'ru' ? russian : english;
}

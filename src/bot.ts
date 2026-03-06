import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './utils/env.js';
import { createLogger } from './utils/logger.js';
import { sendTelegram } from './utils/telegram.js';

loadEnv();

const log = createLogger('bot');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const ALLOWED_CHAT = process.env.TELEGRAM_CHAT_ID ?? '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;
const POLL_INTERVAL_MS = 2000;

let lastUpdateId = 0;

// --- Rate Limiting ---
const commandCooldowns = new Map<string, number>(); // command → lastUsedTimestamp (ms)
const llmUsageTimestamps: number[] = []; // timestamps вызовов /llm за последний час

const COOLDOWNS_MS: Record<string, number> = {
  '/start': 30_000,
  '/stop': 30_000,
  '/status': 15_000,
  '/report': 15_000,
  '/health': 15_000,
  '/help': 5_000,
};
const LLM_MAX_PER_HOUR = 5;
const LLM_WINDOW_MS = 60 * 60 * 1000; // 1 час

function checkRateLimit(cmd: string): string | null {
  const now = Date.now();

  // /kill — без ограничений
  if (cmd === '/kill') return null;

  // /llm — лимит 5 вызовов в час
  if (cmd === '/llm') {
    // Удаляем записи старше 1 часа
    const cutoff = now - LLM_WINDOW_MS;
    while (llmUsageTimestamps.length > 0 && llmUsageTimestamps[0]! < cutoff) {
      llmUsageTimestamps.shift();
    }
    const used = llmUsageTimestamps.length;
    const remaining = LLM_MAX_PER_HOUR - used;
    if (remaining <= 0) {
      const oldestMs = llmUsageTimestamps[0]!;
      const nextAvailableMs = oldestMs + LLM_WINDOW_MS - now;
      const nextMinutes = Math.ceil(nextAvailableMs / 60_000);
      return `⏳ Лимит: 5 вызовов/час. Осталось 0. Следующий доступен через ${nextMinutes} мин.`;
    }
    return null;
  }

  // Стандартный cooldown для остальных команд
  const cooldownMs = COOLDOWNS_MS[cmd];
  if (cooldownMs === undefined) return null;

  const lastUsed = commandCooldowns.get(cmd);
  if (lastUsed !== undefined) {
    const elapsed = now - lastUsed;
    if (elapsed < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - elapsed) / 1000);
      return `⏳ Подожди ${waitSec} сек перед повторным использованием команды.`;
    }
  }

  return null;
}

function recordCommandUsage(cmd: string): void {
  const now = Date.now();
  if (cmd === '/llm') {
    llmUsageTimestamps.push(now);
  } else if (cmd !== '/kill') {
    commandCooldowns.set(cmd, now);
  }
}

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number };
    text?: string;
    from?: { id: number; first_name?: string };
  };
}

async function getUpdates(): Promise<TelegramUpdate[]> {
  try {
    const resp = await fetch(`${API_BASE}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`, {
      signal: AbortSignal.timeout(35_000),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { ok: boolean; result: TelegramUpdate[] };
    return data.ok ? data.result : [];
  } catch {
    return [];
  }
}

// Убираем ANSI escape-коды из вывода скриптов
// eslint-disable-next-line no-control-regex
const ANSI_REGEX = /\x1B\[[0-9;]*m/g;
function stripAnsi(str: string): string {
  return str.replace(ANSI_REGEX, '');
}

function runScript(script: string, args: string[] = []): string {
  const result = spawnSync('bash', [`${PROJECT_ROOT}/scripts/${script}`, ...args], {
    timeout: 60_000,
    encoding: 'utf8',
    env: { ...process.env, PATH: process.env.PATH, NO_TELEGRAM: '1' },
  });
  if (result.status !== 0) {
    const msg = (result.stderr ?? result.error?.message ?? 'Unknown error').slice(0, 500);
    return `Ошибка: ${stripAnsi(msg)}`;
  }
  return stripAnsi((result.stdout ?? '').trim());
}

function runTsx(script: string, args: string[] = [], extraEnv?: Record<string, string>): string {
  const result = spawnSync('npx', ['tsx', `${PROJECT_ROOT}/src/${script}`, ...args], {
    timeout: 120_000,
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    env: { ...process.env, PATH: process.env.PATH, ...extraEnv },
  });
  if (result.status !== 0) {
    const msg = (result.stderr ?? result.error?.message ?? 'Unknown error').slice(0, 500);
    return `Ошибка: ${msg}`;
  }
  return (result.stdout ?? '').trim();
}

// Нормализует входной текст к базовой команде для rate limiting
function normalizeToRateLimitKey(raw: string): string {
  if (raw.startsWith('/llm')) return '/llm';
  if (raw === 'запусти крипто' || raw === 'старт') return '/start';
  if (raw === 'стоп крипто' || raw === 'стоп') return '/stop';
  if (raw === 'статус' || raw === 'что с крипто') return '/status';
  if (raw === 'отчёт' || raw === 'отчет') return '/report';
  if (raw === 'аварийная остановка') return '/kill';
  if (raw === 'помощь') return '/help';
  return raw.split(' ')[0] ?? raw;
}

async function handleCommand(_chatId: string, text: string): Promise<void> {
  const cmd = text.toLowerCase().trim();
  const baseCmd = normalizeToRateLimitKey(cmd);

  // Для /llm проверяем rate limit только если есть промпт (иначе вернём подсказку без блокировки)
  const skipRateLimitCheck =
    baseCmd === '/llm' && !cmd.startsWith('/llm ') && !cmd.startsWith('/llm\n');
  if (!skipRateLimitCheck) {
    const rateLimitMsg = checkRateLimit(baseCmd);
    if (rateLimitMsg !== null) {
      log.info('Rate limited', { cmd: baseCmd, message: rateLimitMsg });
      await sendTelegram(rateLimitMsg);
      return;
    }
    // Для /llm запись делается внутри блока (после валидации промпта)
    if (baseCmd !== '/llm') {
      recordCommandUsage(baseCmd);
    }
  }

  if (cmd === '/start' || cmd === 'запусти крипто' || cmd === 'старт') {
    const result = runScript('trading_control.sh', ['start', 'crypto-trader']);
    log.info('Start crypto', { result: result.slice(0, 200) });
    if (result.includes('ALREADY_RUNNING')) {
      await sendTelegram('✅ Крипто-трейдер уже запущен и работает.', 'HTML');
    } else {
      await sendTelegram(
        '🚀 Крипто-трейдер запущен!\nМониторинг каждые 5 мин.\nLLM — только при сигналах.',
        'HTML',
      );
    }
    return;
  }

  if (cmd === '/stop' || cmd === 'стоп крипто' || cmd === 'стоп') {
    const result = runScript('trading_control.sh', ['stop', 'crypto-trader']);
    log.info('Stop crypto', { result: result.slice(0, 200) });
    if (result.includes('ALREADY_STOPPED')) {
      await sendTelegram('ℹ️ Крипто-трейдер уже остановлен.', 'HTML');
    } else {
      await sendTelegram('🛑 Крипто-трейдер остановлен.\nРасход в простое: $0.', 'HTML');
    }
    return;
  }

  if (cmd === '/status' || cmd === 'статус' || cmd === 'что с крипто') {
    await sendTelegram('⏳ Собираю статус...');
    const result = runTsx('trading/crypto/report.ts', ['--format', 'text', '--no-send'], {
      LOG_LEVEL: 'error',
    });
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed, 'HTML');
    return;
  }

  if (cmd === '/report' || cmd === 'отчёт' || cmd === 'отчет') {
    await sendTelegram('⏳ Формирую отчёт...', 'HTML');
    const result = runScript('crypto_report_full.sh');
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed, 'HTML');
    return;
  }

  if (cmd.startsWith('/llm ') || cmd.startsWith('/llm\n')) {
    const prompt = text.slice(4).trim();
    if (!prompt) {
      await sendTelegram('Использование: /llm {ваш вопрос}', 'HTML');
      return;
    }
    // Записываем использование /llm только здесь (промпт валидирован)
    recordCommandUsage('/llm');
    const remainingLlm = LLM_MAX_PER_HOUR - llmUsageTimestamps.length;
    await sendTelegram(`🤔 Думаю... (осталось вызовов в час: ${remainingLlm}/${LLM_MAX_PER_HOUR})`);
    const { chatWithLLM } = await import('./trading/crypto/llm-chat.js');
    const response = await chatWithLLM(prompt);
    const trimmed = response.length > 4000 ? response.slice(0, 4000) + '\n...(обрезано)' : response;
    await sendTelegram(trimmed);
    return;
  }

  if (cmd === '/kill' || cmd === 'аварийная остановка') {
    runTsx('trading/crypto/killswitch.ts', ['--on', '--reason=Manual kill via Telegram']);
    await sendTelegram('🚨 KILL SWITCH АКТИВИРОВАН!\nВсе позиции будут закрыты.', 'HTML');
    return;
  }

  if (cmd === '/health') {
    const healthFile = path.join(PROJECT_ROOT, 'data', 'health.json');
    try {
      const health = JSON.parse(fs.readFileSync(healthFile, 'utf8')) as {
        timestamp: string;
        cycleId: string;
        positions: number;
        balance: number;
        elapsed: string;
      };
      const ageMs = Date.now() - new Date(health.timestamp).getTime();
      const ageSec = Math.round(ageMs / 1000);
      const status = ageSec < 600 ? '✅ Работает' : '⚠️ Возможные проблемы';
      await sendTelegram(
        `${status}\nПоследний цикл: ${ageSec}с назад\nID: ${health.cycleId}\nПозиции: ${health.positions}\nБаланс: $${health.balance}\nВремя цикла: ${health.elapsed}`,
      );
    } catch {
      await sendTelegram('❌ Healthcheck файл не найден. Монитор не запущен?');
    }
    return;
  }

  if (cmd === '/costs') {
    const { formatCostReport } = await import('./trading/crypto/llm-cost-tracker.js');
    const report = formatCostReport();
    await sendTelegram(report);
    return;
  }

  if (cmd === '/help' || cmd === 'помощь') {
    await sendTelegram(
      `📋 <b>Команды:</b>
/start — запустить крипто-трейдер
/stop — остановить
/status — текущий статус
/report — полный отчёт
/health — состояние монитора (последний цикл)
/costs — расходы на LLM (дневные/месячные)
/kill — аварийная остановка (kill switch)
/llm {вопрос} — спросить AI с контекстом трейдера
/help — эта справка`,
      'HTML',
    );
    return;
  }

  // Неизвестная команда
  await sendTelegram(`Не понял команду. Напиши /help для списка команд.`, 'HTML');
}

async function setMenuCommands(): Promise<void> {
  const commands = [
    { command: 'start', description: 'Запустить крипто-трейдер' },
    { command: 'stop', description: 'Остановить крипто-трейдер' },
    { command: 'status', description: 'Текущий статус и позиции' },
    { command: 'report', description: 'Полный отчёт по портфелю' },
    { command: 'health', description: 'Состояние монитора (последний цикл)' },
    { command: 'kill', description: 'Аварийная остановка (kill switch)' },
    { command: 'costs', description: 'Расходы на LLM (дневные/месячные)' },
    { command: 'llm', description: 'Спросить AI (напр: /llm как рынок?)' },
    { command: 'help', description: 'Список команд' },
  ];

  try {
    const resp = await fetch(`${API_BASE}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    if (resp.ok) {
      log.info('Telegram menu commands set');
    } else {
      log.warn('Failed to set menu commands', { status: resp.status });
    }
  } catch (err) {
    log.warn('Failed to set menu commands', { error: (err as Error).message });
  }
}

async function flushOldUpdates(): Promise<void> {
  try {
    const resp = await fetch(`${API_BASE}/getUpdates?offset=-1&limit=1&timeout=0`);
    if (!resp.ok) return;
    const data = (await resp.json()) as { ok: boolean; result: TelegramUpdate[] };
    if (data.ok && data.result.length > 0) {
      lastUpdateId = data.result[data.result.length - 1]!.update_id;
      log.info('Flushed old updates', { lastUpdateId });
    }
  } catch {
    // ignore
  }
}

async function pollLoop(): Promise<void> {
  await setMenuCommands();
  await flushOldUpdates();
  log.info('Bot started, polling for updates...', { chatId: ALLOWED_CHAT });

  while (true) {
    try {
      const updates = await getUpdates();

      for (const upd of updates) {
        lastUpdateId = upd.update_id;

        if (!upd.message?.text) continue;
        const chatId = String(upd.message.chat.id);

        // Проверяем что сообщение от разрешённого пользователя
        if (chatId !== ALLOWED_CHAT) {
          log.warn('Unauthorized message', { chatId, from: upd.message.from?.first_name });
          continue;
        }

        log.info('Received command', {
          text: upd.message.text,
          from: upd.message.from?.first_name,
        });
        await handleCommand(chatId, upd.message.text);
      }
    } catch (err) {
      log.error('Poll error', { error: (err as Error).message });
    }

    // Короткая пауза между poll циклами (getUpdates с timeout=30 уже блокирует)
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// Проверка конфигурации
if (!BOT_TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN not set. Export it before running.');
  process.exit(1);
}
if (!ALLOWED_CHAT) {
  log.error('TELEGRAM_CHAT_ID not set. Export it before running.');
  process.exit(1);
}

// Graceful shutdown
const shutdown = (signal: string) => {
  log.info(`Bot received ${signal}, shutting down...`);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

pollLoop().catch((err) => {
  log.error('Bot crashed', { error: (err as Error).message });
  process.exit(1);
});

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
function stripAnsi(str: string): string {
  return str.replace(/\x1B\[[0-9;]*m/g, '');
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

function runTsx(script: string, args: string[] = []): string {
  const result = spawnSync('npx', ['tsx', `${PROJECT_ROOT}/src/${script}`, ...args], {
    timeout: 120_000,
    encoding: 'utf8',
    cwd: PROJECT_ROOT,
    env: { ...process.env, PATH: process.env.PATH },
  });
  if (result.status !== 0) {
    const msg = (result.stderr ?? result.error?.message ?? 'Unknown error').slice(0, 500);
    return `Ошибка: ${msg}`;
  }
  return (result.stdout ?? '').trim();
}

async function handleCommand(_chatId: string, text: string): Promise<void> {
  const cmd = text.toLowerCase().trim();

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
    const result = runTsx('trading/crypto/report.ts', ['--format', 'text', '--no-send']);
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed);
    return;
  }

  if (cmd === '/report' || cmd === 'отчёт' || cmd === 'отчет') {
    await sendTelegram('⏳ Формирую отчёт...', 'HTML');
    const result = runScript('crypto_report_full.sh');
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed);
    return;
  }

  if (cmd === '/kill' || cmd === 'аварийная остановка') {
    runTsx('trading/crypto/killswitch.ts', ['--on', '--reason=Manual kill via Telegram']);
    await sendTelegram('🚨 KILL SWITCH АКТИВИРОВАН!\nВсе позиции будут закрыты.', 'HTML');
    return;
  }

  if (cmd === '/help' || cmd === 'помощь') {
    await sendTelegram(
      `📋 <b>Команды:</b>
/start — запустить крипто-трейдер
/stop — остановить
/status — текущий статус
/report — полный отчёт
/kill — аварийная остановка (kill switch)
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
    { command: 'kill', description: 'Аварийная остановка (kill switch)' },
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

  // eslint-disable-next-line no-constant-condition
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

pollLoop().catch((err) => {
  log.error('Bot crashed', { error: (err as Error).message });
  process.exit(1);
});

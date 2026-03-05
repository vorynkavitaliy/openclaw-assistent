import { execSync } from 'node:child_process';
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

function runScript(script: string, args: string = ''): string {
  try {
    return execSync(`bash ${PROJECT_ROOT}/scripts/${script} ${args}`, {
      timeout: 60_000,
      encoding: 'utf8',
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (err) {
    const msg =
      err instanceof Error ? ((err as { stderr?: string }).stderr ?? err.message) : String(err);
    return `Ошибка: ${msg.slice(0, 500)}`;
  }
}

function runTsx(script: string, args: string = ''): string {
  try {
    return execSync(`npx tsx ${PROJECT_ROOT}/src/${script} ${args}`, {
      timeout: 120_000,
      encoding: 'utf8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, PATH: process.env.PATH },
    }).trim();
  } catch (err) {
    const msg =
      err instanceof Error ? ((err as { stderr?: string }).stderr ?? err.message) : String(err);
    return `Ошибка: ${msg.slice(0, 500)}`;
  }
}

async function handleCommand(_chatId: string, text: string): Promise<void> {
  const cmd = text.toLowerCase().trim();

  if (cmd === '/start' || cmd === 'запусти крипто' || cmd === 'старт') {
    await sendTelegram('⏳ Запускаю крипто-трейдер...', 'HTML');
    const result = runScript('trading_control.sh', 'start crypto-trader');
    log.info('Start crypto', { result: result.slice(0, 200) });
    await sendTelegram(
      '🚀 Крипто-трейдер запущен!\nМониторинг каждые 5 мин.\nLLM — только при сигналах.',
      'HTML',
    );
    return;
  }

  if (cmd === '/stop' || cmd === 'стоп крипто' || cmd === 'стоп') {
    await sendTelegram('⏳ Останавливаю крипто-трейдер...', 'HTML');
    const result = runScript('trading_control.sh', 'stop crypto-trader');
    log.info('Stop crypto', { result: result.slice(0, 200) });
    await sendTelegram('🛑 Крипто-трейдер остановлен.\nРасход в простое: $0.', 'HTML');
    return;
  }

  if (cmd === '/status' || cmd === 'статус' || cmd === 'что с крипто') {
    await sendTelegram('⏳ Собираю статус...', 'HTML');
    const result = runScript('crypto_report_full.sh');
    // Отправляем как есть, ограничивая длину
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed, 'HTML');
    return;
  }

  if (cmd === '/report' || cmd === 'отчёт' || cmd === 'отчет') {
    await sendTelegram('⏳ Формирую отчёт...', 'HTML');
    const result = runTsx('trading/crypto/report.ts', '--format text');
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed, 'Markdown');
    return;
  }

  if (cmd === '/kill' || cmd === 'аварийная остановка') {
    runTsx('trading/crypto/killswitch.ts', '--on --reason="Manual kill via Telegram"');
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

async function pollLoop(): Promise<void> {
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
  console.error('TELEGRAM_BOT_TOKEN not set. Export it before running.');
  process.exit(1);
}
if (!ALLOWED_CHAT) {
  console.error('TELEGRAM_CHAT_ID not set. Export it before running.');
  process.exit(1);
}

pollLoop().catch((err) => {
  log.error('Bot crashed', { error: (err as Error).message });
  process.exit(1);
});

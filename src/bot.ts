import path from 'node:path';
import { spawnSync } from 'node:child_process';
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

let lastUpdateId = 0;

// --- Rate Limiting ---
const CLAUDE_MAX_PER_HOUR = 50;
const CLAUDE_WINDOW_MS = 60 * 60 * 1000;
const claudeUsageTimestamps: number[] = [];

function checkClaudeRateLimit(): string | null {
  const now = Date.now();
  const cutoff = now - CLAUDE_WINDOW_MS;
  while (claudeUsageTimestamps.length > 0 && claudeUsageTimestamps[0]! < cutoff) {
    claudeUsageTimestamps.shift();
  }
  if (claudeUsageTimestamps.length >= CLAUDE_MAX_PER_HOUR) {
    const oldestMs = claudeUsageTimestamps[0]!;
    const nextMinutes = Math.ceil((oldestMs + CLAUDE_WINDOW_MS - now) / 60_000);
    return `Лимит: ${CLAUDE_MAX_PER_HOUR} вызовов/час. Следующий через ${nextMinutes} мин.`;
  }
  return null;
}

function recordClaudeUsage(): void {
  claudeUsageTimestamps.push(Date.now());
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

// ── Kill Switch (единственная хардкодированная команда) ──

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

async function cmdStopKill(): Promise<void> {
  runTsx('trading/crypto/killswitch.ts', ['--on', '--reason=Manual kill via Telegram']);
  runTsx('trading/forex/killswitch.ts', ['--on', '--reason=Manual kill via Telegram']);
  runScript('trading_control.sh', ['stop', 'all']);
  await sendTelegram(
    '🚨 <b>KILL SWITCH + ПОЛНАЯ ОСТАНОВКА</b>\nВсе позиции закрыты (крипто + форекс).\nВсе трейдеры остановлены.\nCron удалён.',
    'HTML',
  );
}

// ── Message handling ──

async function handleMessage(text: string): Promise<void> {
  const lower = text.toLowerCase().trim();

  // /stop_kill — аварийная остановка, всегда работает без AI
  if (lower === '/stop_kill' || lower === 'аварийная остановка') {
    await cmdStopKill();
    return;
  }

  // /claude_reset — сброс сессии
  if (lower === '/claude_reset') {
    const { resetClaudeSession } = await import('./utils/claude-cli.js');
    resetClaudeSession();
    await sendTelegram('Сессия Claude Code сброшена.');
    return;
  }

  // Всё остальное → Claude Code
  const rateLimitMsg = checkClaudeRateLimit();
  if (rateLimitMsg !== null) {
    await sendTelegram(rateLimitMsg);
    return;
  }
  recordClaudeUsage();

  try {
    const { runClaudeCli } = await import('./utils/claude-cli.js');
    await runClaudeCli(text);
  } catch (err) {
    await sendTelegram(`Ошибка Claude Code: ${(err as Error).message}`);
  }
}

// ── Telegram menu ──

async function setMenuCommands(): Promise<void> {
  const commands = [
    { command: 'stop_kill', description: '🚨 Аварийная остановка (kill switch)' },
    { command: 'claude_reset', description: 'Сбросить контекст Claude' },
  ];

  try {
    await fetch(`${API_BASE}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
  } catch {
    // best effort
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

// ── Poll loop ──

async function pollLoop(): Promise<void> {
  await setMenuCommands();
  await flushOldUpdates();
  log.info('Bot started (Claude Code mode)', { chatId: ALLOWED_CHAT });

  while (true) {
    try {
      const updates = await getUpdates();

      for (const upd of updates) {
        lastUpdateId = upd.update_id;
        if (!upd.message?.text) continue;

        const chatId = String(upd.message.chat.id);
        if (chatId !== ALLOWED_CHAT) {
          log.warn('Unauthorized', { chatId });
          continue;
        }

        log.info('Message', { text: upd.message.text, from: upd.message.from?.first_name });
        await handleMessage(upd.message.text);
      }
    } catch (err) {
      log.error('Poll error', { error: (err as Error).message });
    }

    await new Promise((r) => setTimeout(r, 2000));
  }
}

if (!BOT_TOKEN) {
  log.error('TELEGRAM_BOT_TOKEN not set');
  process.exit(1);
}
if (!ALLOWED_CHAT) {
  log.error('TELEGRAM_CHAT_ID not set');
  process.exit(1);
}

const shutdown = (signal: string) => {
  log.info(`Bot ${signal}, shutting down`);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

pollLoop().catch((err) => {
  log.error('Bot crashed', { error: (err as Error).message });
  process.exit(1);
});

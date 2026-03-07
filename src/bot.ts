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
const commandCooldowns = new Map<string, number>();
const llmUsageTimestamps: number[] = [];

const COOLDOWNS_MS: Record<string, number> = {
  '/start_crypto': 30_000,
  '/start_forex': 30_000,
  '/start_all': 30_000,
  '/stop_crypto': 30_000,
  '/stop_forex': 30_000,
  '/stop_all': 30_000,
  '/stop_kill': 5_000,
  '/status': 15_000,
  '/status_crypto': 15_000,
  '/status_forex': 15_000,
  '/report': 15_000,
  '/report_crypto': 15_000,
  '/report_forex': 15_000,
  '/health': 15_000,
  '/help': 5_000,
};
const LLM_MAX_PER_HOUR = 5;
const LLM_WINDOW_MS = 60 * 60 * 1000;
const CLAUDE_MAX_PER_HOUR = 50;
const claudeUsageTimestamps: number[] = [];

function checkRateLimit(cmd: string): string | null {
  const now = Date.now();

  if (cmd === '/stop_kill') return null;

  if (cmd === '/llm') {
    const cutoff = now - LLM_WINDOW_MS;
    while (llmUsageTimestamps.length > 0 && llmUsageTimestamps[0]! < cutoff) {
      llmUsageTimestamps.shift();
    }
    const remaining = LLM_MAX_PER_HOUR - llmUsageTimestamps.length;
    if (remaining <= 0) {
      const oldestMs = llmUsageTimestamps[0]!;
      const nextMinutes = Math.ceil((oldestMs + LLM_WINDOW_MS - now) / 60_000);
      return `⏳ Лимит: 5 вызовов/час. Осталось 0. Следующий через ${nextMinutes} мин.`;
    }
    return null;
  }

  if (cmd === '/claude') {
    const cutoff = now - LLM_WINDOW_MS;
    while (claudeUsageTimestamps.length > 0 && claudeUsageTimestamps[0]! < cutoff) {
      claudeUsageTimestamps.shift();
    }
    const remaining = CLAUDE_MAX_PER_HOUR - claudeUsageTimestamps.length;
    if (remaining <= 0) {
      const oldestMs = claudeUsageTimestamps[0]!;
      const nextMinutes = Math.ceil((oldestMs + LLM_WINDOW_MS - now) / 60_000);
      return `⏳ Лимит: ${CLAUDE_MAX_PER_HOUR} вызовов/час. Следующий через ${nextMinutes} мин.`;
    }
    return null;
  }

  const cooldownMs = COOLDOWNS_MS[cmd];
  if (cooldownMs === undefined) return null;

  const lastUsed = commandCooldowns.get(cmd);
  if (lastUsed !== undefined) {
    const elapsed = now - lastUsed;
    if (elapsed < cooldownMs) {
      const waitSec = Math.ceil((cooldownMs - elapsed) / 1000);
      return `⏳ Подожди ${waitSec} сек.`;
    }
  }

  return null;
}

function recordCommandUsage(cmd: string): void {
  const now = Date.now();
  if (cmd === '/llm') {
    llmUsageTimestamps.push(now);
  } else if (cmd === '/claude') {
    claudeUsageTimestamps.push(now);
  } else if (cmd !== '/stop_kill') {
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

// ── Helpers ──

function cronStatus(agent: 'crypto-trader' | 'forex-trader'): 'running' | 'stopped' {
  const tag = agent === 'crypto-trader' ? 'openclaw-crypto-monitor' : 'openclaw-forex-monitor';
  const result = spawnSync('crontab', ['-l'], { encoding: 'utf8', timeout: 5_000 });
  return (result.stdout ?? '').includes(tag) ? 'running' : 'stopped';
}

function killSwitchActive(): boolean {
  return fs.existsSync(path.join(PROJECT_ROOT, 'data', 'KILL_SWITCH'));
}

function removeKillSwitch(): void {
  const ksFile = path.join(PROJECT_ROOT, 'data', 'KILL_SWITCH');
  if (fs.existsSync(ksFile)) fs.unlinkSync(ksFile);
}

// ── Start / Stop handlers ──

async function cmdStartCrypto(): Promise<void> {
  if (killSwitchActive()) removeKillSwitch();
  const result = runScript('trading_control.sh', ['start', 'crypto-trader']);
  if (result.includes('ALREADY_RUNNING')) {
    await sendTelegram('✅ Крипто-трейдер уже запущен.', 'HTML');
  } else {
    await sendTelegram(
      '🚀 <b>Крипто-трейдер запущен!</b>\nМониторинг: */5 мин\nSL-Guard: */1 мин',
      'HTML',
    );
  }
}

async function cmdStartForex(): Promise<void> {
  const result = runScript('trading_control.sh', ['start', 'forex-trader']);
  if (result.includes('ALREADY_RUNNING')) {
    await sendTelegram('✅ Форекс-трейдер уже запущен.', 'HTML');
  } else {
    await sendTelegram('🚀 <b>Форекс-трейдер запущен!</b>\nМониторинг: */10 мин', 'HTML');
  }
}

async function cmdStopCrypto(): Promise<void> {
  const result = runScript('trading_control.sh', ['stop', 'crypto-trader']);
  if (result.includes('ALREADY_STOPPED')) {
    await sendTelegram('ℹ️ Крипто-трейдер уже остановлен.', 'HTML');
  } else {
    await sendTelegram('🛑 Крипто-трейдер остановлен.', 'HTML');
  }
}

async function cmdStopForex(): Promise<void> {
  const result = runScript('trading_control.sh', ['stop', 'forex-trader']);
  if (result.includes('ALREADY_STOPPED')) {
    await sendTelegram('ℹ️ Форекс-трейдер уже остановлен.', 'HTML');
  } else {
    await sendTelegram('🛑 Форекс-трейдер остановлен.', 'HTML');
  }
}

async function cmdStopAll(): Promise<void> {
  runScript('trading_control.sh', ['stop', 'all']);
  await sendTelegram('🛑 Все трейдеры остановлены.', 'HTML');
}

async function cmdStartAll(): Promise<void> {
  if (killSwitchActive()) removeKillSwitch();
  runScript('trading_control.sh', ['start', 'crypto-trader']);
  runScript('trading_control.sh', ['start', 'forex-trader']);
  await sendTelegram(
    '🚀 <b>Все трейдеры запущены!</b>\nКрипто: */5 мин + SL-Guard */1 мин\nФорекс: */10 мин',
    'HTML',
  );
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

// ── Status / Report handlers ──

async function cmdStatusCrypto(): Promise<void> {
  await sendTelegram('⏳ Крипто статус...');
  const result = runTsx('trading/crypto/report.ts', ['--format', 'text', '--no-send'], {
    LOG_LEVEL: 'error',
  });
  const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
  await sendTelegram(trimmed, 'HTML');
}

async function cmdStatusForex(): Promise<void> {
  await sendTelegram('⏳ Форекс статус...');
  const result = runTsx('trading/forex/report.ts', ['--no-send'], { LOG_LEVEL: 'error' });
  if (result.startsWith('Ошибка')) {
    await sendTelegram('ℹ️ Форекс-модуль: report.ts ещё не реализован.', 'HTML');
  } else {
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed, 'HTML');
  }
}

async function cmdStatusAll(): Promise<void> {
  const crypto = cronStatus('crypto-trader');
  const forex = cronStatus('forex-trader');
  const cryptoKs = killSwitchActive();
  const forexKs = fs.existsSync(path.join(PROJECT_ROOT, 'data', 'FOREX_KILL_SWITCH'));

  let msg = '<b>Общий статус</b>\n\n';
  msg += `Крипто: ${crypto === 'running' ? '🟢 работает' : '🔴 остановлен'}`;
  if (cryptoKs) msg += ' 🚨 KILL';
  msg += `\nФорекс: ${forex === 'running' ? '🟢 работает' : '🔴 остановлен'}`;
  if (forexKs) msg += ' 🚨 KILL';

  // Crypto health
  const cryptoHealthFile = path.join(PROJECT_ROOT, 'data', 'health.json');
  try {
    const h = JSON.parse(fs.readFileSync(cryptoHealthFile, 'utf8')) as {
      timestamp: string;
      positions: number;
      balance: number;
      elapsed: string;
    };
    const ageSec = Math.round((Date.now() - new Date(h.timestamp).getTime()) / 1000);
    msg += `\n\n<b>Крипто</b>: ${ageSec}с назад | ${h.positions} поз | $${h.balance}`;
  } catch {
    // no health
  }

  // Forex health
  const forexHealthFile = path.join(PROJECT_ROOT, 'data', 'forex-health.json');
  try {
    const h = JSON.parse(fs.readFileSync(forexHealthFile, 'utf8')) as {
      timestamp: string;
      positions: number;
      balance: number;
      elapsed: string;
    };
    const ageSec = Math.round((Date.now() - new Date(h.timestamp).getTime()) / 1000);
    msg += `\n<b>Форекс</b>: ${ageSec}с назад | ${h.positions} поз | $${h.balance}`;
  } catch {
    // no health
  }

  await sendTelegram(msg, 'HTML');
}

async function cmdReportCrypto(): Promise<void> {
  await sendTelegram('⏳ Крипто отчёт...');
  const result = runScript('crypto_report_full.sh');
  const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
  await sendTelegram(trimmed, 'HTML');
}

async function cmdReportForex(): Promise<void> {
  await sendTelegram('⏳ Форекс отчёт...');
  const result = runTsx('trading/forex/report.ts', [], { LOG_LEVEL: 'error' });
  if (result.startsWith('Ошибка')) {
    await sendTelegram('ℹ️ Форекс report.ts ещё не реализован.', 'HTML');
  } else {
    const trimmed = result.length > 4000 ? result.slice(0, 4000) + '\n...(обрезано)' : result;
    await sendTelegram(trimmed, 'HTML');
  }
}

async function cmdReportAll(): Promise<void> {
  await cmdStatusAll();
  await cmdReportCrypto();
}

// ── Command routing ──

type CmdHandler = () => Promise<void>;

const COMMANDS: Record<string, CmdHandler> = {
  // Start
  '/start_crypto': cmdStartCrypto,
  '/start_forex': cmdStartForex,
  '/start_all': cmdStartAll,

  // Stop
  '/stop_crypto': cmdStopCrypto,
  '/stop_forex': cmdStopForex,
  '/stop_all': cmdStopAll,
  '/stop_kill': cmdStopKill,

  // Status
  '/status': cmdStatusAll,
  '/status_crypto': cmdStatusCrypto,
  '/status_forex': cmdStatusForex,

  // Report
  '/report': cmdReportAll,
  '/report_crypto': cmdReportCrypto,
  '/report_forex': cmdReportForex,
};

// Русские алиасы → команда
const ALIASES: Record<string, string> = {
  'старт крипто': '/start_crypto',
  'старт форекс': '/start_forex',
  'старт все': '/start_all',
  'стоп крипто': '/stop_crypto',
  'стоп форекс': '/stop_forex',
  'стоп все': '/stop_all',
  'аварийная остановка': '/stop_kill',
  статус: '/status',
  'статус крипто': '/status_crypto',
  'статус форекс': '/status_forex',
  отчёт: '/report',
  отчет: '/report',
  'отчёт крипто': '/report_crypto',
  'отчет крипто': '/report_crypto',
  'отчёт форекс': '/report_forex',
  'отчет форекс': '/report_forex',
  помощь: '/help',
};

function resolveCommand(raw: string): string {
  const lower = raw.toLowerCase().trim();
  if (ALIASES[lower]) return ALIASES[lower];
  if (lower.startsWith('/llm')) return '/llm';
  if (lower === '/claude_reset') return '/claude_reset';
  if (lower.startsWith('/claude')) return '/claude';
  return lower.split(' ')[0] ?? lower;
}

async function handleCommand(_chatId: string, text: string): Promise<void> {
  const cmd = resolveCommand(text);

  // /llm — special handling
  if (cmd === '/llm') {
    const prompt = text.slice(4).trim();
    if (!prompt) {
      await sendTelegram('Использование: /llm {ваш вопрос}', 'HTML');
      return;
    }
    const rateLimitMsg = checkRateLimit('/llm');
    if (rateLimitMsg !== null) {
      await sendTelegram(rateLimitMsg);
      return;
    }
    recordCommandUsage('/llm');
    const remainingLlm = LLM_MAX_PER_HOUR - llmUsageTimestamps.length;
    await sendTelegram(`🤔 Думаю... (${remainingLlm}/${LLM_MAX_PER_HOUR} осталось)`);
    const { chatWithLLM } = await import('./trading/crypto/llm-chat.js');
    const response = await chatWithLLM(prompt);
    const trimmed = response.length > 4000 ? response.slice(0, 4000) + '\n...(обрезано)' : response;
    await sendTelegram(trimmed);
    return;
  }

  // /claude — запуск Claude Code CLI (стриминг + сессия)
  if (cmd === '/claude') {
    const prompt = text.slice(7).trim();
    if (!prompt) {
      await sendTelegram(
        `Использование: /claude {задание}

Примеры:
/claude покажи последние сигналы
/claude почему бот не торгует?
/claude измени риск на 2% для крипто
/claude перезапусти бота
/claude добавь пару DOGEUSDT в конфиг

Сессия сохраняется между вызовами.
/claude_reset — сбросить контекст.`,
        'HTML',
      );
      return;
    }
    const rateLimitMsg = checkRateLimit('/claude');
    if (rateLimitMsg !== null) {
      await sendTelegram(rateLimitMsg);
      return;
    }
    recordCommandUsage('/claude');
    try {
      // runClaudeCli сам отправляет и стримит сообщения в Telegram
      const { runClaudeCli } = await import('./utils/claude-cli.js');
      await runClaudeCli(prompt);
    } catch (err) {
      await sendTelegram(`Ошибка Claude Code: ${(err as Error).message}`);
    }
    return;
  }

  // /claude_reset — сбросить сессию Claude Code
  if (cmd === '/claude_reset') {
    const { resetClaudeSession } = await import('./utils/claude-cli.js');
    resetClaudeSession();
    await sendTelegram('Сессия Claude Code сброшена. Следующий /claude начнёт новый диалог.');
    return;
  }

  // /costs
  if (cmd === '/costs') {
    const rateLimitMsg = checkRateLimit(cmd);
    if (rateLimitMsg !== null) {
      await sendTelegram(rateLimitMsg);
      return;
    }
    recordCommandUsage(cmd);
    const { formatCostReport } = await import('./trading/crypto/llm-cost-tracker.js');
    await sendTelegram(formatCostReport());
    return;
  }

  // /health (legacy, maps to /status)
  if (cmd === '/health') {
    await cmdStatusAll();
    return;
  }

  // /help
  if (cmd === '/help') {
    const rateLimitMsg = checkRateLimit('/help');
    if (rateLimitMsg !== null) {
      await sendTelegram(rateLimitMsg);
      return;
    }
    recordCommandUsage('/help');
    await sendTelegram(
      `📋 <b>Команды</b>

<b>Запуск</b>
/start_crypto — запустить крипто
/start_forex — запустить форекс
/start_all — запустить всё

<b>Остановка</b>
/stop_crypto — остановить крипто
/stop_forex — остановить форекс
/stop_all — остановить всё
/stop_kill — 🚨 kill switch + стоп всего

<b>Статус</b>
/status — общий статус
/status_crypto — крипто статус
/status_forex — форекс статус

<b>Отчёт</b>
/report — полный отчёт
/report_crypto — крипто отчёт
/report_forex — форекс отчёт

<b>Прочее</b>
/costs — расходы на LLM
/llm {вопрос} — спросить AI (быстро, Sonnet)
/claude {задание} — Claude Code (стриминг, сессия)
/claude_reset — сбросить контекст Claude
/help — эта справка`,
      'HTML',
    );
    return;
  }

  // Routed commands
  const handler = COMMANDS[cmd];
  if (handler) {
    const rateLimitMsg = checkRateLimit(cmd);
    if (rateLimitMsg !== null) {
      await sendTelegram(rateLimitMsg);
      return;
    }
    recordCommandUsage(cmd);
    await handler();
    return;
  }

  // Любой текст без команды → Claude Code
  const rateLimitMsg = checkRateLimit('/claude');
  if (rateLimitMsg !== null) {
    await sendTelegram(rateLimitMsg);
    return;
  }
  recordCommandUsage('/claude');
  try {
    const { runClaudeCli } = await import('./utils/claude-cli.js');
    await runClaudeCli(text);
  } catch (err) {
    await sendTelegram(`Ошибка Claude Code: ${(err as Error).message}`);
  }
}

async function setMenuCommands(): Promise<void> {
  const commands = [
    { command: 'start_crypto', description: 'Запустить крипто-трейдер' },
    { command: 'start_forex', description: 'Запустить форекс-трейдер' },
    { command: 'start_all', description: 'Запустить всё' },
    { command: 'stop_crypto', description: 'Остановить крипто' },
    { command: 'stop_forex', description: 'Остановить форекс' },
    { command: 'stop_all', description: 'Остановить всё' },
    { command: 'stop_kill', description: '🚨 Kill switch + стоп' },
    { command: 'status', description: 'Общий статус' },
    { command: 'status_crypto', description: 'Крипто статус' },
    { command: 'status_forex', description: 'Форекс статус' },
    { command: 'report', description: 'Полный отчёт' },
    { command: 'report_crypto', description: 'Крипто отчёт' },
    { command: 'report_forex', description: 'Форекс отчёт' },
    { command: 'costs', description: 'Расходы на LLM' },
    { command: 'llm', description: 'Спросить AI (/llm вопрос)' },
    { command: 'claude', description: 'Claude Code (/claude задание)' },
    { command: 'claude_reset', description: 'Сбросить контекст Claude' },
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

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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
  log.info(`Bot received ${signal}, shutting down...`);
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

pollLoop().catch((err) => {
  log.error('Bot crashed', { error: (err as Error).message });
  process.exit(1);
});

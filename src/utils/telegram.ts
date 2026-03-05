import { createLogger } from './logger.js';
import { retryAsync } from './retry.js';

const log = createLogger('telegram');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';
const CHAT_ID = process.env.TELEGRAM_CHAT_ID ?? '';
const API_BASE = `https://api.telegram.org/bot${BOT_TOKEN}`;

/**
 * Отправить сообщение в Telegram напрямую через Bot API.
 */
export async function sendTelegram(
  message: string,
  parseMode: 'HTML' | 'Markdown' = 'Markdown',
): Promise<boolean> {
  if (!BOT_TOKEN || !CHAT_ID) {
    log.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping send');
    return false;
  }

  try {
    const resp = await retryAsync(
      () =>
        fetch(`${API_BASE}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: message,
            parse_mode: parseMode,
          }),
          signal: AbortSignal.timeout(10_000),
        }),
      { retries: 2, backoffMs: 500 },
    );

    if (!resp.ok) {
      const text = await resp.text();
      log.error(`Telegram send failed: HTTP ${resp.status}`, { body: text.slice(0, 200) });
      return false;
    }

    log.debug('Message sent to Telegram');
    return true;
  } catch (err) {
    log.error('Failed to send Telegram message', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// Обратная совместимость — старое имя функции
export const sendViaOpenClaw = sendTelegram;

export function fmt(val: number | string, decimals: number = 2): string {
  const n = typeof val === 'string' ? parseFloat(val) : val;
  if (isNaN(n)) return '0.00';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPrice(val: number): string {
  if (val >= 1000)
    return val.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  if (val >= 1)
    return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return val.toLocaleString('en-US', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

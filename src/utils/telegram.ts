import { createLogger } from './logger.js';
import { retryAsync } from './retry.js';

const log = createLogger('telegram');

function getToken(): string {
  return process.env.TELEGRAM_BOT_TOKEN ?? '';
}

function getChatId(): string {
  return process.env.TELEGRAM_CHAT_ID ?? '';
}

/**
 * Отправить сообщение в Telegram напрямую через Bot API.
 */
export async function sendTelegram(
  message: string,
  parseMode: 'HTML' | 'Markdown' = 'Markdown',
): Promise<boolean> {
  const token = getToken();
  const chatId = getChatId();

  if (!token || !chatId) {
    log.warn('TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping send');
    return false;
  }

  try {
    const resp = await retryAsync(
      () =>
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
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

/**
 * Отправить сообщение и вернуть message_id (для последующего редактирования).
 */
export async function sendTelegramWithId(
  message: string,
  parseMode: 'HTML' | 'Markdown' = 'Markdown',
): Promise<number | null> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) return null;

  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: parseMode }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { ok: boolean; result?: { message_id: number } };
    return data.result?.message_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Редактировать существующее сообщение по message_id.
 * При ошибке Markdown парсинга — повторяет без parse_mode (plain text).
 */
export async function editTelegramMessage(
  messageId: number,
  text: string,
  parseMode: 'HTML' | 'Markdown' | null = null,
): Promise<boolean> {
  const token = getToken();
  const chatId = getChatId();
  if (!token || !chatId) return false;

  const truncated = text.slice(0, 4096);

  try {
    const body: Record<string, unknown> = {
      chat_id: chatId,
      message_id: messageId,
      text: truncated,
    };
    if (parseMode) body.parse_mode = parseMode;

    const resp = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!resp.ok && parseMode) {
      // Fallback: повтор без parse_mode (Markdown символы в тексте Claude)
      const fallback = await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text: truncated }),
        signal: AbortSignal.timeout(10_000),
      });
      return fallback.ok;
    }

    return resp.ok;
  } catch {
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

/**
 * Telegram helpers — отправка сообщений через OpenClaw Gateway.
 */

import { createLogger } from './logger.js';

const log = createLogger('telegram');

const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789';

/**
 * Отправить сообщение через OpenClaw Gateway HTTP API.
 *
 * @param message - текст сообщения
 * @param agentId - ID агента-отправителя (по умолчанию 'crypto-trader')
 */
export async function sendViaOpenClaw(
  message: string,
  agentId: string = 'crypto-trader',
): Promise<boolean> {
  try {
    const resp = await fetch(`${GATEWAY_URL}/api/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent: agentId,
        message,
        channel: 'telegram',
      }),
    });

    if (!resp.ok) {
      log.error(`Ошибка отправки: HTTP ${resp.status}`, { status: resp.status });
      return false;
    }

    log.info('Сообщение отправлено в Telegram');
    return true;
  } catch (err) {
    log.error('Не удалось отправить сообщение', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Форматировать число для отображения.
 */
export function fmt(val: number, decimals: number = 2): string {
  return val.toFixed(decimals);
}

/**
 * Форматировать цену с автоопределением точности.
 */
export function fmtPrice(val: number): string {
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

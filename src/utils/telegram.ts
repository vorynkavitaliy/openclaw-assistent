import { createLogger } from './logger.js';
import { retryAsync } from './retry.js';

const log = createLogger('telegram');
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789';

export async function sendViaOpenClaw(
  message: string,
  agentId: string = 'crypto-trader',
): Promise<boolean> {
  try {
    const resp = await retryAsync(
      () =>
        fetch(`${GATEWAY_URL}/api/send-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agent: agentId, message, channel: 'telegram' }),
        }),
      { retries: 2, backoffMs: 500 },
    );

    if (!resp.ok) {
      log.error(`Send failed: HTTP ${resp.status}`, { status: resp.status });
      return false;
    }

    log.info('Message sent to Telegram');
    return true;
  } catch (err) {
    log.error('Failed to send message', {
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

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

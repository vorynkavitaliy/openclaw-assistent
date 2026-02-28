import { createLogger } from './logger.js';

const log = createLogger('telegram');
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL ?? 'http://127.0.0.1:18789';

export async function sendViaOpenClaw(
  message: string,
  agentId: string = 'crypto-trader',
): Promise<boolean> {
  try {
    const resp = await fetch(`${GATEWAY_URL}/api/send-message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: agentId, message, channel: 'telegram' }),
    });

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

export function fmt(val: number, decimals: number = 2): string {
  return val.toFixed(decimals);
}

export function fmtPrice(val: number): string {
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);

  return val.toFixed(6);
}

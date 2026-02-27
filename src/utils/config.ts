/**
 * Загрузка credentials и конфигурации.
 * Читает из ~/.openclaw/credentials.json и env vars.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface BybitCredentials {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  demoTrading: boolean;
}

export interface OandaCredentials {
  token: string;
  accountId: string;
  practice: boolean;
}

interface CredentialsFile {
  bybit?: {
    apiKey?: string;
    apiSecret?: string;
    testnet?: boolean;
    demoTrading?: boolean;
  };
  oanda?: {
    token?: string;
    accountId?: string;
    practice?: boolean;
  };
}

const CREDENTIALS_PATH = path.join(process.env.HOME ?? '/root', '.openclaw', 'credentials.json');

let _cache: CredentialsFile | null = null;

function loadCredentialsFile(): CredentialsFile {
  if (_cache) return _cache;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    return {};
  }

  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    _cache = JSON.parse(raw) as CredentialsFile;
    return _cache;
  } catch {
    console.error(`[config] Ошибка чтения credentials из ${CREDENTIALS_PATH}`);
    return {};
  }
}

/**
 * Загрузить Bybit credentials.
 * Приоритет: env vars > credentials.json
 */
export function getBybitCredentials(): BybitCredentials {
  const file = loadCredentialsFile();

  return {
    apiKey: process.env.BYBIT_API_KEY ?? file.bybit?.apiKey ?? '',
    apiSecret: process.env.BYBIT_API_SECRET ?? file.bybit?.apiSecret ?? '',
    testnet:
      process.env.BYBIT_TESTNET !== undefined
        ? process.env.BYBIT_TESTNET.toLowerCase() === 'true'
        : (file.bybit?.testnet ?? false),
    demoTrading:
      process.env.BYBIT_DEMO_TRADING !== undefined
        ? process.env.BYBIT_DEMO_TRADING.toLowerCase() === 'true'
        : (file.bybit?.demoTrading ?? true),
  };
}

/**
 * Загрузить OANDA credentials.
 */
export function getOandaCredentials(): OandaCredentials {
  const file = loadCredentialsFile();

  return {
    token: process.env.OANDA_TOKEN ?? file.oanda?.token ?? '',
    accountId: process.env.OANDA_ACCOUNT_ID ?? file.oanda?.accountId ?? '',
    practice:
      process.env.OANDA_PRACTICE !== undefined
        ? process.env.OANDA_PRACTICE.toLowerCase() !== 'false'
        : (file.oanda?.practice ?? true),
  };
}

/**
 * Получить base URL для Bybit API.
 */
export function getBybitBaseUrl(): string {
  const creds = getBybitCredentials();
  return creds.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
}

/**
 * Сбросить кеш credentials (для тестов).
 */
export function resetCredentialsCache(): void {
  _cache = null;
}

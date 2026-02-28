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

export interface CTraderFixSession {
  portSSL: number;
  portPlain: number;
  senderSubID: string;
}

export interface CTraderCredentials {
  login: string;
  ctraderId: string;
  password: string;
  fixPassword: string;
  fix: {
    host: string;
    quote: CTraderFixSession;
    trade: CTraderFixSession;
    senderCompID: string;
    targetCompID: string;
  };
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
  ctrader?: {
    login?: string;
    ctraderId?: string;
    password?: string;
    fixPassword?: string;
    fix?: {
      host?: string;
      quote?: { portSSL?: number; portPlain?: number; senderSubID?: string };
      trade?: { portSSL?: number; portPlain?: number; senderSubID?: string };
      senderCompID?: string;
      targetCompID?: string;
    };
  };
}

const CREDENTIALS_PATH = path.join(process.env.HOME ?? '/root', '.openclaw', 'credentials.json');

let _cache: CredentialsFile | null = null;

function loadCredentialsFile(): CredentialsFile {
  if (_cache) return _cache;

  if (!fs.existsSync(CREDENTIALS_PATH)) return {};

  try {
    const raw = fs.readFileSync(CREDENTIALS_PATH, 'utf8');
    _cache = JSON.parse(raw) as CredentialsFile;
    return _cache;
  } catch {
    console.error(`[config] Failed to read credentials from ${CREDENTIALS_PATH}`);
    return {};
  }
}

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

export function getCTraderCredentials(): CTraderCredentials {
  const file = loadCredentialsFile();
  const ct = file.ctrader;

  return {
    login: process.env.CTRADER_LOGIN ?? ct?.login ?? '',
    ctraderId: process.env.CTRADER_ID ?? ct?.ctraderId ?? '',
    password: process.env.CTRADER_PASSWORD ?? ct?.password ?? '',
    fixPassword: process.env.CTRADER_FIX_PASSWORD ?? ct?.fixPassword ?? ct?.password ?? '',
    fix: {
      host: process.env.CTRADER_FIX_HOST ?? ct?.fix?.host ?? '',
      quote: {
        portSSL: ct?.fix?.quote?.portSSL ?? 5211,
        portPlain: ct?.fix?.quote?.portPlain ?? 5201,
        senderSubID: ct?.fix?.quote?.senderSubID ?? 'QUOTE',
      },
      trade: {
        portSSL: ct?.fix?.trade?.portSSL ?? 5212,
        portPlain: ct?.fix?.trade?.portPlain ?? 5202,
        senderSubID: ct?.fix?.trade?.senderSubID ?? 'TRADE',
      },
      senderCompID: process.env.CTRADER_SENDER_COMP_ID ?? ct?.fix?.senderCompID ?? '',
      targetCompID: ct?.fix?.targetCompID ?? 'cServer',
    },
  };
}

export function getBybitBaseUrl(): string {
  const creds = getBybitCredentials();
  return creds.testnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
}

export function resetCredentialsCache(): void {
  _cache = null;
}

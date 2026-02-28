/**
 * FIX 4.4 Protocol Client для cTrader.
 *
 * Реализует низкоуровневый FIX-протокол поверх TLS:
 *   - Кодирование/декодирование FIX-сообщений
 *   - TLS-подключение к cTrader FIX API
 *   - Heartbeat, Logon/Logout
 *   - Управление Sequence Numbers
 *   - Request/Response matching
 *
 * Использует только Node.js built-in модули (node:tls).
 */

import { EventEmitter } from 'node:events';
import tls from 'node:tls';

import { createLogger } from '../../utils/logger.js';

const log = createLogger('fix');

const SOH = '\x01';
const FIX_VERSION = 'FIX.4.4';

// ─── FIX Tags ────────────────────────────────────────────────

export const Tag = {
  BeginString: 8,
  BodyLength: 9,
  CheckSum: 10,
  MsgType: 35,
  MsgSeqNum: 34,
  SenderCompID: 49,
  SenderSubID: 50,
  SendingTime: 52,
  TargetCompID: 56,
  TargetSubID: 57,
  Text: 58,
  EncryptMethod: 98,
  HeartBtInt: 108,
  TestReqID: 112,
  ResetSeqNumFlag: 141,
  Username: 553,
  Password: 554,

  // Market Data
  MDReqID: 262,
  SubscriptionRequestType: 263,
  MarketDepth: 264,
  NoMDEntryTypes: 267,
  NoMDEntries: 268,
  MDEntryType: 269,
  MDEntryPx: 270,
  MDEntrySize: 271,
  NoRelatedSym: 146,
  Symbol: 55,

  // Orders
  Account: 1,
  AvgPx: 6,
  ClOrdID: 11,
  CumQty: 14,
  ExecID: 17,
  OrderID: 37,
  OrderQty: 38,
  OrdStatus: 39,
  OrdType: 40,
  OrigClOrdID: 41,
  Price: 44,
  Side: 54,
  TimeInForce: 59,
  TransactTime: 60,
  PositionEffect: 77,
  StopPx: 99,
  ExecType: 150,
  LeavesQty: 151,
  Currency: 15,

  // Positions
  PosReqID: 710,
  PosMaintRptID: 721,
  PosReqType: 724,
  TotalNumPosReports: 727,
  PosReqResult: 728,
  NoPositions: 702,
  PosType: 703,
  LongQty: 704,
  ShortQty: 705,
  SettlPrice: 730,
  AccountType: 581,

  // Collateral
  MarginExcess: 899,
  TotalNetValue: 900,
  CashOutstanding: 901,
  CollRptID: 908,
  CollInquiryID: 909,

  // cTrader custom tags
  PositionID: 721, // PosMaintRptID doubles as position ID in reports
  SymbolName: 9013, // cTrader custom: human-readable symbol name
  SymbolDigits: 9014, // cTrader custom: decimal precision (5 forex, 2 metals)
  StopLossPrice: 9025, // cTrader custom: SL price on order/position
  TakeProfitPrice: 9026, // cTrader custom: TP price on order/position
  TrailingStop: 9027, // cTrader custom: trailing stop in pips

  // Reject routing
  RefSeqNum: 45, // Sequence number of rejected message
  RefMsgType: 372, // MsgType of rejected message
  RefTagID: 371, // Tag of rejected field
  SessionRejectReason: 373,

  // Order Cancel Reject
  CxlRejReason: 102,
  CxlRejResponseTo: 434,
  OrdRejReason: 103,
  BusinessRejectRefID: 379,
  BusinessRejectReason: 380,

  // SecurityList
  SecurityReqID: 320,
  SecurityListRequestType: 559,
  SecurityResponseID: 322,
  TotNoRelatedSym: 393,
  SecurityRequestResult: 560,
  LegSymbol: 1007, // cTrader: human-readable symbol name in SecurityList
} as const;

// ─── FIX Message Types ───────────────────────────────────────

export const MsgType = {
  Heartbeat: '0',
  TestRequest: '1',
  ResendRequest: '2',
  Reject: '3',
  SequenceReset: '4',
  Logout: '5',
  Logon: 'A',
  ExecutionReport: '8',
  NewOrderSingle: 'D',
  OrderCancelRequest: 'F',
  OrderCancelReplaceRequest: 'G',
  OrderStatusRequest: 'H',
  MarketDataRequest: 'V',
  MarketDataSnapshot: 'W',
  MarketDataIncRefresh: 'X',
  SecurityListRequest: 'x',
  SecurityList: 'y',
  RequestForPositions: 'AN',
  PositionReport: 'AP',
  CollateralInquiry: 'BB',
  CollateralReport: 'BA',
  OrderCancelReject: '9',
  BusinessMessageReject: 'j',
} as const;

// ─── FIX Message ─────────────────────────────────────────────

export class FixMessage {
  private fields = new Map<number, string>();
  /** Все поля в порядке появления (для repeating groups). */
  private allFields: [number, string][] = [];

  set(tag: number, value: string | number): this {
    this.fields.set(tag, String(value));
    this.allFields.push([tag, String(value)]);
    return this;
  }

  get(tag: number): string | undefined {
    return this.fields.get(tag);
  }

  getInt(tag: number): number {
    return parseInt(this.get(tag) ?? '0', 10);
  }

  getFloat(tag: number): number {
    return parseFloat(this.get(tag) ?? '0');
  }

  getString(tag: number): string {
    return this.get(tag) ?? '';
  }

  has(tag: number): boolean {
    return this.fields.has(tag);
  }

  get msgType(): string {
    return this.getString(Tag.MsgType);
  }

  get seqNum(): number {
    return this.getInt(Tag.MsgSeqNum);
  }

  entries(): IterableIterator<[number, string]> {
    return this.fields.entries();
  }

  /**
   * Извлечь repeating groups.
   * @param delimiterTag — тег-разделитель, начинающий каждую запись (напр. 55 для Symbol)
   * @param groupTags — список тегов, входящих в каждую запись
   * @returns массив записей, каждая — Map<tag, value>
   */
  getRepeatingGroup(delimiterTag: number, groupTags: number[]): Map<number, string>[] {
    const tagSet = new Set([delimiterTag, ...groupTags]);
    const groups: Map<number, string>[] = [];
    let current: Map<number, string> | null = null;

    for (const [tag, val] of this.allFields) {
      if (!tagSet.has(tag)) continue;

      if (tag === delimiterTag) {
        // Новая запись — сохранить предыдущую
        if (current) groups.push(current);
        current = new Map();
        current.set(tag, val);
      } else if (current) {
        current.set(tag, val);
      }
    }
    if (current) groups.push(current);

    return groups;
  }

  /** Форматирование для логов (тег=значение | ...) */
  toString(): string {
    const parts: string[] = [];
    for (const [tag, val] of this.fields) {
      parts.push(`${tag}=${val}`);
    }
    return parts.join(' | ');
  }
}

// ─── FIX Helpers ─────────────────────────────────────────────

/** UTC timestamp в формате FIX: YYYYMMDD-HH:MM:SS.mmm */
function fixTimestamp(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const mo = String(now.getUTCMonth() + 1).padStart(2, '0');
  const d = String(now.getUTCDate()).padStart(2, '0');
  const h = String(now.getUTCHours()).padStart(2, '0');
  const mi = String(now.getUTCMinutes()).padStart(2, '0');
  const s = String(now.getUTCSeconds()).padStart(2, '0');
  const ms = String(now.getUTCMilliseconds()).padStart(3, '0');
  return `${y}${mo}${d}-${h}:${mi}:${s}.${ms}`;
}

/** Подсчёт FIX чексуммы (сумма ASCII mod 256, 3 цифры) */
function calculateChecksum(data: string): string {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data.charCodeAt(i);
  }
  return String(sum % 256).padStart(3, '0');
}

/** Собрать FIX-сообщение из полей. */
function buildMessage(
  msgType: string,
  bodyFields: [number, string | number][],
  senderCompID: string,
  targetCompID: string,
  seqNum: number,
  senderSubID?: string,
  targetSubID?: string,
): Buffer {
  // body: от 35= до SOH перед 10=
  const bodyParts: string[] = [];
  bodyParts.push(`35=${msgType}`);
  bodyParts.push(`49=${senderCompID}`);
  bodyParts.push(`56=${targetCompID}`);
  bodyParts.push(`34=${seqNum}`);
  bodyParts.push(`52=${fixTimestamp()}`);
  if (senderSubID) bodyParts.push(`50=${senderSubID}`);
  if (targetSubID) bodyParts.push(`57=${targetSubID}`);

  for (const [tag, val] of bodyFields) {
    bodyParts.push(`${tag}=${val}`);
  }

  const body = bodyParts.map((f) => f + SOH).join('');
  const header = `8=${FIX_VERSION}${SOH}9=${body.length}${SOH}`;
  const withoutChecksum = header + body;
  const checksum = calculateChecksum(withoutChecksum);

  return Buffer.from(`${withoutChecksum}10=${checksum}${SOH}`, 'ascii');
}

/** Парсинг FIX-сообщений из буфера. Возвращает распарсенные + остаток. */
export function parseFixMessages(buffer: Buffer): {
  messages: FixMessage[];
  remaining: Buffer;
} {
  const messages: FixMessage[] = [];
  const data = buffer.toString('ascii');
  let pos = 0;

  while (pos < data.length) {
    // Ищем начало сообщения: 8=FIX
    const beginIdx = data.indexOf('8=FIX', pos);
    if (beginIdx < 0) break;

    // Ищем чексумму: SOH 10=xxx SOH
    const checkSumTagIdx = data.indexOf(`${SOH}10=`, beginIdx);
    if (checkSumTagIdx < 0) break;

    // Конец чексуммы (SOH после значения)
    const endIdx = data.indexOf(SOH, checkSumTagIdx + 4);
    if (endIdx < 0) break;

    const msgStr = data.substring(beginIdx, endIdx + 1);
    const msg = new FixMessage();

    for (const field of msgStr.split(SOH)) {
      if (!field) continue;
      const eqIdx = field.indexOf('=');
      if (eqIdx < 0) continue;
      const tag = parseInt(field.substring(0, eqIdx), 10);
      const val = field.substring(eqIdx + 1);
      if (!isNaN(tag)) {
        msg.set(tag, val);
      }
    }

    messages.push(msg);
    pos = endIdx + 1;
  }

  const remaining = pos < data.length ? Buffer.from(data.substring(pos), 'ascii') : Buffer.alloc(0);
  return { messages, remaining };
}

// ─── FIX Session ─────────────────────────────────────────────

export interface FixSessionConfig {
  host: string;
  port: number;
  senderCompID: string;
  targetCompID: string;
  senderSubID: string;
  targetSubID: string;
  username: string;
  password: string;
  heartbeatIntervalSec?: number;
}

interface PendingRequest {
  resolve: (msg: FixMessage) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
}

interface PendingMultiRequest {
  messages: FixMessage[];
  resolve: (msgs: FixMessage[]) => void;
  reject: (err: Error) => void;
  timeout: NodeJS.Timeout;
  expectedTotal?: number;
}

/**
 * FIX Session — одно TLS-подключение к cTrader FIX серверу.
 *
 * Поддерживает TRADE и QUOTE сессии (определяется через senderSubID/targetSubID).
 */
export class FixSession extends EventEmitter {
  private socket: tls.TLSSocket | null = null;
  private buffer = Buffer.alloc(0);
  private outSeqNum = 1;
  private heartbeatInterval: number;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private loggedIn = false;

  private pendingRequests = new Map<string, PendingRequest>();
  private multiResponses = new Map<string, PendingMultiRequest>();
  /** Map outgoing seq# → pending request key (for reject routing) */
  private seqToKey = new Map<number, string>();

  constructor(private config: FixSessionConfig) {
    super();
    this.heartbeatInterval = config.heartbeatIntervalSec ?? 30;
  }

  get isConnected(): boolean {
    return this.connected && this.loggedIn;
  }

  get sessionType(): string {
    return this.config.senderSubID;
  }

  /** Подключиться к серверу, выполнить Logon и дождаться подтверждения. */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const { host, port } = this.config;
      log.info(`Подключение к ${host}:${port} (${this.config.senderSubID})...`);

      this.socket = tls.connect({ host, port, rejectUnauthorized: false }, () => {
        log.info(`TLS подключено к ${host}:${port}`);
        this.connected = true;
        this.sendLogon();
      });

      this.socket.on('data', (data: Buffer) => this.onData(data));

      this.socket.on('error', (err) => {
        log.error(`Socket ошибка (${this.config.senderSubID}): ${err.message}`);
        if (!this.loggedIn) reject(err);
        this.emit('error', err);
      });

      this.socket.on('close', () => {
        log.info(`Socket закрыт (${this.config.senderSubID})`);
        this.cleanup();
        this.emit('close');
      });

      // Ждём Logon ответ (макс. 10 сек)
      const logonTimeout = setTimeout(() => {
        reject(new Error(`Logon timeout (${this.config.senderSubID})`));
        this.cleanup();
      }, 10000);

      this.once('logon', () => {
        clearTimeout(logonTimeout);
        this.startHeartbeat();
        resolve();
      });

      this.once('logon-rejected', (reason: string) => {
        clearTimeout(logonTimeout);
        reject(new Error(`Logon rejected: ${reason}`));
        this.cleanup();
      });
    });
  }

  /** Отключиться (Logout + закрыть сокет). */
  disconnect(): void {
    if (this.loggedIn && this.socket) {
      try {
        this.sendRaw(MsgType.Logout, []);
      } catch {
        // Игнорируем ошибки при закрытии
      }
    }
    this.cleanup();
  }

  /** Отправить FIX-сообщение (fire-and-forget). */
  sendRaw(msgType: string, fields: [number, string | number][]): void {
    if (!this.socket || !this.connected) {
      throw new Error('FIX: не подключено');
    }

    const msg = buildMessage(
      msgType,
      fields,
      this.config.senderCompID,
      this.config.targetCompID,
      this.outSeqNum++,
      this.config.senderSubID,
      this.config.targetSubID,
    );

    // Debug: показать отправляемое сообщение (заменяя SOH на |)
    // eslint-disable-next-line no-control-regex
    const readable = msg.toString('ascii').replace(/\x01/g, '|');
    log.debug(`→ ${readable}`);

    this.socket.write(msg);
  }

  /**
   * Отправить запрос и дождаться одного ответа.
   * Ответ матчится по responseType + reqId.
   */
  async request(
    msgType: string,
    fields: [number, string | number][],
    responseType: string,
    reqId: string,
    timeoutMs = 10000,
  ): Promise<FixMessage> {
    return new Promise((resolve, reject) => {
      const key = `${responseType}:${reqId}`;
      const seqNum = this.outSeqNum; // будет использовано в sendRaw

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(key);
        this.seqToKey.delete(seqNum);
        reject(new Error(`FIX timeout: ${msgType} reqId=${reqId}`));
      }, timeoutMs);

      this.pendingRequests.set(key, { resolve, reject, timeout });
      this.sendRaw(msgType, fields);
      this.seqToKey.set(seqNum, key);
    });
  }

  /**
   * Отправить запрос и дождаться нескольких ответов.
   * Используется для Position Reports (несколько AP-сообщений).
   */
  async requestMulti(
    msgType: string,
    fields: [number, string | number][],
    responseType: string,
    reqId: string,
    timeoutMs = 15000,
  ): Promise<FixMessage[]> {
    return new Promise((resolve, reject) => {
      const key = `${responseType}:${reqId}`;

      const timeout = setTimeout(() => {
        const pending = this.multiResponses.get(key);
        this.multiResponses.delete(key);
        if (pending && pending.messages.length > 0) {
          resolve(pending.messages);
        } else {
          // PosReqResult=2 means "no positions" — resolve with empty
          resolve([]);
        }
      }, timeoutMs);

      this.multiResponses.set(key, {
        messages: [],
        resolve,
        reject,
        timeout,
      });
      this.sendRaw(msgType, fields);
    });
  }

  // ─── Private ──────────────────────────────────────────────

  private sendLogon(): void {
    log.info(
      `Отправка Logon (user=${this.config.username}, sender=${this.config.senderCompID})...`,
    );
    // cTrader FIX: Username (553) обязателен как integer
    this.sendRaw(MsgType.Logon, [
      [Tag.EncryptMethod, 0],
      [Tag.HeartBtInt, this.heartbeatInterval],
      [Tag.ResetSeqNumFlag, 'Y'],
      [Tag.Username, this.config.username],
      [Tag.Password, this.config.password],
    ]);
  }

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.connected && this.loggedIn) {
        this.sendRaw(MsgType.Heartbeat, []);
      }
    }, this.heartbeatInterval * 1000);
  }

  private onData(data: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, data]);
    const { messages, remaining } = parseFixMessages(this.buffer);
    this.buffer = Buffer.from(remaining);

    for (const msg of messages) {
      this.onMessage(msg);
    }
  }

  private onMessage(msg: FixMessage): void {
    const msgType = msg.msgType;
    log.debug(`← 35=${msgType}: ${msg.toString()}`);

    switch (msgType) {
      case MsgType.Logon:
        this.loggedIn = true;
        log.info(`✅ Logon OK (${this.config.senderSubID})`);
        this.emit('logon', msg);
        break;

      case MsgType.Heartbeat:
        // Соединение живо
        break;

      case MsgType.TestRequest:
        // Ответить Heartbeat с TestReqID
        this.sendRaw(MsgType.Heartbeat, [[Tag.TestReqID, msg.getString(Tag.TestReqID)]]);
        break;

      case MsgType.ResendRequest:
        // Вместо пересылки — отправить SequenceReset
        log.warn(`ResendRequest от сервера (begin=${msg.getInt(7)}, end=${msg.getInt(16)})`);
        this.sendRaw(MsgType.SequenceReset, [
          [123, 'Y'], // GapFillFlag
          [36, this.outSeqNum], // NewSeqNo
        ]);
        break;

      case MsgType.Logout: {
        const reason = msg.getString(Tag.Text);
        log.info(`Logout от сервера: ${reason}`);
        if (!this.loggedIn) {
          this.emit('logon-rejected', reason);
        }
        this.loggedIn = false;
        this.emit('logout', msg);
        break;
      }

      case MsgType.Reject: {
        const reason = msg.getString(Tag.Text);
        const refSeqNum = msg.getInt(Tag.RefSeqNum);
        log.warn(`Reject от сервера (refSeq=${refSeqNum}): ${reason}`);
        // Пытаемся зарезолвить pending request как ошибку
        this.rejectPendingBySeq(refSeqNum, reason);
        this.emit('reject', msg);
        break;
      }

      case MsgType.OrderCancelReject: {
        // OrderCancelReject (9) — отказ в отмене/модификации ордера
        const reason = msg.getString(Tag.Text);
        const clOrdId = msg.getString(Tag.ClOrdID);
        log.warn(`OrderCancelReject: ${reason} (ClOrdID=${clOrdId})`);
        // Резолвим как ExecutionReport с reject-статусом
        const key = `${MsgType.ExecutionReport}:${clOrdId}`;
        const pending = this.pendingRequests.get(key);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(key);
          const fakeReject = new FixMessage();
          fakeReject.set(Tag.MsgType, MsgType.OrderCancelReject);
          fakeReject.set(Tag.ClOrdID, clOrdId);
          fakeReject.set(Tag.ExecType, '8');
          fakeReject.set(Tag.OrdStatus, '8');
          fakeReject.set(Tag.Text, reason);
          pending.resolve(fakeReject);
        }
        this.emit('cancel-reject', msg);
        break;
      }

      case MsgType.BusinessMessageReject: {
        // BusinessMessageReject (j) — отказ по бизнес-логике (Market Closed, etc)
        const reason = msg.getString(Tag.Text);
        const refId = msg.getString(Tag.BusinessRejectRefID);
        log.warn(`BusinessReject: ${reason} (RefID=${refId})`);
        // Пытаемся зарезолвить pending request по ClOrdID
        const key2 = `${MsgType.ExecutionReport}:${refId}`;
        const pending2 = this.pendingRequests.get(key2);
        if (pending2) {
          clearTimeout(pending2.timeout);
          this.pendingRequests.delete(key2);
          const fakeReject = new FixMessage();
          fakeReject.set(Tag.MsgType, MsgType.BusinessMessageReject);
          fakeReject.set(Tag.ClOrdID, refId);
          fakeReject.set(Tag.ExecType, '8');
          fakeReject.set(Tag.OrdStatus, '8');
          fakeReject.set(Tag.Text, reason);
          pending2.resolve(fakeReject);
        }
        this.emit('business-reject', msg);
        break;
      }

      default:
        // Маршрутизация ответов к pending requests
        this.routeResponse(msg);
        this.emit('message', msg);
        break;
    }
  }

  private routeResponse(msg: FixMessage): void {
    const msgType = msg.msgType;

    // Таблица: responseType → reqIdTag
    const routeMap: [string, number][] = [
      [MsgType.CollateralReport, Tag.CollInquiryID],
      [MsgType.ExecutionReport, Tag.ClOrdID],
      [MsgType.MarketDataSnapshot, Tag.MDReqID],
      [MsgType.PositionReport, Tag.PosReqID],
      [MsgType.SecurityList, Tag.SecurityReqID],
    ];

    for (const [respType, idTag] of routeMap) {
      if (msgType !== respType) continue;

      const reqId = msg.getString(idTag);
      const key = `${respType}:${reqId}`;

      // Single response
      const pending = this.pendingRequests.get(key);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(key);
        pending.resolve(msg);
        return;
      }

      // Multi response (e.g., position reports)
      const multi = this.multiResponses.get(key);
      if (multi) {
        // Проверяем PosReqResult=2 (нет позиций) или SecurityRequestResult≠0
        if (msg.has(Tag.PosReqResult) && msg.getInt(Tag.PosReqResult) === 2) {
          clearTimeout(multi.timeout);
          this.multiResponses.delete(key);
          multi.resolve([]);
          return;
        }
        if (msg.has(Tag.SecurityRequestResult) && msg.getInt(Tag.SecurityRequestResult) !== 0) {
          clearTimeout(multi.timeout);
          this.multiResponses.delete(key);
          multi.resolve([]);
          return;
        }

        multi.messages.push(msg);

        // SecurityList: всё приходит в одном сообщении с SecurityRequestResult=0
        if (msg.has(Tag.SecurityRequestResult) && msg.getInt(Tag.SecurityRequestResult) === 0) {
          clearTimeout(multi.timeout);
          this.multiResponses.delete(key);
          multi.resolve(multi.messages);
          return;
        }

        // PositionReport: определяем total из TotalNumPosReports
        const totalPos = msg.getInt(Tag.TotalNumPosReports);
        if (totalPos > 0) multi.expectedTotal = totalPos;

        if (multi.expectedTotal && multi.messages.length >= multi.expectedTotal) {
          clearTimeout(multi.timeout);
          this.multiResponses.delete(key);
          multi.resolve(multi.messages);
        }
        return;
      }

      break;
    }

    // Неподходящее сообщение — логаем для диагностики
    log.debug(`Неопознанный ответ 35=${msgType}: ${msg.toString()}`);
    this.emit(`msg:${msgType}`, msg);
  }

  /**
   * Зарезолвить pending request при получении Reject (35=3).
   * Сервер ссылается на seq# отклонённого сообщения через RefSeqNum (45).
   */
  private rejectPendingBySeq(refSeqNum: number, reason: string): void {
    const key = this.seqToKey.get(refSeqNum);
    if (!key) return;
    this.seqToKey.delete(refSeqNum);

    const pending = this.pendingRequests.get(key);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(key);
      pending.reject(new Error(`FIX Reject: ${reason}`));
      return;
    }

    const multi = this.multiResponses.get(key);
    if (multi) {
      clearTimeout(multi.timeout);
      this.multiResponses.delete(key);
      if (multi.messages.length > 0) {
        multi.resolve(multi.messages);
      } else {
        multi.reject(new Error(`FIX Reject: ${reason}`));
      }
    }
  }

  private cleanup(): void {
    this.connected = false;
    this.loggedIn = false;

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    // Отклоняем все ожидающие запросы
    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timeout);
      req.reject(new Error('FIX: соединение закрыто'));
    }
    this.pendingRequests.clear();

    for (const [, req] of this.multiResponses) {
      clearTimeout(req.timeout);
      req.reject(new Error('FIX: соединение закрыто'));
    }
    this.multiResponses.clear();
    this.seqToKey.clear();
  }
}

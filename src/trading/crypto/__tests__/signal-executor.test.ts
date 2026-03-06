import { beforeEach, describe, expect, it, vi } from 'vitest';

// Мокируем все внешние зависимости до импорта тестируемого модуля
vi.mock('../bybit-client.js', () => ({
  getOpenOrders: vi.fn(),
  getOpenOrdersFull: vi.fn(),
  cancelOrder: vi.fn(),
  setLeverage: vi.fn(),
  submitOrder: vi.fn(),
}));

vi.mock('../state.js', () => ({
  canTrade: vi.fn(),
  get: vi.fn(),
  calcPositionSize: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../decision-journal.js', () => ({
  logDecision: vi.fn(),
}));

vi.mock('../symbol-specs.js', () => ({
  formatQty: vi.fn((qty: number) => qty.toFixed(3)),
}));

import {
  cancelOrder,
  getOpenOrders,
  getOpenOrdersFull,
  setLeverage,
  submitOrder,
} from '../bybit-client.js';
import * as state from '../state.js';
import { cancelStaleOrders, executeSignals } from '../signal-executor.js';
import type { TradeSignalInternal } from '../market-analyzer.js';

// Вспомогательная функция для создания тестового сигнала
function makeSignal(overrides: Partial<TradeSignalInternal> = {}): TradeSignalInternal {
  return {
    pair: 'BTCUSDT',
    side: 'Buy',
    entryPrice: 50000,
    sl: 49000,
    tp: 52000,
    rr: 2,
    reason: 'Test signal',
    confluence: {
      total: 70,
      trend: 8,
      momentum: 6,
      volume: 5,
      structure: 7,
      orderflow: 4,
      regime: 6,
      signal: 'STRONG_LONG',
      confidence: 80,
      details: [],
    },
    regime: 'TRENDING',
    confidence: 80,
    ...overrides,
  };
}

// Вспомогательная функция для создания базового состояния
function makeState(overrides: Record<string, unknown> = {}) {
  return {
    positions: [],
    balance: { total: 10000, available: 5000, unrealizedPnl: 0, lastUpdate: null },
    daily: {
      stopDay: false,
      stopDayReason: null,
      trades: 0,
      wins: 0,
      losses: 0,
      stops: 0,
      totalPnl: 0,
      realizedPnl: 0,
      fees: 0,
      maxDrawdown: 0,
      date: '2026-03-06',
    },
    ...overrides,
  };
}

const mockGetOpenOrders = vi.mocked(getOpenOrders);
const mockGetOpenOrdersFull = vi.mocked(getOpenOrdersFull);
const mockCancelOrder = vi.mocked(cancelOrder);
const mockSetLeverage = vi.mocked(setLeverage);
const mockSubmitOrder = vi.mocked(submitOrder);
const mockCanTrade = vi.mocked(state.canTrade);
const mockGet = vi.mocked(state.get);
const mockCalcPositionSize = vi.mocked(state.calcPositionSize);

beforeEach(() => {
  vi.clearAllMocks();

  // Дефолтные моки — торговля разрешена
  mockCanTrade.mockReturnValue({ allowed: true, reason: 'OK' });
  mockGet.mockReturnValue(makeState() as unknown as ReturnType<typeof state.get>);
  mockCalcPositionSize.mockReturnValue(0.1);
  mockGetOpenOrders.mockResolvedValue([]);
  mockGetOpenOrdersFull.mockResolvedValue([]);
  mockSetLeverage.mockResolvedValue(undefined);
  mockSubmitOrder.mockResolvedValue({
    orderId: 'order-123',
    symbol: 'BTCUSDT',
    side: 'Buy',
    orderType: 'Limit',
    qty: '0.100',
    price: '50000',
    status: 'EXECUTED',
  });
});

describe('executeSignals — DRY_RUN', () => {
  it('возвращает DRY_RUN для всех сигналов без обращения к API', async () => {
    const signals = [makeSignal(), makeSignal({ pair: 'ETHUSDT' })];
    const results = await executeSignals(signals, 'cycle-1', true);

    expect(results).toHaveLength(2);
    expect(results[0]?.action).toBe('DRY_RUN (not executed)');
    expect(results[1]?.action).toBe('DRY_RUN (not executed)');
    expect(mockGetOpenOrders).not.toHaveBeenCalled();
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it('возвращает пустой массив при пустом списке сигналов в DRY_RUN', async () => {
    const results = await executeSignals([], 'cycle-1', true);
    expect(results).toHaveLength(0);
  });
});

describe('executeSignals — BLOCKED', () => {
  it('блокирует все сигналы если canTrade() запрещает', async () => {
    mockCanTrade.mockReturnValue({
      allowed: false,
      reason: 'KILL_SWITCH active. Trading stopped.',
    });

    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toContain('BLOCKED');
    expect(results[0]?.action).toContain('KILL_SWITCH');
    expect(mockGetOpenOrders).not.toHaveBeenCalled();
  });

  it('блокирует если не удалось получить открытые ордера', async () => {
    mockGetOpenOrders.mockRejectedValue(new Error('Network error'));

    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toContain('BLOCKED');
    expect(results[0]?.action).toContain('failed to check open orders');
  });
});

describe('executeSignals — SKIP позиция уже открыта', () => {
  it('пропускает сигнал если позиция по этой паре уже открыта', async () => {
    mockGet.mockReturnValue(
      makeState({
        positions: [
          {
            symbol: 'BTCUSDT',
            side: 'long',
            size: '0.1',
            entryPrice: '48000',
            markPrice: '50000',
            unrealisedPnl: '200',
            leverage: '3',
            stopLoss: '47000',
            takeProfit: '52000',
          },
        ],
      }) as unknown as ReturnType<typeof state.get>,
    );

    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toBe('SKIP: position already open');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignals — SKIP pending order', () => {
  it('пропускает сигнал если есть pending ордер по этой паре', async () => {
    mockGetOpenOrders.mockResolvedValue(['BTCUSDT']);

    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toBe('SKIP: pending order already exists');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignals — SKIP ecosystem occupied', () => {
  it('пропускает сигнал ETHUSDT если ARBUSDT уже в позиции (одна экосистема)', async () => {
    // ETHUSDT и ARBUSDT — одна экосистема (Ethereum ecosystem)
    mockGet.mockReturnValue(
      makeState({
        positions: [
          {
            symbol: 'ARBUSDT',
            side: 'long',
            size: '10',
            entryPrice: '1.5',
            markPrice: '1.6',
            unrealisedPnl: '1',
            leverage: '3',
            stopLoss: '1.4',
            takeProfit: '1.8',
          },
        ],
      }) as unknown as ReturnType<typeof state.get>,
    );

    const signals = [makeSignal({ pair: 'ETHUSDT', entryPrice: 3000, sl: 2900, tp: 3200 })];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toContain('SKIP: ecosystem already has open position');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it('не блокирует пары из разных экосистем', async () => {
    // BTCUSDT вне экосистем — должен пройти
    mockGet.mockReturnValue(
      makeState({
        positions: [
          {
            symbol: 'ARBUSDT',
            side: 'long',
            size: '10',
            entryPrice: '1.5',
            markPrice: '1.6',
            unrealisedPnl: '1',
            leverage: '3',
            stopLoss: '1.4',
            takeProfit: '1.8',
          },
        ],
      }) as unknown as ReturnType<typeof state.get>,
    );

    const signals = [makeSignal({ pair: 'BTCUSDT' })];
    const results = await executeSignals(signals, 'cycle-1', false);

    // BTCUSDT не в экосистеме — дойдёт до submitOrder
    expect(mockSubmitOrder).toHaveBeenCalled();
    expect(results[0]?.action).toBe('EXECUTED');
  });
});

describe('executeSignals — SKIP risk too high', () => {
  it('пропускает сигнал если риск превышает maxRiskPerTrade', async () => {
    // qty = 1, slDist = 1000, risk = 1000 > maxRiskPerTrade(250)
    mockCalcPositionSize.mockReturnValue(1);

    const signals = [makeSignal({ entryPrice: 50000, sl: 49000 })];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toContain('SKIP: risk');
    expect(results[0]?.action).toContain('> max');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignals — SKIP insufficient margin', () => {
  it('пропускает если недостаточно маржи', async () => {
    // qty=0.1, entry=50000, defaultLeverage=3 => requiredMargin = 50000*0.1/3 ≈ 1666
    // available = 100 < 1666
    mockGet.mockReturnValue(
      makeState({
        balance: { total: 10000, available: 100, unrealizedPnl: 0, lastUpdate: null },
      }) as unknown as ReturnType<typeof state.get>,
    );

    const signals = [makeSignal({ entryPrice: 50000, sl: 49000 })];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toContain('SKIP: insufficient margin');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignals — SKIP invalid SL/TP', () => {
  it('пропускает сигнал если sl === entryPrice', async () => {
    const signals = [makeSignal({ entryPrice: 50000, sl: 50000, tp: 52000 })];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toBe('SKIP: invalid SL/TP values');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it('пропускает сигнал если tp === entryPrice', async () => {
    const signals = [makeSignal({ entryPrice: 50000, sl: 49000, tp: 50000 })];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toBe('SKIP: invalid SL/TP values');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it('пропускает сигнал если sl = 0 (risk-check срабатывает раньше INVALID_SL_TP)', async () => {
    // sl=0: slDist=|50000-0|=50000, qty=0.1, risk=5000 > maxRiskPerTrade(250)
    // Поэтому первым срабатывает RISK_TOO_HIGH, но ордер не исполняется
    const signals = [makeSignal({ entryPrice: 50000, sl: 0, tp: 52000 })];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toContain('SKIP:');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });

  it('пропускает сигнал если qty = 0 (не может рассчитать)', async () => {
    mockCalcPositionSize.mockReturnValue(0);

    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toBe('SKIP: failed to calculate qty');
    expect(mockSubmitOrder).not.toHaveBeenCalled();
  });
});

describe('executeSignals — успешное исполнение', () => {
  it('успешно исполняет ордер и возвращает EXECUTED с orderId', async () => {
    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results).toHaveLength(1);
    expect(results[0]?.action).toBe('EXECUTED');
    expect(results[0]?.orderId).toBe('order-123');
    expect(mockSetLeverage).toHaveBeenCalledWith('BTCUSDT', 3);
    expect(mockSubmitOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        side: 'Buy',
        orderType: 'Limit',
        price: '50000',
        stopLoss: '49000',
        takeProfit: '52000',
      }),
    );
  });

  it('возвращает ERROR если submitOrder выбрасывает исключение', async () => {
    mockSubmitOrder.mockRejectedValue(new Error('Order REJECTED: insufficient balance'));

    const signals = [makeSignal()];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results[0]?.action).toContain('ERROR');
    expect(results[0]?.action).toContain('Order REJECTED');
  });

  it('обрабатывает несколько сигналов независимо', async () => {
    const signals = [
      makeSignal({ pair: 'BTCUSDT' }),
      makeSignal({ pair: 'XRPUSDT', entryPrice: 0.5, sl: 0.48, tp: 0.54 }),
    ];
    const results = await executeSignals(signals, 'cycle-1', false);

    expect(results).toHaveLength(2);
    expect(results[0]?.action).toBe('EXECUTED');
    expect(results[1]?.action).toBe('EXECUTED');
    expect(mockSubmitOrder).toHaveBeenCalledTimes(2);
  });
});

describe('cancelStaleOrders', () => {
  it('отменяет ордера старше staleOrderMinutes (30 мин)', async () => {
    const oldOrderTime = Date.now() - 35 * 60 * 1000; // 35 минут назад
    mockGetOpenOrdersFull.mockResolvedValue([
      {
        orderId: 'old-order-1',
        symbol: 'BTCUSDT',
        side: 'Buy',
        price: '49000',
        qty: '0.1',
        createdTime: String(oldOrderTime),
      },
    ]);
    mockCancelOrder.mockResolvedValue(undefined);

    const actions = await cancelStaleOrders();

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'stale_order_cancelled',
      symbol: 'BTCUSDT',
      orderId: 'old-order-1',
      result: 'OK',
    });
    expect(mockCancelOrder).toHaveBeenCalledWith('BTCUSDT', 'old-order-1');
  });

  it('не отменяет свежие ордера (< 30 мин)', async () => {
    const freshOrderTime = Date.now() - 10 * 60 * 1000; // 10 минут назад
    mockGetOpenOrdersFull.mockResolvedValue([
      {
        orderId: 'fresh-order-1',
        symbol: 'ETHUSDT',
        side: 'Sell',
        price: '3000',
        qty: '1',
        createdTime: String(freshOrderTime),
      },
    ]);

    const actions = await cancelStaleOrders();

    expect(actions).toHaveLength(0);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('пропускает ордера с нулевым createdTime', async () => {
    mockGetOpenOrdersFull.mockResolvedValue([
      {
        orderId: 'bad-order',
        symbol: 'SOLUSDT',
        side: 'Buy',
        price: '100',
        qty: '1',
        createdTime: '0',
      },
    ]);

    const actions = await cancelStaleOrders();

    expect(actions).toHaveLength(0);
    expect(mockCancelOrder).not.toHaveBeenCalled();
  });

  it('продолжает работу если отмена одного ордера упала с ошибкой', async () => {
    const oldTime = Date.now() - 60 * 60 * 1000; // 1 час назад
    mockGetOpenOrdersFull.mockResolvedValue([
      {
        orderId: 'fail-order',
        symbol: 'BTCUSDT',
        side: 'Buy',
        price: '48000',
        qty: '0.1',
        createdTime: String(oldTime),
      },
    ]);
    mockCancelOrder.mockRejectedValue(new Error('Cancel failed'));

    const actions = await cancelStaleOrders();

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'stale_order_cancel_failed',
      result: expect.stringContaining('ERROR') as string,
    });
  });

  it('возвращает пустой массив если getOpenOrdersFull бросает исключение', async () => {
    mockGetOpenOrdersFull.mockRejectedValue(new Error('API unavailable'));

    const actions = await cancelStaleOrders();

    // Ошибка логируется, возвращается пустой массив
    expect(actions).toHaveLength(0);
  });
});

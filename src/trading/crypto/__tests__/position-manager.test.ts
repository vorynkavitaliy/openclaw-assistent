import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../bybit-client.js', () => ({
  modifyPosition: vi.fn(),
  partialClosePosition: vi.fn(),
}));

vi.mock('../state.js', () => ({
  get: vi.fn(),
  logEvent: vi.fn(),
}));

vi.mock('../decision-journal.js', () => ({
  logDecision: vi.fn(),
}));

vi.mock('../symbol-specs.js', () => ({
  getQtyPrecision: vi.fn(() => 3),
  roundPrice: vi.fn((price: number) => Math.round(price * 10) / 10),
}));

import { modifyPosition, partialClosePosition } from '../bybit-client.js';
import * as state from '../state.js';
import { calcDefaultSl, calcDefaultTp, managePositions } from '../position-manager.js';

const mockModifyPosition = vi.mocked(modifyPosition);
const mockPartialClosePosition = vi.mocked(partialClosePosition);
const mockGet = vi.mocked(state.get);

// Вспомогательная функция для создания позиции
function makePosition(overrides: Record<string, unknown> = {}) {
  return {
    symbol: 'BTCUSDT',
    side: 'long' as const,
    size: '1',
    entryPrice: '50000',
    markPrice: '50000',
    unrealisedPnl: '0',
    leverage: '3',
    stopLoss: '49000',
    takeProfit: '52000',
    ...overrides,
  };
}

// Вспомогательная функция для создания стейта
function makeStateWith(positions: ReturnType<typeof makePosition>[]) {
  return {
    positions,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockModifyPosition.mockResolvedValue(undefined);
  mockPartialClosePosition.mockResolvedValue({
    orderId: 'close-123',
    symbol: 'BTCUSDT',
    side: 'Sell',
    orderType: 'Market',
    qty: '0.5',
    status: 'PARTIAL_CLOSED',
  });
});

describe('calcDefaultSl', () => {
  it('вычисляет SL ниже цены для long позиции', () => {
    const sl = calcDefaultSl(50000, 'long', 500);
    // atrEstimate=500, atrSlMultiplier=1.5 → slDist=750 → SL = 50000 - 750 = 49250
    expect(sl).toBe(49250);
  });

  it('вычисляет SL выше цены для short позиции', () => {
    const sl = calcDefaultSl(50000, 'short', 500);
    // atrEstimate=500, atrSlMultiplier=1.5 → slDist=750 → SL = 50000 + 750 = 50750
    expect(sl).toBe(50750);
  });

  it('использует fallback 2% если ATR не задан', () => {
    const sl = calcDefaultSl(50000, 'long');
    // entry * 0.02 = 1000 → SL = 50000 - 1000 = 49000
    expect(sl).toBe(49000);
  });
});

describe('calcDefaultTp', () => {
  it('вычисляет TP выше entry для long позиции', () => {
    const tp = calcDefaultTp(50000, 49000, 'long');
    // slDist=1000, minRR=1.0 → TP = 50000 + 1000 = 51000
    expect(tp).toBe(51000);
  });

  it('вычисляет TP ниже entry для short позиции', () => {
    const tp = calcDefaultTp(50000, 51000, 'short');
    // slDist=1000, minRR=1.0 → TP = 50000 - 1000 = 49000
    expect(tp).toBe(49000);
  });
});

describe('managePositions — DRY_RUN', () => {
  it('применяет SL-guard в DRY_RUN режиме без реального API вызова', async () => {
    // SL-Guard срабатывает когда slDistance === 0, т.е. sl === entry
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({ stopLoss: '50000', takeProfit: '0' }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', true);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'sl_guard_applied',
      symbol: 'BTCUSDT',
      result: 'DRY_RUN',
    });
    expect(mockModifyPosition).not.toHaveBeenCalled();
  });

  it('не выполняет partial close в DRY_RUN даже при достижении 1R', async () => {
    // size=1, slDist=1000, oneR=1000, uPnl=1500 => currentR=1.5 >= 1.0
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          entryPrice: '50000',
          stopLoss: '49000',
          markPrice: '51500',
          unrealisedPnl: '1500',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', true);

    expect(mockPartialClosePosition).not.toHaveBeenCalled();
    expect(mockModifyPosition).not.toHaveBeenCalled();
    // В DRY_RUN нет действий для partial/trailing (код проверяет !dryRun)
    expect(actions).toHaveLength(0);
  });
});

describe('managePositions — SL-Guard', () => {
  it('устанавливает дефолтный SL если sl === entryPrice (slDistance = 0)', async () => {
    // SL-Guard проверяет slDistance === 0, т.е. когда stopLoss равен entryPrice
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({ stopLoss: '50000', takeProfit: '0' }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'sl_guard_applied',
      symbol: 'BTCUSDT',
      result: 'OK',
    });
    expect(mockModifyPosition).toHaveBeenCalledOnce();
    // SL должен быть меньше entry для long (из calcDefaultSl с fallback 2%)
    const callArgs = mockModifyPosition.mock.calls[0];
    expect(callArgs?.[0]).toBe('BTCUSDT');
    const slArg = Number(callArgs?.[1]);
    expect(slArg).toBeLessThan(50000);
  });

  it('устанавливает только SL если TP уже задан', async () => {
    // Позиция с SL=entry (SL-Guard сработает), но TP уже есть
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({ stopLoss: '50000', takeProfit: '52000' }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    await managePositions('cycle-1', false);

    expect(mockModifyPosition).toHaveBeenCalledOnce();
    // Третий аргумент (TP) должен быть undefined если TP уже есть
    expect(mockModifyPosition.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('устанавливает дефолтный SL когда stopLoss="0" (биржа вернула нулевой SL)', async () => {
    // КРИТИЧЕСКИЙ КЕЙС: биржа возвращает stopLoss='0' для позиции без SL
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({ stopLoss: '0', takeProfit: '52000' }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'sl_guard_applied',
      symbol: 'BTCUSDT',
      result: 'OK',
    });
    expect(mockModifyPosition).toHaveBeenCalledOnce();
    // SL должен быть установлен (не undefined)
    const slArg = mockModifyPosition.mock.calls[0]?.[1];
    expect(slArg).toBeDefined();
    expect(Number(slArg)).toBeLessThan(50000); // для long SL ниже entry
    // TP не должен меняться — уже есть
    expect(mockModifyPosition.mock.calls[0]?.[2]).toBeUndefined();
  });

  it('устанавливает SL и TP когда оба = "0"', async () => {
    mockGet.mockReturnValue(
      makeStateWith([makePosition({ stopLoss: '0', takeProfit: '0' })]) as unknown as ReturnType<
        typeof state.get
      >,
    );

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'sl_guard_applied', result: 'OK' });
    expect(mockModifyPosition).toHaveBeenCalledOnce();
    // И SL и TP должны быть установлены
    const [, slArg, tpArg] = mockModifyPosition.mock.calls[0]!;
    expect(slArg).toBeDefined();
    expect(tpArg).toBeDefined();
    expect(Number(slArg)).toBeLessThan(50000);
    expect(Number(tpArg)).toBeGreaterThan(50000);
  });

  it('устанавливает только TP когда SL есть а TP = "0"', async () => {
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({ stopLoss: '49000', takeProfit: '0' }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ type: 'sl_guard_applied', result: 'OK' });
    expect(mockModifyPosition).toHaveBeenCalledOnce();
    // SL не должен меняться (undefined), TP должен быть установлен
    const [, slArg, tpArg] = mockModifyPosition.mock.calls[0]!;
    expect(slArg).toBeUndefined();
    expect(tpArg).toBeDefined();
    expect(Number(tpArg)).toBeGreaterThan(50000);
  });

  it('логирует ошибку если modifyPosition упал при SL-Guard', async () => {
    mockGet.mockReturnValue(
      makeStateWith([makePosition({ stopLoss: '50000' })]) as unknown as ReturnType<
        typeof state.get
      >,
    );
    mockModifyPosition.mockRejectedValue(new Error('API error'));

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      type: 'sl_guard_failed',
      result: expect.stringContaining('ERROR') as string,
    });
  });
});

describe('managePositions — partial close disabled (quick profit strategy)', () => {
  it('НЕ выполняет partial close при 1R (partialCloseAtR=99 отключён)', async () => {
    // entry=50000, SL=49000 → slDist=1000, oneR=1000
    // uPnl=1000 → currentR=1.0 < partialCloseAtR(99) — не срабатывает
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          entryPrice: '50000',
          stopLoss: '49000',
          markPrice: '51000',
          unrealisedPnl: '1000',
          size: '1',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(mockPartialClosePosition).not.toHaveBeenCalled();
    // Но trailing SL должен сработать (trailingStartR=0.7, currentR=1.0 >= 0.7)
    const trailingAction = actions.find((a) => a['type'] === 'trailing_sl');
    expect(trailingAction).toBeDefined();
  });

  it('не выполняет partial close при прибыли меньше 1R', async () => {
    // uPnl=500, oneR=1000 → currentR=0.5 < partialCloseAtR(99)
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          entryPrice: '50000',
          stopLoss: '49000',
          unrealisedPnl: '500',
          size: '1',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(mockPartialClosePosition).not.toHaveBeenCalled();
    expect(actions).toHaveLength(0);
  });
});

describe('managePositions — trailing SL at 0.7R', () => {
  it('применяет trailing SL при достижении 0.7R прибыли для long', async () => {
    // entry=50000, SL=49000 → slDist=1000
    // size=1 → oneR=1000
    // uPnl=800 → currentR=0.8 >= trailingStartR(0.7)
    // markPrice=50800, trailingDistance = slDist*trailingDistanceR = 1000*0.3 = 300
    // newSl = 50800 - 300 = 50500 > sl(49000) — нужен апдейт
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          entryPrice: '50000',
          stopLoss: '49000',
          markPrice: '50800',
          unrealisedPnl: '800',
          size: '1',
          side: 'long',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    const trailingAction = actions.find((a) => a['type'] === 'trailing_sl');
    expect(trailingAction).toBeDefined();
    expect(trailingAction?.['result']).toBe('OK');
    expect(Number(trailingAction?.['newSl'])).toBeGreaterThan(49000);
  });

  it('не применяет trailing SL если новый SL не лучше текущего', async () => {
    // markPrice=49200, trailingDistance=300 → newSl=48900 < sl(49000) — не обновит
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          entryPrice: '50000',
          stopLoss: '49000',
          markPrice: '49200',
          unrealisedPnl: '800', // currentR >= 0.7 чтобы войти в блок
          size: '1',
          side: 'long',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    // trailing_sl не должен быть добавлен (newSl < старый sl)
    const trailingAction = actions.find((a) => a['type'] === 'trailing_sl');
    expect(trailingAction).toBeUndefined();
  });

  it('применяет trailing SL для short позиции', async () => {
    // entry=50000, SL=51000 → slDist=1000
    // uPnl=800 → currentR=0.8 >= 0.7
    // markPrice=49200, trailingDistance=300
    // newSl = 49200 + 300 = 49500 < sl(51000) — нужен апдейт
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          side: 'short',
          entryPrice: '50000',
          stopLoss: '51000',
          markPrice: '49200',
          unrealisedPnl: '800',
          size: '1',
          takeProfit: '48000',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    const trailingAction = actions.find((a) => a['type'] === 'trailing_sl');
    expect(trailingAction).toBeDefined();
    expect(Number(trailingAction?.['newSl'])).toBeLessThan(51000);
  });

  it('логирует ошибку если modifyPosition упал', async () => {
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({
          entryPrice: '50000',
          stopLoss: '49000',
          markPrice: '51500',
          unrealisedPnl: '1500',
          size: '1',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );
    mockModifyPosition.mockRejectedValue(new Error('Modify failed'));

    const actions = await managePositions('cycle-1', false);

    // Любой вызов modifyPosition упал — должна быть запись с ERROR
    const hasError = actions.some(
      (a) => typeof a['result'] === 'string' && a['result'].includes('ERROR'),
    );
    expect(hasError).toBe(true);
  });
});

describe('managePositions — пустые/невалидные позиции', () => {
  it('возвращает пустой массив если нет позиций', async () => {
    mockGet.mockReturnValue(makeStateWith([]) as unknown as ReturnType<typeof state.get>);

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(0);
    expect(mockModifyPosition).not.toHaveBeenCalled();
    expect(mockPartialClosePosition).not.toHaveBeenCalled();
  });

  it('пропускает позицию с нулевым entryPrice', async () => {
    mockGet.mockReturnValue(
      makeStateWith([makePosition({ entryPrice: '0' })]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(0);
    expect(mockModifyPosition).not.toHaveBeenCalled();
  });

  it('пропускает позицию с нулевым size', async () => {
    mockGet.mockReturnValue(
      makeStateWith([makePosition({ size: '0' })]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    expect(actions).toHaveLength(0);
  });

  it('обрабатывает несколько позиций независимо', async () => {
    // Первая позиция — SL=entry (SL-Guard), вторая — нормальная без триггеров
    mockGet.mockReturnValue(
      makeStateWith([
        makePosition({ symbol: 'BTCUSDT', stopLoss: '50000' }), // SL=entry → SL-Guard
        makePosition({
          symbol: 'ETHUSDT',
          entryPrice: '3000',
          stopLoss: '2900',
          markPrice: '3000',
          unrealisedPnl: '0',
        }),
      ]) as unknown as ReturnType<typeof state.get>,
    );

    const actions = await managePositions('cycle-1', false);

    const slGuardActions = actions.filter((a) => a['type'] === 'sl_guard_applied');
    expect(slGuardActions).toHaveLength(1);
    expect(slGuardActions[0]?.['symbol']).toBe('BTCUSDT');
  });
});

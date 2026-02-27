/**
 * Forex Trading Config — конфигурация для cTrader.
 *
 * Пары, риск-менеджмент, лимиты (FTMO-совместимые).
 */

export interface ForexConfig {
  /** Режим: execute | dry-run */
  mode: 'execute' | 'dry-run';

  /** Торгуемые пары */
  pairs: string[];

  /** Плечо */
  defaultLeverage: number;

  /** Макс. риск на сделку (% от equity) */
  maxRiskPerTradePct: number;

  /** Макс. количество открытых позиций */
  maxOpenPositions: number;

  /** Макс. сделок в день */
  maxTradesPerDay: number;

  /** Макс. дневной дродаун (%) — FTMO лимит 5% */
  maxDailyDrawdownPct: number;

  /** Макс. общий дродаун (%) — FTMO лимит 10% */
  maxTotalDrawdownPct: number;

  /** Мин. Risk:Reward */
  minRR: number;

  /** Partial close при +1R (доля) */
  partialClosePercent: number;
  partialCloseAtR: number;

  /** Trailing stop с +1.5R */
  trailingStartR: number;
  trailingDistanceR: number;

  /** Таймфреймы для анализа */
  trendTimeframe: string; // H4
  entryTimeframe: string; // M15

  /** cTrader environment */
  environment: 'demo' | 'live';
}

const config: ForexConfig = {
  mode: (process.env.FOREX_MODE as 'execute' | 'dry-run') ?? 'dry-run',

  pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURGBP', 'XAUUSD'],

  defaultLeverage: 30,

  // Риск-менеджмент (FTMO-совместимый)
  maxRiskPerTradePct: 1.0,
  maxOpenPositions: 3,
  maxTradesPerDay: 5,
  maxDailyDrawdownPct: 4.0, // консервативнее чем FTMO лимит 5%
  maxTotalDrawdownPct: 8.0, // консервативнее чем FTMO лимит 10%
  minRR: 2.0,

  // Управление позициями
  partialClosePercent: 0.5,
  partialCloseAtR: 1.0,
  trailingStartR: 1.5,
  trailingDistanceR: 0.75,

  // Таймфреймы
  trendTimeframe: 'H4',
  entryTimeframe: 'M15',

  // cTrader
  environment: (process.env.CTRADER_ENVIRONMENT as 'demo' | 'live') ?? 'demo',
};

export default config;

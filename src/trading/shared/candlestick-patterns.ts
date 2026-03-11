import * as ti from 'technicalindicators';
import type { CandlestickPattern, OHLC } from './types.js';

interface CandleInput {
  open: number[];
  high: number[];
  close: number[];
  low: number[];
}

// technicalindicators — CJS без TypeScript типов, функции возвращают any.
// Обёртка явно кастует результат к boolean, чтобы удовлетворить ESLint no-unsafe-return.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TiPatternFn = (input: CandleInput) => any;

function callPattern(fn: TiPatternFn, input: CandleInput): boolean {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return Boolean(fn(input));
}

function toInput(candles: OHLC[], count: number = 5): CandleInput {
  const recent = candles.slice(-count);
  return {
    open: recent.map((c) => c.open),
    high: recent.map((c) => c.high),
    close: recent.map((c) => c.close),
    low: recent.map((c) => c.low),
  };
}

interface PatternDef {
  fn: TiPatternFn;
  name: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  strength: 1 | 2 | 3;
}

// Определяем паттерны с их характеристиками
const PATTERNS: PatternDef[] = [
  // Bullish reversal (strength 3 = самые сильные)
  { fn: ti.bullishengulfingpattern, name: 'BullishEngulfing', direction: 'BULLISH', strength: 3 },
  { fn: ti.morningstar, name: 'MorningStar', direction: 'BULLISH', strength: 3 },
  { fn: ti.threewhitesoldiers, name: 'ThreeWhiteSoldiers', direction: 'BULLISH', strength: 3 },
  { fn: ti.piercingline, name: 'PiercingLine', direction: 'BULLISH', strength: 2 },
  { fn: ti.hammerpattern, name: 'Hammer', direction: 'BULLISH', strength: 2 },
  { fn: ti.tweezerbottom, name: 'TweezerBottom', direction: 'BULLISH', strength: 2 },
  { fn: ti.morningdojistar, name: 'MorningDojiStar', direction: 'BULLISH', strength: 2 },
  { fn: ti.bullishharami, name: 'BullishHarami', direction: 'BULLISH', strength: 2 },
  { fn: ti.bullishharamicross, name: 'BullishHaramiCross', direction: 'BULLISH', strength: 2 },
  { fn: ti.bullishmarubozu, name: 'BullishMarubozu', direction: 'BULLISH', strength: 2 },
  { fn: ti.bullishhammerstick, name: 'BullishHammerStick', direction: 'BULLISH', strength: 1 },
  {
    fn: ti.bullishinvertedhammerstick,
    name: 'BullishInvertedHammerStick',
    direction: 'BULLISH',
    strength: 1,
  },
  { fn: ti.bullishspinningtop, name: 'BullishSpinningTop', direction: 'BULLISH', strength: 1 },

  // Bearish reversal
  { fn: ti.bearishengulfingpattern, name: 'BearishEngulfing', direction: 'BEARISH', strength: 3 },
  { fn: ti.eveningstar, name: 'EveningStar', direction: 'BEARISH', strength: 3 },
  { fn: ti.threeblackcrows, name: 'ThreeBlackCrows', direction: 'BEARISH', strength: 3 },
  { fn: ti.darkcloudcover, name: 'DarkCloudCover', direction: 'BEARISH', strength: 2 },
  { fn: ti.shootingstar, name: 'ShootingStar', direction: 'BEARISH', strength: 2 },
  { fn: ti.hangingman, name: 'HangingMan', direction: 'BEARISH', strength: 2 },
  { fn: ti.tweezertop, name: 'TweezerTop', direction: 'BEARISH', strength: 2 },
  { fn: ti.eveningdojistar, name: 'EveningDojiStar', direction: 'BEARISH', strength: 2 },
  { fn: ti.bearishharami, name: 'BearishHarami', direction: 'BEARISH', strength: 2 },
  { fn: ti.bearishharamicross, name: 'BearishHaramiCross', direction: 'BEARISH', strength: 2 },
  { fn: ti.bearishmarubozu, name: 'BearishMarubozu', direction: 'BEARISH', strength: 2 },
  { fn: ti.bearishhammerstick, name: 'BearishHammerStick', direction: 'BEARISH', strength: 1 },
  {
    fn: ti.bearishinvertedhammerstick,
    name: 'BearishInvertedHammerStick',
    direction: 'BEARISH',
    strength: 1,
  },
  { fn: ti.bearishspinningtop, name: 'BearishSpinningTop', direction: 'BEARISH', strength: 1 },
  { fn: ti.downsidetasukigap, name: 'DownsideTasukiGap', direction: 'BEARISH', strength: 2 },

  // Neutral / indecision
  { fn: ti.doji, name: 'Doji', direction: 'NEUTRAL', strength: 1 },
  { fn: ti.dragonflydoji, name: 'DragonflyDoji', direction: 'BULLISH', strength: 1 },
  { fn: ti.gravestonedoji, name: 'GravestoneDoji', direction: 'BEARISH', strength: 1 },
  { fn: ti.abandonedbaby, name: 'AbandonedBaby', direction: 'NEUTRAL', strength: 2 },
];

/**
 * Определяет свечные паттерны на последних 5 свечах.
 * Возвращает массив обнаруженных паттернов (обычно 0-2).
 */
export function detectCandlestickPatterns(candles: OHLC[]): CandlestickPattern[] {
  if (candles.length < 5) return [];

  const input = toInput(candles, 5);
  const detected: CandlestickPattern[] = [];

  for (const pattern of PATTERNS) {
    try {
      if (callPattern(pattern.fn, input)) {
        detected.push({
          name: pattern.name,
          direction: pattern.direction,
          strength: pattern.strength,
        });
      }
    } catch {
      // Некоторые паттерны требуют больше данных — пропускаем
    }
  }

  return detected;
}

/**
 * Скорит свечные паттерны для confluence.
 * Bullish patterns → положительный score, bearish → отрицательный.
 * Учитывает силу паттерна и направление тренда.
 */
export function scoreCandlestickPatterns(
  patterns: CandlestickPattern[],
  trendDirection: 'long' | 'short' | 'neutral',
): { score: number; details: string[] } {
  if (patterns.length === 0) return { score: 0, details: [] };

  let score = 0;
  const details: string[] = [];

  for (const p of patterns) {
    let points = p.strength * 2; // 2/4/6 points based on strength

    if (p.direction === 'BULLISH') {
      // Bullish pattern подтверждает long тренд (+bonus) или противоречит short (-penalty)
      if (trendDirection === 'long') points = Math.round(points * 1.3);
      score += points;
      details.push(`Candle: ${p.name} (bullish, +${points})`);
    } else if (p.direction === 'BEARISH') {
      if (trendDirection === 'short') points = Math.round(points * 1.3);
      score -= points;
      details.push(`Candle: ${p.name} (bearish, -${points})`);
    } else {
      // NEUTRAL (Doji) — индикация неопределённости, слабый сигнал в сторону тренда
      if (trendDirection === 'long') score += 1;
      else if (trendDirection === 'short') score -= 1;
      details.push(`Candle: ${p.name} (neutral)`);
    }
  }

  // Clamp to -10..+10
  return {
    score: Math.max(-10, Math.min(10, score)),
    details,
  };
}

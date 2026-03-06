// Точные спецификации Bybit USDT Perpetual (qty step -> decimals, price tick -> decimals)
// Источник: Bybit Instruments Info API для каждого символа
const SYMBOL_SPECS: Record<string, { qtyDec: number; priceDec: number }> = {
  BTCUSDT: { qtyDec: 3, priceDec: 1 }, // step=0.001, tick=0.1
  ETHUSDT: { qtyDec: 2, priceDec: 2 }, // step=0.01,  tick=0.01
  SOLUSDT: { qtyDec: 1, priceDec: 2 }, // step=0.1,   tick=0.01
  XRPUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  DOGEUSDT: { qtyDec: 0, priceDec: 5 }, // step=1,     tick=0.00001
  AVAXUSDT: { qtyDec: 1, priceDec: 2 }, // step=0.1,   tick=0.01
  LINKUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  ADAUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  BNBUSDT: { qtyDec: 2, priceDec: 2 }, // step=0.01,  tick=0.01
  SUIUSDT: { qtyDec: 1, priceDec: 4 }, // step=0.1,   tick=0.0001
  DOTUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  MATICUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  ARBUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  OPUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
};

export function getQtyPrecision(symbol: string): number {
  return SYMBOL_SPECS[symbol]?.qtyDec ?? 1;
}

export function formatQty(qty: number, symbol: string): string {
  const prec = getQtyPrecision(symbol);
  const formatted = qty.toFixed(prec);
  const minQty = Math.pow(10, -prec);
  return parseFloat(formatted) < minQty ? minQty.toFixed(prec) : formatted;
}

export function roundPrice(val: number, symbol: string): number {
  const prec = SYMBOL_SPECS[symbol]?.priceDec ?? 4;
  return parseFloat(val.toFixed(prec));
}

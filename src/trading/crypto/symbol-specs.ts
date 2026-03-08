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
  ZECUSDT: { qtyDec: 2, priceDec: 2 }, // step=0.01,  tick=0.01
  SUIUSDT: { qtyDec: 1, priceDec: 4 }, // step=0.1,   tick=0.0001
  DOTUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  MATICUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  ARBUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  OPUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  NEARUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  APTUSDT: { qtyDec: 1, priceDec: 2 }, // step=0.1,   tick=0.01
  PEPEUSDT: { qtyDec: 0, priceDec: 7 }, // step=1,     tick=0.0000001
  '1000PEPEUSDT': { qtyDec: 0, priceDec: 6 }, // step=1, tick=0.000001
  LTCUSDT: { qtyDec: 2, priceDec: 2 }, // step=0.01,  tick=0.01
  FILUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  ATOMUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  INJUSDT: { qtyDec: 1, priceDec: 2 }, // step=0.1,   tick=0.01
  AAVEUSDT: { qtyDec: 2, priceDec: 2 }, // step=0.01,  tick=0.01
  UNIUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  TIAUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  RENDERUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  FETUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  WLDUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  ONDOUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  JUPUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  TRXUSDT: { qtyDec: 0, priceDec: 5 }, // step=1,     tick=0.00001
  TONUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  SHIBUSDT: { qtyDec: 0, priceDec: 7 }, // step=1,     tick=0.0000001
  '1000SHIBUSDT': { qtyDec: 0, priceDec: 6 }, // step=1, tick=0.000001
  MKRUSDT: { qtyDec: 3, priceDec: 1 }, // step=0.001, tick=0.1
  STXUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  SEIUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  PENDLEUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  ENAUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  EIGENUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  WUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  ICPUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  THETAUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  GRTUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  ALGOUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  FTMUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  RUNEUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  LDOUSDT: { qtyDec: 1, priceDec: 3 }, // step=0.1,   tick=0.001
  PYTHUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  BOMEUSDT: { qtyDec: 0, priceDec: 5 }, // step=1,     tick=0.00001
  CRVUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
  SANDUSDT: { qtyDec: 0, priceDec: 4 }, // step=1,     tick=0.0001
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

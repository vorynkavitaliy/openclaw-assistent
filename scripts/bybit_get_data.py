#!/usr/bin/env python3
"""
Bybit Get Data — получает OHLC данные и индикаторы через Bybit API v5.

Используется Crypto Trader агентом для технического анализа.
Работает напрямую через REST API (без SDK — минимум зависимостей).

Использование:
    python3 bybit_get_data.py --pair BTCUSDT --tf 15 --bars 100
    python3 bybit_get_data.py --pair ETHUSDT --tf 240 --bars 50
    python3 bybit_get_data.py --pair BTCUSDT --market-info
"""

import argparse
import json
import sys
import os
from datetime import datetime
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# Bybit API v5
BYBIT_MAINNET = "https://api.bybit.com"
BYBIT_TESTNET = "https://api-testnet.bybit.com"

# Таймфреймы: ключ CLI → значение Bybit API
TIMEFRAME_MAP = {
    "1": "1", "3": "3", "5": "5", "15": "15", "30": "30",
    "60": "60", "120": "120", "240": "240", "360": "360", "720": "720",
    "D": "D", "W": "W", "M": "M",
    # Aliases
    "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
    "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
    "1d": "D", "1w": "W",
    "M1": "1", "M5": "5", "M15": "15", "M30": "30",
    "H1": "60", "H4": "240", "D1": "D",
}


def get_base_url() -> str:
    """Возвращает base URL для API."""
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                # Простой парсинг json5 — убираем комментарии
                content = f.read()
                lines = [l for l in content.split("\n") if not l.strip().startswith("//")]
                config = json.loads("\n".join(lines))
                if config.get("bybit", {}).get("testnet", False):
                    return BYBIT_TESTNET
        except (json.JSONDecodeError, KeyError):
            pass
    return BYBIT_MAINNET


def api_get(endpoint: str, params: dict = None) -> dict:
    """GET запрос к Bybit API v5 (публичные endpoints, без авторизации)."""
    base = get_base_url()
    url = f"{base}{endpoint}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        url = f"{url}?{query}"

    req = Request(url, headers={"User-Agent": "OpenClaw/1.0"})
    try:
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            if data.get("retCode") != 0:
                return {"error": data.get("retMsg", "Unknown API error"), "retCode": data.get("retCode")}
            return data.get("result", {})
    except HTTPError as e:
        return {"error": f"HTTP {e.code}: {e.reason}"}
    except URLError as e:
        return {"error": f"Network error: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


def get_klines(symbol: str, interval: str, limit: int = 100) -> list:
    """Получает OHLC свечи с Bybit."""
    result = api_get("/v5/market/kline", {
        "category": "linear",
        "symbol": symbol,
        "interval": interval,
        "limit": min(limit, 1000),
    })
    if "error" in result:
        return []

    rows = []
    for item in reversed(result.get("list", [])):
        # Bybit формат: [startTime, open, high, low, close, volume, turnover]
        try:
            rows.append({
                "time": datetime.fromtimestamp(int(item[0]) / 1000).isoformat(),
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),
                "volume": float(item[5]),
                "turnover": float(item[6]),
            })
        except (ValueError, IndexError):
            continue
    return rows


def get_market_info(symbol: str) -> dict:
    """Получает рыночные метрики: тикер, funding rate, open interest."""
    ticker = api_get("/v5/market/tickers", {"category": "linear", "symbol": symbol})
    funding = api_get("/v5/market/funding/history", {"category": "linear", "symbol": symbol, "limit": "1"})
    oi = api_get("/v5/market/open-interest", {"category": "linear", "symbol": symbol, "intervalTime": "5min", "limit": "1"})

    info = {}

    # Ticker data
    ticker_list = ticker.get("list", [])
    if ticker_list:
        t = ticker_list[0]
        info["last_price"] = float(t.get("lastPrice", 0))
        info["price_24h_pct"] = float(t.get("price24hPcnt", 0)) * 100
        info["volume_24h"] = float(t.get("volume24h", 0))
        info["turnover_24h"] = float(t.get("turnover24h", 0))
        info["high_24h"] = float(t.get("highPrice24h", 0))
        info["low_24h"] = float(t.get("lowPrice24h", 0))
        info["funding_rate"] = float(t.get("fundingRate", 0))
        info["next_funding_time"] = t.get("nextFundingTime", "")
        info["bid1"] = float(t.get("bid1Price", 0))
        info["ask1"] = float(t.get("ask1Price", 0))

    # Funding history
    funding_list = funding.get("list", [])
    if funding_list:
        info["last_funding_rate"] = float(funding_list[0].get("fundingRate", 0))
        info["last_funding_time"] = funding_list[0].get("fundingRateTimestamp", "")

    # Open Interest
    oi_list = oi.get("list", [])
    if oi_list:
        info["open_interest"] = float(oi_list[0].get("openInterest", 0))
        info["oi_timestamp"] = oi_list[0].get("timestamp", "")

    return info


def calculate_ema(prices: list, period: int) -> list:
    """Вычисляет EMA (Exponential Moving Average)."""
    if len(prices) < period:
        return []
    k = 2 / (period + 1)
    ema = [sum(prices[:period]) / period]
    for price in prices[period:]:
        ema.append(price * k + ema[-1] * (1 - k))
    return ema


def calculate_rsi(closes: list, period: int = 14) -> float:
    """Вычисляет RSI."""
    if len(closes) < period + 1:
        return 50.0
    deltas = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    gains = [d for d in deltas[-period:] if d > 0]
    losses = [abs(d) for d in deltas[-period:] if d < 0]
    avg_gain = sum(gains) / period if gains else 0
    avg_loss = sum(losses) / period if losses else 0
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def calculate_atr(highs: list, lows: list, closes: list, period: int = 14) -> float:
    """Вычисляет ATR (Average True Range)."""
    if len(highs) < period + 1:
        return 0.0
    trs = []
    for i in range(1, len(highs)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1])
        )
        trs.append(tr)
    return round(sum(trs[-period:]) / period, 2)


def main():
    parser = argparse.ArgumentParser(description="Bybit Get Data — OHLC данные и индикаторы")
    parser.add_argument("--pair", required=True, help="Торговая пара (BTCUSDT, ETHUSDT...)")
    parser.add_argument("--tf", default="15", help="Таймфрейм (1,5,15,60,240,D)")
    parser.add_argument("--bars", type=int, default=100, help="Количество баров (макс 1000)")
    parser.add_argument("--market-info", action="store_true", help="Рыночные метрики (funding, OI, volume)")
    args = parser.parse_args()

    pair = args.pair.upper()

    # Market info mode
    if args.market_info:
        info = get_market_info(pair)
        if not info:
            print(json.dumps({"error": f"Не удалось получить данные для {pair}"}))
            sys.exit(1)

        # Funding rate интерпретация
        fr = info.get("funding_rate", 0)
        if fr > 0.0003:
            info["funding_signal"] = "ПЕРЕГРЕТ_ЛОНГИ"
        elif fr < -0.0003:
            info["funding_signal"] = "ПЕРЕГРЕТ_ШОРТЫ"
        else:
            info["funding_signal"] = "НЕЙТРАЛЬНО"

        result = {
            "pair": pair,
            "type": "market_info",
            "data": info,
            "timestamp": datetime.now().isoformat(),
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    # OHLC + indicators mode
    tf_input = args.tf.upper() if args.tf.upper() in TIMEFRAME_MAP else args.tf
    interval = TIMEFRAME_MAP.get(tf_input, args.tf)

    rows = get_klines(pair, interval, args.bars)
    if not rows:
        print(json.dumps({"error": f"Нет данных для {pair} tf={interval}. Проверь пару и таймфрейм."}))
        sys.exit(1)

    # Вычисляем индикаторы
    closes = [r["close"] for r in rows]
    highs = [r["high"] for r in rows]
    lows = [r["low"] for r in rows]

    ema200 = calculate_ema(closes, 200)
    ema50 = calculate_ema(closes, 50)
    ema20 = calculate_ema(closes, 20)
    rsi14 = calculate_rsi(closes, 14)
    atr14 = calculate_atr(highs, lows, closes, 14)

    current_price = closes[-1]
    ema200_val = round(ema200[-1], 2) if ema200 else None
    ema50_val = round(ema50[-1], 2) if ema50 else None
    ema20_val = round(ema20[-1], 2) if ema20 else None

    # Уровни поддержки/сопротивления
    recent = rows[-20:] if len(rows) >= 20 else rows
    resistance = round(max(r["high"] for r in recent), 2)
    support = round(min(r["low"] for r in recent), 2)

    result = {
        "pair": pair,
        "timeframe": interval,
        "bars_count": len(rows),
        "source": "BYBIT_API_V5",
        "current_price": round(current_price, 2),
        "last_bar": rows[-1],
        "indicators": {
            "ema200": ema200_val,
            "ema50": ema50_val,
            "ema20": ema20_val,
            "rsi14": rsi14,
            "atr14": atr14,
        },
        "levels": {
            "resistance": resistance,
            "support": support,
        },
        "bias": {
            "ema_trend": "BULLISH" if (ema50_val and ema200_val and ema50_val > ema200_val) else "BEARISH" if (ema50_val and ema200_val) else "UNKNOWN",
            "price_vs_ema200": "ABOVE" if (ema200_val and current_price > ema200_val) else "BELOW" if ema200_val else "UNKNOWN",
            "rsi_zone": "OVERBOUGHT" if rsi14 > 70 else "OVERSOLD" if rsi14 < 30 else "NEUTRAL",
        },
        "timestamp": datetime.now().isoformat(),
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

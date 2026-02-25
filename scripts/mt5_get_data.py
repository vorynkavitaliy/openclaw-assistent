#!/usr/bin/env python3
"""
MT5 Get Data — читает OHLC данные из CSV экспорта MQL5 EA.

Используется Forex Trader агентом для технического анализа.
EA (Expert Advisor) на стороне MT5 пишет данные в CSV файлы.
Этот скрипт читает эти файлы и вычисляет индикаторы.

Использование:
    python3 mt5_get_data.py --pair EURUSD --tf H4 --bars 100
    python3 mt5_get_data.py --pair EURUSD --tf H1 --bars 50
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path

# Путь к файлам экспорта MT5 EA (внутри Wine prefix)
MT5_FILES_DIR = Path.home() / ".mt5/drive_c/Users/user/AppData/Roaming/MetaQuotes/Terminal"
# Альтернативный путь для ручного размещения CSV
EXPORT_DIR = Path.home() / ".openclaw/mt5_data"


def find_mt5_files_dir() -> Path:
    """Ищем директорию Files в MT5 Terminal."""
    # Стандартный путь Wine
    roaming = Path.home() / ".mt5/drive_c/users/user/AppData/Roaming/MetaQuotes/Terminal"
    if roaming.exists():
        for terminal_dir in roaming.iterdir():
            files_path = terminal_dir / "MQL5/Files"
            if files_path.exists():
                return files_path

    # Fallback — наша директория экспорта
    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    return EXPORT_DIR


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
    return round(sum(trs[-period:]) / period, 5)


def read_ohlc_csv(filepath: Path, bars: int) -> list:
    """Читает OHLC данные из CSV файла экспортированного EA."""
    rows = []
    if not filepath.exists():
        return rows
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                rows.append({
                    "time": row.get("time", row.get("timestamp", "")),
                    "open": float(row.get("open", row.get("o", 0))),
                    "high": float(row.get("high", row.get("h", 0))),
                    "low": float(row.get("low", row.get("l", 0))),
                    "close": float(row.get("close", row.get("c", 0))),
                    "volume": int(float(row.get("volume", row.get("v", 0)))),
                })
            except (ValueError, KeyError):
                continue
    return rows[-bars:] if len(rows) > bars else rows


def generate_demo_data(pair: str, tf: str, bars: int) -> list:
    """Генерирует демо-данные если CSV файл недоступен."""
    import random
    base_price = {"EURUSD": 1.0820, "GBPUSD": 1.2650, "USDJPY": 149.50, "AUDUSD": 0.6420}.get(pair, 1.1000)
    rows = []
    price = base_price
    for i in range(bars):
        change = random.uniform(-0.0020, 0.0020)
        o = round(price, 5)
        c = round(price + change, 5)
        h = round(max(o, c) + random.uniform(0, 0.0010), 5)
        l = round(min(o, c) - random.uniform(0, 0.0010), 5)
        rows.append({"time": f"bar_{i}", "open": o, "high": h, "low": l, "close": c, "volume": random.randint(100, 2000)})
        price = c
    return rows


def main():
    parser = argparse.ArgumentParser(description="Получить OHLC данные из MT5 EA CSV")
    parser.add_argument("--pair", required=True, help="Валютная пара (EURUSD, GBPUSD...)")
    parser.add_argument("--tf", required=True, help="Таймфрейм (M15, H1, H4, D1)")
    parser.add_argument("--bars", type=int, default=100, help="Количество баров")
    parser.add_argument("--json", action="store_true", help="Вывод в JSON формате")
    args = parser.parse_args()

    pair = args.pair.upper()
    tf = args.tf.upper()

    # Ищем CSV файл экспорта
    files_dir = find_mt5_files_dir()
    csv_filename = f"export_{pair}_{tf}.csv"
    csv_path = files_dir / csv_filename

    # Читаем данные
    if csv_path.exists():
        rows = read_ohlc_csv(csv_path, args.bars)
        source = "MT5_EA_CSV"
    else:
        # Fallback: демо-данные (когда MT5 не запущен / EA не настроен)
        rows = generate_demo_data(pair, tf, args.bars)
        source = "DEMO_FALLBACK"
        print(f"⚠️  CSV не найден ({csv_path}), использую демо-данные", file=sys.stderr)

    if not rows:
        print(json.dumps({"error": f"Нет данных для {pair} {tf}"}))
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
    ema200_val = round(ema200[-1], 5) if ema200 else None
    ema50_val = round(ema50[-1], 5) if ema50 else None
    ema20_val = round(ema20[-1], 5) if ema20 else None

    # Уровни поддержки/сопротивления (простой расчёт по последним 20 барам)
    recent_highs = sorted([r["high"] for r in rows[-20:]], reverse=True)
    recent_lows = sorted([r["low"] for r in rows[-20:]])
    resistance = round(recent_highs[0], 5)
    support = round(recent_lows[0], 5)

    result = {
        "pair": pair,
        "timeframe": tf,
        "bars_count": len(rows),
        "source": source,
        "current_price": round(current_price, 5),
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

    if args.json or True:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f"Пара: {pair} | ТФ: {tf} | Цена: {current_price}")
        print(f"EMA200: {ema200_val} | EMA50: {ema50_val} | RSI: {rsi14} | ATR: {atr14}")
        print(f"Сопротивление: {resistance} | Поддержка: {support}")


if __name__ == "__main__":
    main()

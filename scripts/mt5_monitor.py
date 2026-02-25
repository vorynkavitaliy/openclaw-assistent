#!/usr/bin/env python3
"""
MT5 Monitor — читает данные о позициях и счёте из CSV файлов EA.

EA на стороне MT5 автоматически обновляет:
  - export_positions.csv — открытые позиции
  - export_account.csv  — состояние счёта (баланс, equity, маржа)
  - export_prices.csv   — текущие цены пар

Этот скрипт читает эти файлы и возвращает структурированные данные агенту.

Использование:
    python3 mt5_monitor.py --positions       # Открытые позиции
    python3 mt5_monitor.py --account         # Состояние счёта
    python3 mt5_monitor.py --heartbeat       # Полная проверка для Heartbeat
    python3 mt5_monitor.py --risk-check      # Проверка риск-лимитов
"""

import argparse
import csv
import json
import os
import sys
from datetime import datetime
from pathlib import Path

MT5_DATA_DIR = Path.home() / ".openclaw/mt5_data"
POSITIONS_CSV = MT5_DATA_DIR / "export_positions.csv"
ACCOUNT_CSV = MT5_DATA_DIR / "export_account.csv"
PRICES_CSV = MT5_DATA_DIR / "export_prices.csv"

# Риск-лимиты FTMO
MAX_DAILY_DRAWDOWN_PCT = 4.0   # 4% максимальный дневной дродаун
MAX_TOTAL_DRAWDOWN_PCT = 10.0  # 10% максимальный общий дродаун
MAX_RISK_PER_TRADE_PCT = 2.0   # 2% максимальный риск на сделку
MIN_RR_RATIO = 2.0             # Минимальный R:R


def ensure_dirs():
    MT5_DATA_DIR.mkdir(parents=True, exist_ok=True)


def read_positions(filepath: Path) -> list:
    """Читает открытые позиции из CSV."""
    positions = []
    if not filepath.exists():
        return positions
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                positions.append({
                    "ticket": int(row.get("ticket", 0)),
                    "pair": row.get("symbol", row.get("pair", "")),
                    "type": row.get("type", ""),
                    "lot": float(row.get("volume", row.get("lot", 0))),
                    "open_price": float(row.get("open_price", row.get("price_open", 0))),
                    "current_price": float(row.get("price_current", row.get("current_price", 0))),
                    "sl": float(row.get("sl", row.get("stop_loss", 0))),
                    "tp": float(row.get("tp", row.get("take_profit", 0))),
                    "profit": float(row.get("profit", 0)),
                    "swap": float(row.get("swap", 0)),
                    "open_time": row.get("time", row.get("open_time", "")),
                    "comment": row.get("comment", ""),
                })
            except (ValueError, KeyError):
                continue
    return positions


def read_account(filepath: Path) -> dict:
    """Читает данные счёта из CSV."""
    if not filepath.exists():
        return {}
    with open(filepath, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            try:
                return {
                    "balance": float(row.get("balance", 0)),
                    "equity": float(row.get("equity", 0)),
                    "margin": float(row.get("margin", 0)),
                    "free_margin": float(row.get("margin_free", row.get("free_margin", 0))),
                    "margin_level": float(row.get("margin_level", 0)),
                    "profit": float(row.get("profit", 0)),
                    "currency": row.get("currency", "USD"),
                    "timestamp": row.get("timestamp", datetime.now().isoformat()),
                }
            except (ValueError, KeyError):
                pass
    return {}


def demo_account() -> dict:
    """Демо-данные счёта для тестирования."""
    return {
        "balance": 10000.00,
        "equity": 10025.50,
        "margin": 200.00,
        "free_margin": 9825.50,
        "margin_level": 5012.75,
        "profit": 25.50,
        "currency": "USD",
        "timestamp": datetime.now().isoformat(),
        "_demo": True,
    }


def demo_positions() -> list:
    """Демо-позиции для тестирования."""
    return [
        {
            "ticket": 123456789,
            "pair": "EURUSD",
            "type": "BUY",
            "lot": 0.10,
            "open_price": 1.08000,
            "current_price": 1.08250,
            "sl": 1.07500,
            "tp": 1.09000,
            "profit": 25.00,
            "swap": -0.50,
            "open_time": "2026-02-25 10:30:00",
            "comment": "OpenClaw",
            "_demo": True,
        }
    ]


def check_position_risks(positions: list, account: dict) -> list:
    """Проверяет риски открытых позиций."""
    alerts = []
    balance = account.get("balance", 10000)

    for pos in positions:
        ticket = pos["ticket"]
        # Позиция без SL — критично
        if pos["sl"] == 0:
            alerts.append({
                "level": "CRITICAL",
                "ticket": ticket,
                "pair": pos["pair"],
                "message": f"⚠️ ПОЗИЦИЯ БЕЗ STOP LOSS! Тикет: {ticket} | {pos['pair']} | Лот: {pos['lot']}",
            })

        # Расчёт текущего риска в %
        if pos["sl"] > 0 and pos["open_price"] > 0:
            pip_diff = abs(pos["open_price"] - pos["sl"])
            # Упрощённый расчёт для мажоров (10$/pip per lot)
            risk_usd = pip_diff * 10000 * pos["lot"] * 10
            risk_pct = (risk_usd / balance) * 100 if balance > 0 else 0
            if risk_pct > MAX_RISK_PER_TRADE_PCT:
                alerts.append({
                    "level": "WARNING",
                    "ticket": ticket,
                    "pair": pos["pair"],
                    "message": f"⚠️ Риск {risk_pct:.1f}% > {MAX_RISK_PER_TRADE_PCT}% | Тикет: {ticket}",
                })

    return alerts


def check_drawdown(account: dict) -> list:
    """Проверяет дродаун счёта."""
    alerts = []
    balance = account.get("balance", 0)
    equity = account.get("equity", 0)
    if balance == 0:
        return alerts

    drawdown_pct = ((balance - equity) / balance) * 100 if equity < balance else 0

    if drawdown_pct >= MAX_DAILY_DRAWDOWN_PCT:
        alerts.append({
            "level": "CRITICAL",
            "message": f"🚨 ДНЕВНОЙ ДРОДАУН {drawdown_pct:.1f}% ДОСТИГ ЛИМИТА {MAX_DAILY_DRAWDOWN_PCT}%! СТОП ТОРГОВЛЯ!",
            "drawdown_pct": round(drawdown_pct, 2),
            "limit_pct": MAX_DAILY_DRAWDOWN_PCT,
        })
    elif drawdown_pct >= MAX_DAILY_DRAWDOWN_PCT * 0.75:
        alerts.append({
            "level": "WARNING",
            "message": f"⚠️ Дродаун {drawdown_pct:.1f}% приближается к лимиту {MAX_DAILY_DRAWDOWN_PCT}%",
            "drawdown_pct": round(drawdown_pct, 2),
        })

    return alerts


def main():
    parser = argparse.ArgumentParser(description="MT5 Monitor — мониторинг позиций и счёта")
    parser.add_argument("--positions", action="store_true", help="Показать открытые позиции")
    parser.add_argument("--account", action="store_true", help="Показать состояние счёта")
    parser.add_argument("--heartbeat", action="store_true", help="Полная проверка (Heartbeat)")
    parser.add_argument("--risk-check", action="store_true", help="Проверка риск-лимитов")
    args = parser.parse_args()

    ensure_dirs()

    # Читаем данные
    positions = read_positions(POSITIONS_CSV)
    account = read_account(ACCOUNT_CSV)
    using_demo = False

    if not positions and not POSITIONS_CSV.exists():
        positions = demo_positions()
        using_demo = True
    if not account:
        account = demo_account()
        using_demo = True

    result = {"timestamp": datetime.now().isoformat()}
    if using_demo:
        result["_note"] = "DEMO данные — MT5 EA файлы не найдены в " + str(MT5_DATA_DIR)

    if args.positions or args.heartbeat:
        result["positions"] = positions
        result["positions_count"] = len(positions)
        result["total_profit"] = round(sum(p["profit"] for p in positions), 2)

    if args.account or args.heartbeat:
        result["account"] = account

    if args.risk_check or args.heartbeat:
        position_alerts = check_position_risks(positions, account)
        drawdown_alerts = check_drawdown(account)
        all_alerts = position_alerts + drawdown_alerts
        result["alerts"] = all_alerts
        result["alerts_count"] = len(all_alerts)
        result["risk_status"] = "CRITICAL" if any(a["level"] == "CRITICAL" for a in all_alerts) \
                                 else "WARNING" if any(a["level"] == "WARNING" for a in all_alerts) \
                                 else "OK"

    if args.heartbeat:
        # Формируем Heartbeat отчёт для агента
        equity = account.get("equity", 0)
        balance = account.get("balance", 0)
        drawdown_pct = round(((balance - equity) / balance * 100), 2) if balance and equity < balance else 0.0
        result["heartbeat_summary"] = {
            "balance": balance,
            "equity": equity,
            "drawdown_pct": drawdown_pct,
            "open_positions": len(positions),
            "total_profit": round(sum(p["profit"] for p in positions), 2),
            "positions_without_sl": sum(1 for p in positions if p["sl"] == 0),
            "margin_level": account.get("margin_level", 0),
            "trading_allowed": drawdown_pct < MAX_DAILY_DRAWDOWN_PCT,
        }

    if not any([args.positions, args.account, args.heartbeat, args.risk_check]):
        # Без флагов — показываем всё
        result["positions"] = positions
        result["account"] = account

    print(json.dumps(result, ensure_ascii=False, indent=2))

    # Выходной код на основе критических алертов
    if result.get("risk_status") == "CRITICAL":
        sys.exit(2)


if __name__ == "__main__":
    main()

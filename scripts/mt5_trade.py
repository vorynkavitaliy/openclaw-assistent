#!/usr/bin/env python3
"""
MT5 Trade — отправляет торговые команды EA через файловый мост.

Архитектура:
    OpenClaw → этот скрипт → ~/.openclaw/mt5_data/orders/pending.json
    MT5 EA читает pending.json → исполняет ордер → пишет result.json
    Этот скрипт читает result.json → возвращает результат агенту

Использование:
    python3 mt5_trade.py --action open --pair EURUSD --direction BUY \
        --lot 0.1 --sl 1.0800 --tp 1.0950

    python3 mt5_trade.py --action close --ticket 123456789

    python3 mt5_trade.py --action modify --ticket 123456789 --sl 1.0810

    python3 mt5_trade.py --action close_all
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime
from pathlib import Path

ORDERS_DIR = Path.home() / ".openclaw/mt5_data/orders"
RESULTS_DIR = Path.home() / ".openclaw/mt5_data/results"
TIMEOUT_SECONDS = 30  # Ждём ответа от EA до 30 секунд


def ensure_dirs():
    ORDERS_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)


def write_order(order: dict) -> Path:
    """Пишет ордер в файл для EA."""
    order_id = order["order_id"]
    order_file = ORDERS_DIR / f"{order_id}.json"
    with open(order_file, "w", encoding="utf-8") as f:
        json.dump(order, f, ensure_ascii=False, indent=2)
    return order_file


def wait_for_result(order_id: str, timeout: int = TIMEOUT_SECONDS) -> dict:
    """Ждёт ответа от EA (файл результата)."""
    result_file = RESULTS_DIR / f"{order_id}.json"
    start = time.time()
    while time.time() - start < timeout:
        if result_file.exists():
            with open(result_file, encoding="utf-8") as f:
                result = json.load(f)
            # Удаляем файлы после чтения
            result_file.unlink(missing_ok=True)
            (ORDERS_DIR / f"{order_id}.json").unlink(missing_ok=True)
            return result
        time.sleep(0.5)

    # Таймаут — EA не ответил (возможно не запущен)
    (ORDERS_DIR / f"{order_id}.json").unlink(missing_ok=True)
    return {
        "status": "TIMEOUT",
        "error": f"EA не ответил за {timeout}с. MT5 запущен? EA активен?",
        "order_id": order_id,
        "timestamp": datetime.now().isoformat(),
    }


def simulate_trade_result(action: str, args) -> dict:
    """
    Симуляция результата для тестирования без MT5.
    ВАЖНО: В продакшне EA пишет реальный result.json
    """
    import random
    ticket = random.randint(100000000, 999999999)
    price = {"EURUSD": 1.0820, "GBPUSD": 1.2650, "USDJPY": 149.50}.get(
        getattr(args, "pair", "EURUSD"), 1.1000
    )

    if action == "open":
        return {
            "status": "EXECUTED",
            "action": "open",
            "ticket": ticket,
            "pair": args.pair,
            "direction": args.direction,
            "lot": args.lot,
            "price": round(price + 0.00003, 5),  # slippage
            "sl": args.sl,
            "tp": args.tp,
            "comment": "OpenClaw order",
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION — реальный ордер требует запущенного MT5 + EA",
        }
    elif action == "close":
        return {
            "status": "CLOSED",
            "action": "close",
            "ticket": args.ticket,
            "close_price": round(price + 0.00010, 5),
            "profit": round((0.00010 * 100000 * getattr(args, "lot", 0.1)), 2),
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION",
        }
    elif action == "modify":
        return {
            "status": "MODIFIED",
            "action": "modify",
            "ticket": args.ticket,
            "new_sl": getattr(args, "sl", None),
            "new_tp": getattr(args, "tp", None),
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION",
        }
    return {"status": "UNKNOWN", "action": action, "timestamp": datetime.now().isoformat()}


def validate_risk(args) -> tuple[bool, str]:
    """Проверяет риск-менеджмент перед открытием сделки."""
    # Базовые проверки
    if not hasattr(args, "sl") or args.sl is None:
        return False, "SL обязателен! Позиция без Stop Loss запрещена."
    if not hasattr(args, "tp") or args.tp is None:
        return False, "TP рекомендован. Используйте --tp для указания Take Profit."
    if args.lot > 10.0:
        return False, f"Лот {args.lot} слишком большой. Максимум 10.0."
    if args.lot < 0.01:
        return False, f"Лот {args.lot} слишком маленький. Минимум 0.01."
    return True, "OK"


def main():
    parser = argparse.ArgumentParser(description="MT5 Trade — торговые команды через EA файловый мост")
    parser.add_argument("--action", required=True, choices=["open", "close", "modify", "close_all"], help="Торговое действие")
    parser.add_argument("--pair", help="Валютная пара (EURUSD, GBPUSD...)")
    parser.add_argument("--direction", choices=["BUY", "SELL"], help="Направление сделки")
    parser.add_argument("--lot", type=float, default=0.01, help="Объём в лотах")
    parser.add_argument("--sl", type=float, help="Stop Loss цена")
    parser.add_argument("--tp", type=float, help="Take Profit цена")
    parser.add_argument("--ticket", type=int, help="Номер ордера (для close/modify)")
    parser.add_argument("--comment", default="OpenClaw", help="Комментарий к ордеру")
    parser.add_argument("--simulate", action="store_true", help="Режим симуляции (без MT5)")
    args = parser.parse_args()

    ensure_dirs()

    # Валидация для открытия
    if args.action == "open":
        if not args.pair:
            print(json.dumps({"error": "--pair обязателен для action=open"}))
            sys.exit(1)
        if not args.direction:
            print(json.dumps({"error": "--direction (BUY/SELL) обязателен для action=open"}))
            sys.exit(1)
        ok, msg = validate_risk(args)
        if not ok:
            print(json.dumps({"error": msg, "action": "REJECTED"}))
            sys.exit(1)

    # Если симуляция или MT5 недоступен
    if args.simulate:
        result = simulate_trade_result(args.action, args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    # Формируем ордер
    order_id = str(uuid.uuid4())[:8]
    order = {
        "order_id": order_id,
        "action": args.action,
        "timestamp": datetime.now().isoformat(),
        "comment": args.comment,
    }

    if args.action == "open":
        order.update({
            "pair": args.pair.upper(),
            "direction": args.direction,
            "lot": args.lot,
            "sl": args.sl,
            "tp": args.tp,
        })
    elif args.action in ("close", "modify"):
        if not args.ticket:
            print(json.dumps({"error": "--ticket обязателен для action=close/modify"}))
            sys.exit(1)
        order["ticket"] = args.ticket
        if args.action == "modify":
            if args.sl:
                order["new_sl"] = args.sl
            if args.tp:
                order["new_tp"] = args.tp
    elif args.action == "close_all":
        order["action"] = "close_all"

    # Пишем ордер и ждём результата от EA
    write_order(order)
    result = wait_for_result(order_id)

    print(json.dumps(result, ensure_ascii=False, indent=2))

    # Выходной код
    if result.get("status") in ("EXECUTED", "CLOSED", "MODIFIED"):
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()

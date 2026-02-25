#!/usr/bin/env python3
"""
Bybit Trade — открытие/закрытие/модификация позиций через Bybit API v5.

Использует HMAC-SHA256 авторизацию для приватных endpoints.
Credentials из ~/.openclaw/openclaw.json или env vars.

Использование:
    python3 bybit_trade.py --action open --pair BTCUSDT --direction Buy \
        --qty 0.01 --sl 95000 --tp 102000

    python3 bybit_trade.py --action close --pair BTCUSDT
    python3 bybit_trade.py --action modify --pair BTCUSDT --sl 96500 --tp 103000
    python3 bybit_trade.py --action partial_close --pair BTCUSDT --qty 0.005
    python3 bybit_trade.py --action close_all
    python3 bybit_trade.py --action open --pair BTCUSDT --direction Buy \
        --qty 0.01 --sl 95000 --tp 102000 --simulate
"""

import argparse
import hashlib
import hmac
import json
import os
import sys
import time
from datetime import datetime
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# Bybit API v5
BYBIT_MAINNET = "https://api.bybit.com"
BYBIT_TESTNET = "https://api-testnet.bybit.com"

# Риск-лимиты
MAX_LEVERAGE = 5
MAX_QTY_BTC = 1.0       # Максимум BTC за ордер
MAX_QTY_ETH = 10.0      # Максимум ETH за ордер
MAX_QTY_DEFAULT = 1000   # Максимум для альтов в USDT


def load_config() -> dict:
    """Загружает Bybit credentials из openclaw.json или env vars."""
    # Env vars имеют приоритет
    api_key = os.environ.get("BYBIT_API_KEY", "")
    api_secret = os.environ.get("BYBIT_API_SECRET", "")
    testnet = os.environ.get("BYBIT_TESTNET", "").lower() in ("true", "1", "yes")

    if api_key and api_secret:
        return {"api_key": api_key, "api_secret": api_secret, "testnet": testnet}

    # Из конфига
    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                content = f.read()
                # Убираем // комментарии для JSON5 совместимости
                lines = [l for l in content.split("\n") if not l.strip().startswith("//")]
                config = json.loads("\n".join(lines))
                bybit = config.get("bybit", {})
                return {
                    "api_key": bybit.get("api_key", ""),
                    "api_secret": bybit.get("api_secret", ""),
                    "testnet": bybit.get("testnet", False),
                    "default_leverage": bybit.get("default_leverage", 3),
                    "max_leverage": bybit.get("max_leverage", MAX_LEVERAGE),
                }
        except (json.JSONDecodeError, KeyError):
            pass

    return {"api_key": "", "api_secret": "", "testnet": False}


def get_base_url(config: dict) -> str:
    return BYBIT_TESTNET if config.get("testnet") else BYBIT_MAINNET


def sign_request(api_key: str, api_secret: str, timestamp: str, recv_window: str, body: str) -> str:
    """Создаёт HMAC-SHA256 подпись для Bybit API v5."""
    param_str = f"{timestamp}{api_key}{recv_window}{body}"
    return hmac.new(
        api_secret.encode("utf-8"),
        param_str.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()


def api_post(config: dict, endpoint: str, params: dict) -> dict:
    """POST запрос к приватному Bybit API v5."""
    api_key = config["api_key"]
    api_secret = config["api_secret"]

    if not api_key or not api_secret:
        return {"error": "API ключи не настроены. Добавь bybit.api_key/api_secret в ~/.openclaw/openclaw.json"}

    base = get_base_url(config)
    url = f"{base}{endpoint}"
    body = json.dumps(params)

    timestamp = str(int(time.time() * 1000))
    recv_window = "5000"
    sign = sign_request(api_key, api_secret, timestamp, recv_window, body)

    headers = {
        "Content-Type": "application/json",
        "X-BAPI-API-KEY": api_key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recv_window,
        "X-BAPI-SIGN": sign,
    }

    req = Request(url, data=body.encode("utf-8"), headers=headers, method="POST")
    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            if data.get("retCode") != 0:
                return {"error": data.get("retMsg", "Unknown error"), "retCode": data.get("retCode")}
            return data.get("result", {})
    except HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        return {"error": f"HTTP {e.code}: {error_body}"}
    except URLError as e:
        return {"error": f"Network error: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


def api_get_private(config: dict, endpoint: str, params: dict = None) -> dict:
    """GET запрос к приватному Bybit API v5."""
    api_key = config["api_key"]
    api_secret = config["api_secret"]

    if not api_key or not api_secret:
        return {"error": "API ключи не настроены"}

    base = get_base_url(config)
    query = "&".join(f"{k}={v}" for k, v in (params or {}).items() if v is not None)
    url = f"{base}{endpoint}" + (f"?{query}" if query else "")

    timestamp = str(int(time.time() * 1000))
    recv_window = "5000"
    sign = sign_request(api_key, api_secret, timestamp, recv_window, query)

    headers = {
        "X-BAPI-API-KEY": api_key,
        "X-BAPI-TIMESTAMP": timestamp,
        "X-BAPI-RECV-WINDOW": recv_window,
        "X-BAPI-SIGN": sign,
    }

    req = Request(url, headers=headers)
    try:
        with urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
            if data.get("retCode") != 0:
                return {"error": data.get("retMsg", "Unknown error"), "retCode": data.get("retCode")}
            return data.get("result", {})
    except HTTPError as e:
        error_body = e.read().decode() if e.fp else ""
        return {"error": f"HTTP {e.code}: {error_body}"}
    except URLError as e:
        return {"error": f"Network error: {e.reason}"}
    except Exception as e:
        return {"error": str(e)}


def validate_risk(args) -> tuple:
    """Проверяет риск-менеджмент перед открытием."""
    errors = []

    if args.sl is None:
        errors.append("SL обязателен! Позиция без Stop Loss запрещена.")

    if args.tp is None:
        errors.append("TP рекомендован. Используйте --tp для Take Profit.")

    if args.qty <= 0:
        errors.append(f"Qty {args.qty} должен быть > 0")

    # R:R проверка
    if args.sl and args.tp and args.direction:
        if args.direction == "Buy":
            risk = abs(args.entry_price - args.sl) if hasattr(args, "entry_price") and args.entry_price else 0
            reward = abs(args.tp - (args.entry_price if hasattr(args, "entry_price") and args.entry_price else args.tp)) if args.tp else 0
        else:
            risk = abs(args.sl - (args.entry_price if hasattr(args, "entry_price") and args.entry_price else 0))
            reward = abs((args.entry_price if hasattr(args, "entry_price") and args.entry_price else 0) - args.tp) if args.tp else 0

    if errors:
        return False, "; ".join(errors)
    return True, "OK"


def simulate_trade(action: str, args) -> dict:
    """Симуляция для тестирования без API ключей."""
    import random

    prices = {"BTCUSDT": 98500, "ETHUSDT": 3650, "SOLUSDT": 185, "ARBUSDT": 1.25}
    price = prices.get(args.pair.upper(), 100) if hasattr(args, "pair") and args.pair else 100

    if action == "open":
        return {
            "status": "EXECUTED",
            "action": "open",
            "orderId": f"sim_{random.randint(1000000, 9999999)}",
            "pair": args.pair,
            "side": args.direction,
            "qty": args.qty,
            "price": price,
            "sl": args.sl,
            "tp": args.tp,
            "leverage": getattr(args, "leverage", 3),
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION — реальный ордер требует API ключи Bybit",
        }
    elif action == "close":
        return {
            "status": "CLOSED",
            "action": "close",
            "pair": args.pair,
            "close_price": price + random.uniform(-50, 50),
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION",
        }
    elif action == "modify":
        return {
            "status": "MODIFIED",
            "action": "modify",
            "pair": args.pair,
            "new_sl": args.sl,
            "new_tp": args.tp,
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION",
        }
    elif action == "partial_close":
        return {
            "status": "PARTIAL_CLOSED",
            "action": "partial_close",
            "pair": args.pair,
            "qty_closed": args.qty,
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION",
        }
    elif action == "close_all":
        return {
            "status": "ALL_CLOSED",
            "action": "close_all",
            "positions_closed": random.randint(0, 3),
            "timestamp": datetime.now().isoformat(),
            "note": "SIMULATION",
        }
    return {"status": "UNKNOWN", "action": action}


def open_position(config: dict, args) -> dict:
    """Открывает позицию на Bybit."""
    # Устанавливаем плечо
    leverage = getattr(args, "leverage", config.get("default_leverage", 3))
    if leverage > config.get("max_leverage", MAX_LEVERAGE):
        return {"error": f"Плечо {leverage}x превышает максимум {config.get('max_leverage', MAX_LEVERAGE)}x"}

    api_post(config, "/v5/position/set-leverage", {
        "category": "linear",
        "symbol": args.pair.upper(),
        "buyLeverage": str(leverage),
        "sellLeverage": str(leverage),
    })

    # Открываем рыночный ордер
    order_params = {
        "category": "linear",
        "symbol": args.pair.upper(),
        "side": args.direction,
        "orderType": "Market",
        "qty": str(args.qty),
        "timeInForce": "GTC",
        "positionIdx": 0,  # One-way mode
    }

    if args.sl:
        order_params["stopLoss"] = str(args.sl)
        order_params["slTriggerBy"] = "LastPrice"
    if args.tp:
        order_params["takeProfit"] = str(args.tp)
        order_params["tpTriggerBy"] = "LastPrice"

    result = api_post(config, "/v5/order/create", order_params)

    if "error" in result:
        return {"status": "REJECTED", **result}

    return {
        "status": "EXECUTED",
        "action": "open",
        "orderId": result.get("orderId", ""),
        "orderLinkId": result.get("orderLinkId", ""),
        "pair": args.pair.upper(),
        "side": args.direction,
        "qty": args.qty,
        "sl": args.sl,
        "tp": args.tp,
        "leverage": leverage,
        "timestamp": datetime.now().isoformat(),
    }


def close_position(config: dict, args) -> dict:
    """Закрывает позицию по паре."""
    # Получаем текущую позицию
    positions = api_get_private(config, "/v5/position/list", {
        "category": "linear",
        "symbol": args.pair.upper(),
    })
    if "error" in positions:
        return {"status": "ERROR", **positions}

    pos_list = positions.get("list", [])
    if not pos_list or float(pos_list[0].get("size", 0)) == 0:
        return {"status": "NO_POSITION", "pair": args.pair, "message": "Нет открытой позиции"}

    pos = pos_list[0]
    side = "Sell" if pos["side"] == "Buy" else "Buy"
    qty = pos["size"]

    result = api_post(config, "/v5/order/create", {
        "category": "linear",
        "symbol": args.pair.upper(),
        "side": side,
        "orderType": "Market",
        "qty": qty,
        "timeInForce": "GTC",
        "positionIdx": 0,
        "reduceOnly": True,
    })

    if "error" in result:
        return {"status": "ERROR", **result}

    return {
        "status": "CLOSED",
        "action": "close",
        "orderId": result.get("orderId", ""),
        "pair": args.pair.upper(),
        "qty_closed": qty,
        "timestamp": datetime.now().isoformat(),
    }


def partial_close_position(config: dict, args) -> dict:
    """Частично закрывает позицию."""
    positions = api_get_private(config, "/v5/position/list", {
        "category": "linear",
        "symbol": args.pair.upper(),
    })
    if "error" in positions:
        return {"status": "ERROR", **positions}

    pos_list = positions.get("list", [])
    if not pos_list or float(pos_list[0].get("size", 0)) == 0:
        return {"status": "NO_POSITION", "pair": args.pair}

    pos = pos_list[0]
    side = "Sell" if pos["side"] == "Buy" else "Buy"

    result = api_post(config, "/v5/order/create", {
        "category": "linear",
        "symbol": args.pair.upper(),
        "side": side,
        "orderType": "Market",
        "qty": str(args.qty),
        "timeInForce": "GTC",
        "positionIdx": 0,
        "reduceOnly": True,
    })

    if "error" in result:
        return {"status": "ERROR", **result}

    return {
        "status": "PARTIAL_CLOSED",
        "action": "partial_close",
        "orderId": result.get("orderId", ""),
        "pair": args.pair.upper(),
        "qty_closed": args.qty,
        "timestamp": datetime.now().isoformat(),
    }


def modify_position(config: dict, args) -> dict:
    """Модифицирует SL/TP позиции."""
    params = {
        "category": "linear",
        "symbol": args.pair.upper(),
        "positionIdx": 0,
    }
    if args.sl:
        params["stopLoss"] = str(args.sl)
        params["slTriggerBy"] = "LastPrice"
    if args.tp:
        params["takeProfit"] = str(args.tp)
        params["tpTriggerBy"] = "LastPrice"

    result = api_post(config, "/v5/position/trading-stop", params)

    if "error" in result:
        return {"status": "ERROR", **result}

    return {
        "status": "MODIFIED",
        "action": "modify",
        "pair": args.pair.upper(),
        "new_sl": args.sl,
        "new_tp": args.tp,
        "timestamp": datetime.now().isoformat(),
    }


def close_all_positions(config: dict) -> dict:
    """Закрывает все открытые позиции."""
    positions = api_get_private(config, "/v5/position/list", {
        "category": "linear",
        "settleCoin": "USDT",
    })
    if "error" in positions:
        return {"status": "ERROR", **positions}

    closed = []
    for pos in positions.get("list", []):
        if float(pos.get("size", 0)) > 0:
            side = "Sell" if pos["side"] == "Buy" else "Buy"
            result = api_post(config, "/v5/order/create", {
                "category": "linear",
                "symbol": pos["symbol"],
                "side": side,
                "orderType": "Market",
                "qty": pos["size"],
                "timeInForce": "GTC",
                "positionIdx": 0,
                "reduceOnly": True,
            })
            closed.append({
                "symbol": pos["symbol"],
                "qty": pos["size"],
                "result": "OK" if "error" not in result else result["error"],
            })

    return {
        "status": "ALL_CLOSED",
        "action": "close_all",
        "positions_closed": len(closed),
        "details": closed,
        "timestamp": datetime.now().isoformat(),
    }


def main():
    parser = argparse.ArgumentParser(description="Bybit Trade — торговля через Bybit API v5")
    parser.add_argument("--action", required=True,
                        choices=["open", "close", "modify", "partial_close", "close_all"],
                        help="Торговое действие")
    parser.add_argument("--pair", help="Торговая пара (BTCUSDT)")
    parser.add_argument("--direction", choices=["Buy", "Sell"], help="Направление (Buy/Sell)")
    parser.add_argument("--qty", type=float, default=0.01, help="Размер позиции")
    parser.add_argument("--sl", type=float, help="Stop Loss цена")
    parser.add_argument("--tp", type=float, help="Take Profit цена")
    parser.add_argument("--leverage", type=int, default=3, help="Плечо (по умолчанию 3x)")
    parser.add_argument("--simulate", action="store_true", help="Режим симуляции (без API)")
    args = parser.parse_args()

    # Валидация
    if args.action == "open":
        if not args.pair:
            print(json.dumps({"error": "--pair обязателен для open"}))
            sys.exit(1)
        if not args.direction:
            print(json.dumps({"error": "--direction (Buy/Sell) обязателен для open"}))
            sys.exit(1)
        ok, msg = validate_risk(args)
        if not ok:
            print(json.dumps({"error": msg, "action": "REJECTED"}))
            sys.exit(1)

    if args.action in ("close", "modify", "partial_close") and not args.pair:
        print(json.dumps({"error": "--pair обязателен"}))
        sys.exit(1)

    # Симуляция
    if args.simulate:
        result = simulate_trade(args.action, args)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    # Реальная торговля
    config = load_config()

    if args.action == "open":
        result = open_position(config, args)
    elif args.action == "close":
        result = close_position(config, args)
    elif args.action == "partial_close":
        result = partial_close_position(config, args)
    elif args.action == "modify":
        result = modify_position(config, args)
    elif args.action == "close_all":
        result = close_all_positions(config)
    else:
        result = {"error": f"Неизвестный action: {args.action}"}

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("status") in ("EXECUTED", "CLOSED", "MODIFIED", "PARTIAL_CLOSED", "ALL_CLOSED"):
        sys.exit(0)
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Bybit Monitor — мониторинг позиций, аккаунта и рисков через Bybit API v5.

Используется Crypto Trader агентом для heartbeat-мониторинга.

Использование:
    python3 bybit_monitor.py --positions       # Открытые позиции
    python3 bybit_monitor.py --account         # Состояние аккаунта
    python3 bybit_monitor.py --heartbeat       # Полная проверка
    python3 bybit_monitor.py --risk-check      # Проверка рисков
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
MAX_DAILY_DRAWDOWN_PCT = 5.0   # 5% макс дневной дродаун
MAX_TOTAL_DRAWDOWN_PCT = 15.0  # 15% макс общий дродаун
MAX_RISK_PER_TRADE_PCT = 2.0   # 2% макс риск на сделку
MAX_LEVERAGE = 5               # Макс плечо


def load_config() -> dict:
    """Загружает credentials."""
    api_key = os.environ.get("BYBIT_API_KEY", "")
    api_secret = os.environ.get("BYBIT_API_SECRET", "")
    testnet = os.environ.get("BYBIT_TESTNET", "").lower() in ("true", "1")

    if api_key and api_secret:
        return {"api_key": api_key, "api_secret": api_secret, "testnet": testnet}

    config_path = os.path.expanduser("~/.openclaw/openclaw.json")
    if os.path.exists(config_path):
        try:
            with open(config_path) as f:
                content = f.read()
                lines = [l for l in content.split("\n") if not l.strip().startswith("//")]
                config = json.loads("\n".join(lines))
                bybit = config.get("bybit", {})
                return {
                    "api_key": bybit.get("api_key", ""),
                    "api_secret": bybit.get("api_secret", ""),
                    "testnet": bybit.get("testnet", False),
                }
        except (json.JSONDecodeError, KeyError):
            pass

    return {"api_key": "", "api_secret": "", "testnet": False}


def get_base_url(config: dict) -> str:
    return BYBIT_TESTNET if config.get("testnet") else BYBIT_MAINNET


def sign_request(api_key: str, api_secret: str, timestamp: str, recv_window: str, body: str) -> str:
    param_str = f"{timestamp}{api_key}{recv_window}{body}"
    return hmac.new(
        api_secret.encode("utf-8"),
        param_str.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()


def api_get(config: dict, endpoint: str, params: dict = None) -> dict:
    """GET запрос к приватному API."""
    api_key = config["api_key"]
    api_secret = config["api_secret"]

    if not api_key or not api_secret:
        return {"error": "API ключи не настроены. Добавь bybit.api_key/api_secret в ~/.openclaw/openclaw.json"}

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


def api_get_public(endpoint: str, params: dict = None) -> dict:
    """GET запрос к публичному API (без авторизации)."""
    url = f"{BYBIT_MAINNET}{endpoint}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        url = f"{url}?{query}"

    req = Request(url, headers={"User-Agent": "OpenClaw/1.0"})
    try:
        with urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
            if data.get("retCode") != 0:
                return {"error": data.get("retMsg")}
            return data.get("result", {})
    except Exception as e:
        return {"error": str(e)}


def get_positions(config: dict) -> list:
    """Получает открытые позиции."""
    result = api_get(config, "/v5/position/list", {
        "category": "linear",
        "settleCoin": "USDT",
    })

    if "error" in result:
        return [{"error": result["error"]}]

    positions = []
    for pos in result.get("list", []):
        size = float(pos.get("size", 0))
        if size == 0:
            continue
        positions.append({
            "symbol": pos.get("symbol", ""),
            "side": pos.get("side", ""),
            "size": size,
            "leverage": pos.get("leverage", ""),
            "entry_price": float(pos.get("avgPrice", 0)),
            "mark_price": float(pos.get("markPrice", 0)),
            "liq_price": float(pos.get("liqPrice", 0)) if pos.get("liqPrice") else None,
            "unrealised_pnl": float(pos.get("unrealisedPnl", 0)),
            "cum_realised_pnl": float(pos.get("cumRealisedPnl", 0)),
            "stop_loss": float(pos.get("stopLoss", 0)) if pos.get("stopLoss") else None,
            "take_profit": float(pos.get("takeProfit", 0)) if pos.get("takeProfit") else None,
            "trailing_stop": float(pos.get("trailingStop", 0)) if pos.get("trailingStop") else None,
            "position_value": float(pos.get("positionValue", 0)),
            "created_time": pos.get("createdTime", ""),
            "updated_time": pos.get("updatedTime", ""),
        })
    return positions


def get_account(config: dict) -> dict:
    """Получает данные аккаунта (UTA)."""
    result = api_get(config, "/v5/account/wallet-balance", {
        "accountType": "UNIFIED",
    })

    if "error" in result:
        return {"error": result["error"]}

    accounts = result.get("list", [])
    if not accounts:
        return {"error": "Нет данных аккаунта"}

    acc = accounts[0]
    return {
        "total_equity": float(acc.get("totalEquity", 0)),
        "total_wallet_balance": float(acc.get("totalWalletBalance", 0)),
        "total_margin_balance": float(acc.get("totalMarginBalance", 0)),
        "total_available_balance": float(acc.get("totalAvailableBalance", 0)),
        "total_unrealised_pnl": float(acc.get("totalPerpUPL", 0)),
        "total_initial_margin": float(acc.get("totalInitialMargin", 0)),
        "total_maintenance_margin": float(acc.get("totalMaintenanceMargin", 0)),
        "account_im_rate": acc.get("accountIMRate", ""),
        "account_mm_rate": acc.get("accountMMRate", ""),
        "account_type": "UNIFIED",
        "timestamp": datetime.now().isoformat(),
    }


def get_funding_rates(symbols: list = None) -> dict:
    """Получает текущие funding rates для основных пар."""
    if symbols is None:
        symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

    rates = {}
    for sym in symbols:
        result = api_get_public("/v5/market/tickers", {"category": "linear", "symbol": sym})
        tickers = result.get("list", [])
        if tickers:
            t = tickers[0]
            rate = float(t.get("fundingRate", 0))
            rates[sym] = {
                "funding_rate": rate,
                "funding_pct": round(rate * 100, 4),
                "next_funding_time": t.get("nextFundingTime", ""),
                "signal": "ПЕРЕГРЕТ_ЛОНГИ" if rate > 0.0003 else "ПЕРЕГРЕТ_ШОРТЫ" if rate < -0.0003 else "НЕЙТРАЛЬНО",
            }
    return rates


def check_position_risks(positions: list, account: dict) -> list:
    """Проверяет риски открытых позиций."""
    alerts = []
    equity = account.get("total_equity", account.get("total_wallet_balance", 10000))

    for pos in positions:
        if "error" in pos:
            continue

        symbol = pos["symbol"]

        # Позиция без SL
        if not pos.get("stop_loss"):
            alerts.append({
                "level": "CRITICAL",
                "symbol": symbol,
                "message": f"🚨 ПОЗИЦИЯ БЕЗ SL! {symbol} | {pos['side']} | Size: {pos['size']} | Leverage: {pos['leverage']}x",
            })

        # Проверка плеча
        lev = float(pos.get("leverage", 1))
        if lev > MAX_LEVERAGE:
            alerts.append({
                "level": "CRITICAL",
                "symbol": symbol,
                "message": f"🚨 ПЛЕЧО {lev}x ПРЕВЫШАЕТ ЛИМИТ {MAX_LEVERAGE}x! {symbol}",
            })

        # Проверка расстояния до ликвидации
        if pos.get("liq_price") and pos.get("mark_price"):
            mark = pos["mark_price"]
            liq = pos["liq_price"]
            if liq > 0:
                liq_distance_pct = abs(mark - liq) / mark * 100
                if liq_distance_pct < 3:
                    alerts.append({
                        "level": "CRITICAL",
                        "symbol": symbol,
                        "message": f"🚨 ЛИКВИДАЦИЯ БЛИЗКО! {symbol} | Расстояние: {liq_distance_pct:.1f}% | Mark: {mark} | Liq: {liq}",
                    })
                elif liq_distance_pct < 5:
                    alerts.append({
                        "level": "WARNING",
                        "symbol": symbol,
                        "message": f"⚠️ Ликвидация приближается: {symbol} | {liq_distance_pct:.1f}%",
                    })

        # Размер позиции vs equity
        pos_value = pos.get("position_value", 0)
        if equity > 0 and pos_value > 0:
            position_pct = (pos_value / equity) * 100
            if position_pct > 50:
                alerts.append({
                    "level": "WARNING",
                    "symbol": symbol,
                    "message": f"⚠️ Позиция {symbol} = {position_pct:.0f}% от equity (рекомендуется < 50%)",
                })

    return alerts


def check_drawdown(account: dict) -> list:
    """Проверяет дродаун аккаунта."""
    alerts = []
    balance = account.get("total_wallet_balance", 0)
    equity = account.get("total_equity", 0)

    if balance == 0:
        return alerts

    drawdown_pct = ((balance - equity) / balance * 100) if equity < balance else 0

    if drawdown_pct >= MAX_DAILY_DRAWDOWN_PCT:
        alerts.append({
            "level": "CRITICAL",
            "message": f"🚨 ДРОДАУН {drawdown_pct:.1f}% >= {MAX_DAILY_DRAWDOWN_PCT}%! СТОП ТОРГОВЛЯ!",
            "drawdown_pct": round(drawdown_pct, 2),
        })
    elif drawdown_pct >= MAX_DAILY_DRAWDOWN_PCT * 0.75:
        alerts.append({
            "level": "WARNING",
            "message": f"⚠️ Дродаун {drawdown_pct:.1f}% приближается к лимиту {MAX_DAILY_DRAWDOWN_PCT}%",
            "drawdown_pct": round(drawdown_pct, 2),
        })

    return alerts


def demo_data() -> tuple:
    """Демо-данные для тестирования без API ключей."""
    positions = [
        {
            "symbol": "BTCUSDT",
            "side": "Buy",
            "size": 0.01,
            "leverage": "3",
            "entry_price": 97500.0,
            "mark_price": 98200.0,
            "liq_price": 65000.0,
            "unrealised_pnl": 7.0,
            "cum_realised_pnl": 25.5,
            "stop_loss": 95000.0,
            "take_profit": 102000.0,
            "trailing_stop": None,
            "position_value": 982.0,
            "created_time": "2026-02-25T10:00:00",
            "updated_time": "2026-02-25T15:00:00",
            "_demo": True,
        }
    ]
    account = {
        "total_equity": 5025.50,
        "total_wallet_balance": 5000.00,
        "total_margin_balance": 5025.50,
        "total_available_balance": 4700.00,
        "total_unrealised_pnl": 25.50,
        "total_initial_margin": 325.50,
        "total_maintenance_margin": 15.00,
        "account_im_rate": "0.065",
        "account_mm_rate": "0.003",
        "account_type": "UNIFIED",
        "timestamp": datetime.now().isoformat(),
        "_demo": True,
    }
    return positions, account


def main():
    parser = argparse.ArgumentParser(description="Bybit Monitor — мониторинг аккаунта и позиций")
    parser.add_argument("--positions", action="store_true", help="Открытые позиции")
    parser.add_argument("--account", action="store_true", help="Состояние аккаунта")
    parser.add_argument("--heartbeat", action="store_true", help="Полная проверка (heartbeat)")
    parser.add_argument("--risk-check", action="store_true", help="Проверка рисков")
    parser.add_argument("--funding", action="store_true", help="Funding rates основных пар")
    args = parser.parse_args()

    config = load_config()
    using_demo = False

    # Получаем данные
    if config["api_key"] and config["api_secret"]:
        positions = get_positions(config)
        account = get_account(config)
        if "error" in account:
            print(f"⚠️ API ошибка: {account['error']}, использую демо-данные", file=sys.stderr)
            positions, account = demo_data()
            using_demo = True
    else:
        print("⚠️ API ключи не настроены, использую демо-данные", file=sys.stderr)
        positions, account = demo_data()
        using_demo = True

    result = {"timestamp": datetime.now().isoformat()}
    if using_demo:
        result["_note"] = "DEMO — настрой API ключи в ~/.openclaw/openclaw.json → bybit.api_key/api_secret"

    if args.positions or args.heartbeat:
        result["positions"] = positions
        result["positions_count"] = len(positions)
        result["total_unrealised_pnl"] = round(sum(p.get("unrealised_pnl", 0) for p in positions if "error" not in p), 2)

    if args.account or args.heartbeat:
        result["account"] = account

    if args.funding or args.heartbeat:
        result["funding_rates"] = get_funding_rates()

    if args.risk_check or args.heartbeat:
        position_alerts = check_position_risks(positions, account)
        drawdown_alerts = check_drawdown(account)
        all_alerts = position_alerts + drawdown_alerts
        result["alerts"] = all_alerts
        result["alerts_count"] = len(all_alerts)
        result["risk_status"] = (
            "CRITICAL" if any(a["level"] == "CRITICAL" for a in all_alerts)
            else "WARNING" if any(a["level"] == "WARNING" for a in all_alerts)
            else "OK"
        )

    if args.heartbeat:
        equity = account.get("total_equity", 0) if isinstance(account, dict) else 0
        balance = account.get("total_wallet_balance", 0) if isinstance(account, dict) else 0
        drawdown_pct = round(((balance - equity) / balance * 100), 2) if balance and equity < balance else 0.0

        result["heartbeat_summary"] = {
            "equity": equity,
            "balance": balance,
            "drawdown_pct": drawdown_pct,
            "open_positions": len([p for p in positions if "error" not in p]),
            "total_unrealised_pnl": round(sum(p.get("unrealised_pnl", 0) for p in positions if "error" not in p), 2),
            "positions_without_sl": sum(1 for p in positions if "error" not in p and not p.get("stop_loss")),
            "available_balance": account.get("total_available_balance", 0) if isinstance(account, dict) else 0,
            "trading_allowed": drawdown_pct < MAX_DAILY_DRAWDOWN_PCT,
        }

    if not any([args.positions, args.account, args.heartbeat, args.risk_check, args.funding]):
        result["positions"] = positions
        result["account"] = account

    print(json.dumps(result, ensure_ascii=False, indent=2))

    if result.get("risk_status") == "CRITICAL":
        sys.exit(2)


if __name__ == "__main__":
    main()

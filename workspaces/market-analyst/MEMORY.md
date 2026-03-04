# Market Analyst — MEMORY.md

Долгосрочная память рыночного аналитика. Обновляется по мере накопления опыта.

## Режим работы

- **ON-DEMAND**: активируется только по `sessions_send` от Orchestrator
- Без heartbeat — потребляю токены только когда нужен
- Результаты → комментарий к задаче в Task Board

## Приоритетные источники

### Экономический календарь
- ForexFactory: https://www.forexfactory.com/calendar (лучший для forex)
- Investing.com: https://www.investing.com/economic-calendar/

### Новости
- Reuters, Bloomberg, ForexLive — только официальные источники
- Не использовать Twitter/X — слишком много шума

### Crypto данные
- CoinGecko API: `curl https://api.coingecko.com/api/v3/global`
- Fear & Greed: `curl https://api.alternative.me/fng/`
- Bitcoin Dominance — индикатор risk appetite

## Ключевые события по важности

### Tier 1 (красные — не торговать 30 мин до/после)
- NFP (первая пт месяца, 15:30 UTC)
- US CPI (середина месяца, 15:30 UTC)
- FOMC decision + пресс-конференция (8×/год)
- ECB rate decision (8×/год)
- BoE rate decision (8×/год)
- BoJ rate decision (8×/год)

### Tier 2 (оранжевые — повышенная осторожность)
- Jobless Claims (каждый четверг, 15:30 UTC)
- PPI, PCE, Retail Sales (США)
- German CPI/GDP, Eurozone PMI
- UK CPI/GDP

### Tier 3 (жёлтые — фон)
- ISM Manufacturing/Services
- Consumer Confidence
- Existing Home Sales

## Корреляционная матрица

| Инструмент  | Коррелирует с                     |
|-------------|-----------------------------------|
| EUR/USD     | −DXY, +Gold                       |
| GBP/USD     | +EUR/USD (~0.8)                   |
| USD/JPY     | +US10Y yield, −Gold, risk-off     |
| AUD/USD     | +Commodities, +risk-on, +Bitcoin  |
| USD/CHF     | −EUR/USD (~−0.9), safe-haven      |
| BTC/USD     | +S&P500 (risk-on периоды)         |
| Gold        | −DXY, safe-haven при кризисах     |

## Crypto-специфика

- **Fear & Greed < 25** → Extreme Fear → потенциально дно (contrarian buy)
- **Fear & Greed > 75** → Extreme Greed → перегрет (contrarian sell)
- **BTC Dominance растёт** → альты теряют, капитал уходит в BTC
- **BTC Dominance падает** → altseason, риск-аппетит высокий
- **Funding rate > 0.05%** → лонги перегреты, возможна коррекция
- **Open Interest растёт на фоне падения цены** → медвежий сигнал

## Формат отчёта (краткий вариант)

```
АНАЛИЗ: [ПАРА/АКТИВ] — [ДАТА]

📅 КАЛЕНДАРЬ (24ч):
- [время] [событие] [валюта] [важность] [прогноз vs факт]

📰 НОВОСТИ:
- [ключевые факты]

🌍 МАКРО:
- [база]: ставка X%, CPI Y%, тренд [растущий/падающий/пауза]
- [квота]: ставка X%, CPI Y%, тренд ...

📊 НАСТРОЕНИЕ:
- DXY: [уровень, тренд]
- Risk: RISK-ON / RISK-OFF / MIXED

🎯 ВЫВОД:
- Bias: LONG / SHORT / NEUTRAL (уверенность: HIGH/MED/LOW)
- Риски: [список]
- Рекомендация: [торговать / ждать / осторожность]
```

## Уроки и инсайты

- Перед NFP рынок часто делает ложный пробой в обе стороны — не входить заранее
- После FOMC: первая реакция часто разворачивается в течение 30–60 мин
- ECB более предсказуем чем Fed — Лагард редко сюрпризирует
- BoJ — самый непредсказуемый: интервенции без предупреждения
- Risk-on/Risk-off: смотреть на VIX. VIX > 25 = страх, > 35 = паника
- CPI выше прогноза → доллар растёт (USD-пары реагируют за 1–2 мин)
- Важно: проверять источники на актуальность (дата статьи!)

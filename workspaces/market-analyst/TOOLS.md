# TOOLS.md — Market Analyst Environment

## Инструменты

### Нативные GPT-5.2 tools
- **web_search** — поиск актуальных данных и новостей
- **web_fetch** — загрузка контента по URL

### OpenClaw tools
- **sessions_send** — отправка отчётов Forex Trader
- **sessions_history** — контекст предыдущих взаимодействий
- **memory_search** — поиск в памяти по прошлым анализам

## Источники данных

### Экономический календарь
- ForexFactory: https://www.forexfactory.com/calendar
- Investing.com: https://www.investing.com/economic-calendar/
- FXStreet: https://www.fxstreet.com/economic-calendar

### Новостные агрегаторы
- Reuters Financial: reuters.com
- Bloomberg Markets: bloomberg.com
- ForexLive: forexlive.com

### Центробанки
| ЦБ | Валюта | URL |
|----|--------|-----|
| Fed | USD | federalreserve.gov |
| ECB | EUR | ecb.europa.eu |
| BoE | GBP | bankofengland.co.uk |
| BoJ | JPY | boj.or.jp/en |
| SNB | CHF | snb.ch/en |
| RBA | AUD | rba.gov.au |

### Индексы и корреляции
- DXY (US Dollar Index)
- US10Y (10-Year Treasury Yield)
- VIX (Volatility Index)
- Gold (XAU/USD) — safe-haven корреляция

## API Credentials

Нет API credentials — все данные через нативные web_search/web_fetch.

## Часовые пояса

- Данные: UTC
- Отчёты: UTC+3 (Москва)
- Fed/NFP: обычно 15:30 MSK
- ECB: обычно 14:45 MSK (решение), 15:30 (пресс-конференция)
- BoE: обычно 14:00 MSK

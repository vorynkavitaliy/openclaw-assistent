# TOOLS.md — Market Analyst Environment

## Tools

### Native Agent Tools

- **web_search** — search for current data and news
- **web_fetch** — download content from URLs

### OpenClaw Tools

- **Task Board** — sole communication channel with traders (reports, alerts)
- **sessions_history** — context of previous interactions
- **memory_search** — search memory for past analyses

## Data Sources

### Economic Calendar

- ForexFactory: https://www.forexfactory.com/calendar
- Investing.com: https://www.investing.com/economic-calendar/
- FXStreet: https://www.fxstreet.com/economic-calendar

### News Aggregators

- Reuters Financial: reuters.com
- Bloomberg Markets: bloomberg.com
- ForexLive: forexlive.com

### Central Banks

| CB  | Currency | URL                 |
| --- | -------- | ------------------- |
| Fed | USD      | federalreserve.gov  |
| ECB | EUR      | ecb.europa.eu       |
| BoE | GBP      | bankofengland.co.uk |
| BoJ | JPY      | boj.or.jp/en        |
| SNB | CHF      | snb.ch/en           |
| RBA | AUD      | rba.gov.au          |

### Indices and Correlations

- DXY (US Dollar Index)
- US10Y (10-Year Treasury Yield)
- VIX (Volatility Index)
- Gold (XAU/USD) — safe-haven correlation

## API Credentials

No API credentials — all data via native web_search/web_fetch.

## Timezones

- Data: UTC
- Reports: Kyiv time (Europe/Kyiv, UTC+2 / UTC+3 DST)
- Fed/NFP: usually 15:30 Kyiv (summer), 16:30 Kyiv (winter)
- ECB: usually 14:45 Kyiv (decision), 15:30 (press conference) in summer
- BoE: usually 14:00 Kyiv (summer)

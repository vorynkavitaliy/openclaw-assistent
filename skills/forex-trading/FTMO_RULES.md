# FTMO Prop Trading Rules — 2-Step Challenge

> FTMO rules for automated trading. The agent **MUST** comply with all limits.
> Violating any rule = account termination.

---

## Step 1: FTMO Challenge

| Parameter                | Value                                                  |
| ------------------------ | ------------------------------------------------------ |
| **Profit Target**        | **10%** of initial balance                             |
| **Maximum Daily Loss**   | **5%** of balance at start of day (or equity, whichever is higher) |
| **Maximum Total Loss**   | **10%** of initial balance                             |
| **Trading Period**       | **30 calendar days**                                   |
| **Minimum Trading Days** | **4 days** (trades on 4 different days)                |
| **Leverage**             | up to **1:100** (Forex)                                |

### Example (account $100,000):

- Profit Target: $10,000
- Max Daily Loss: $5,000
- Max Total Loss: $10,000 (equity never below $90,000)

---

## Step 2: Verification

| Parameter                | Value                                                  |
| ------------------------ | ------------------------------------------------------ |
| **Profit Target**        | **5%** of initial balance                              |
| **Maximum Daily Loss**   | **5%** of balance at start of day (or equity, whichever is higher) |
| **Maximum Total Loss**   | **10%** of initial balance                             |
| **Trading Period**       | **60 calendar days**                                   |
| **Minimum Trading Days** | **4 days** (trades on 4 different days)                |
| **Leverage**             | up to **1:100** (Forex)                                |

### Example (account $100,000):

- Profit Target: $5,000
- Max Daily Loss: $5,000
- Max Total Loss: $10,000 (equity never below $90,000)

---

## FTMO Funded Account (after passing both steps)

| Parameter              | Value                                     |
| ---------------------- | ----------------------------------------- |
| **Profit Target**      | None (trade without time limit)           |
| **Maximum Daily Loss** | **5%**                                    |
| **Maximum Total Loss** | **10%**                                   |
| **Profit Split**       | **80/20** (80% trader, 20% FTMO)          |
| **Scaling Plan**       | up to **90/10** with consistent results   |
| **Payouts**            | every 14 days (on request)                |

---

## Maximum Daily Loss Calculation (CRITICAL)

> ⚠️ **Daily Loss is calculated from the HIGHER of two values**: balance at start of day OR equity at start of day.

Formula:

```
Daily Loss Limit = max(balance_start_of_day, equity_start_of_day) × 5%
```

**Includes**: realized P&L + unrealized P&L (floating) + commissions + swaps.

Example:

- Balance start of day: $102,000
- Equity start of day: $103,500 (open positions in profit)
- Daily Loss Limit = $103,500 × 5% = **$5,175**
- Minimum allowed equity for the day: $103,500 - $5,175 = **$98,325**

---

## Maximum Total Loss Calculation (CRITICAL)

> ⚠️ **Total Loss is calculated from the INITIAL account balance**.

Formula:

```
Max Total Loss = initial_balance × 10%
Minimum Equity = initial_balance - (initial_balance × 10%) = initial_balance × 90%
```

Example (account $100,000):

- Max Total Loss: $10,000
- Equity must NEVER drop below **$90,000**

---

## Allowed Instruments

### Forex (main pairs — traded by the agent):

- EUR/USD, GBP/USD, USD/JPY, AUD/USD, USD/CAD, NZD/USD
- EUR/GBP, EUR/JPY, GBP/JPY and other crosses

### Other instruments (available on FTMO):

- Indices: US30, US100, US500, GER40, UK100
- Metals: XAU/USD (gold), XAG/USD (silver)
- Cryptocurrencies: BTC/USD, ETH/USD (limited leverage)
- Energy: USOIL, UKOIL

---

## Prohibited Strategies and Restrictions

### 1. News Trading

- **Restriction**: opening/closing/modifying positions within **±2 minutes** around High Impact News is prohibited
- This applies to instruments directly related to the news currency
- Example: NFP (Non-Farm Payrolls) → cannot trade USD pairs ±2 min
- **For the agent**: do not trade **30 minutes** before and after major news (additional safety buffer)

### 2. Weekend Position Holding

- **Allowed** on FTMO (no restriction)
- However, opening gaps can create risks for daily/total drawdown
- **Agent recommendation**: close all positions before weekends (Friday 21:00 UTC) unless there is a strong reason to hold

### 3. Prohibited Strategies

- **Martingale** (increasing lot size after a loss) — strictly prohibited
- **Grid trading** without stop losses — prohibited
- **HFT / Latency arbitrage** — prohibited
- **Copy trading** from another FTMO account — prohibited
- **Hedging between FTMO accounts** — prohibited (hedging within one account is allowed)
- **Tick scalping** (trades lasting less than a few seconds) — not recommended
- **Platform exploits** — prohibited

### 4. Gambling / Excessive Risk

- Opening disproportionately large positions — violation
- All trading must be justified (strategy, analysis)

---

## Inactivity Rule

- **Challenge/Verification**: if no trade within **30 calendar days** — account may be closed
- **Funded Account**: minimum **1 trade in 30 days**
- **For the agent**: ensure at least 1 trading day per week

---

## Scaling Plan

With consistent results on Funded Account:

1. Trading ≥ 4 months with profit
2. Profit ≥ 10% over the period (cumulative)
3. Balance increase of **25%** from initial
4. Profit split increases: **80/20 → 90/10**

---

## Trading Hours

- Forex: **Sunday 22:05 UTC — Friday 21:00 UTC** (round the clock)
- Indices/Metals: depends on instrument
- For the agent: trade during **London + New York** sessions (best liquidity)

---

## Agent Safety Limits (STRICTER than FTMO)

> The agent uses more conservative limits to maintain a safety buffer.

| Parameter            | FTMO Limit | Agent Limit   | Buffer       |
| -------------------- | ---------- | ------------- | ------------ |
| Max Daily Loss       | 5.0%       | **4.0%**      | 1.0%         |
| Max Total Loss       | 10.0%      | **8.0%**      | 2.0%         |
| Risk per trade       | up to 5%   | **1.0–2.0%**  | Significant  |
| Max open positions   | Unlimited  | **3**         | —            |
| News buffer          | ±2 min     | **±30 min**   | 28 min       |
| Weekend holding      | Allowed    | **Close all** | —            |

These limits are set in `src/trading/forex/config.ts`:

- `maxDailyDrawdownPct: 4.0` (FTMO: 5.0)
- `maxTotalDrawdownPct: 8.0` (FTMO: 10.0)
- `maxRiskPerTradePct: 1.0` (FTMO: no limit, but common sense)
- `maxOpenPositions: 3`

---

## Pre-Trade Checklist (FTMO compliance)

```
□ Check daily drawdown (current % of limit)
□ Check total drawdown (current % of limit)
□ Any High Impact news in the next 30 min?
□ Position size ≤ 2% risk of balance
□ Stop Loss set
□ Risk:Reward ≥ 1:2
□ No more than 3 open positions
□ Not Friday evening (weekend risk)
□ Strategy does not violate FTMO rules
```

---

## Links

- FTMO Trading Rules: https://ftmo.com/en/trading-rules/
- FTMO FAQ: https://ftmo.com/en/faq/
- FTMO Scaling Plan: https://ftmo.com/en/scaling-plan/
- FTMO Objectives: https://ftmo.com/en/trading-objectives/

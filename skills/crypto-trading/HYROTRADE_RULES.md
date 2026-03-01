# HyroTrade Prop Trading Rules — 2-Step Challenge (Crypto)

> HyroTrade rules for automated crypto trading. The agent **MUST** comply with all limits.
> Violating any rule = account termination.

---

## Phase 1: Challenge

| Parameter                | Value                                       |
| ------------------------ | ------------------------------------------- |
| **Profit Target**        | **8%** of initial balance                   |
| **Daily Drawdown Limit** | **5%** of balance at the start of the day   |
| **Maximum Loss Limit**   | **10%** of initial balance                  |
| **Trading Period**       | **Unlimited**                               |
| **Minimum Trading Days** | **5 days** (trades on 5 different days)     |
| **Stop Loss**            | **Mandatory**, max risk per trade **3%**    |

---

## Phase 2: Verification

| Parameter                | Value                                             |
| ------------------------ | ------------------------------------------------- |
| **Profit Target**        | **5%** of initial balance                         |
| **Daily Drawdown Limit** | **5%** of balance at the start of the day         |
| **Maximum Loss Limit**   | **10%** of initial balance                        |
| **Trading Period**       | **Unlimited**                                     |
| **Minimum Trading Days** | **5 days** (trades on 5 different days)           |
| **Stop Loss**            | **Mandatory**, max risk per trade **3%**          |
| **Inactivity Period**    | **30 days** (account disabled if inactive)        |

---

## Funded Account (after passing both phases)

| Parameter             | Value                                          |
| --------------------- | ---------------------------------------------- |
| **Profit Target**     | None (trade without time limit)                |
| **Daily Drawdown**    | **5%** of balance at the start of the day      |
| **Maximum Loss**      | **10%** of initial balance                     |
| **Profit Split**      | Depends on plan (typically 80/20 → up to 90/10) |
| **Inactivity Period** | **30 days**                                    |

---

## Low-Cap Altcoins — Restrictions

| Rule                        | Value                                    |
| --------------------------- | ---------------------------------------- |
| **Minimum Market Cap**      | **$100M** (below = prohibited)           |
| **Maximum Allocation**      | **5%** of balance per low-cap coin       |

> Low-cap definition: coin with market cap < $500M.
> For coins with market cap $100M–$500M — limit is 5% of balance.
> For BTC, ETH, SOL and other large-cap coins — standard limit applies.

---

## Daily Drawdown Calculation

```
Each day at 00:00 UTC the base balance is recorded.
Daily Drawdown = max(Start_Of_Day_Balance, Max_Equity_Of_Day) - Current_Equity

If Daily_Drawdown > 5% of Start_Of_Day_Balance → VIOLATION!
```

### Example (account $25,000):

- Start of day (00:00 UTC): balance $25,000
- Max Daily Loss: $1,250 (5%)
- Equity must never drop below $23,750

## Maximum Loss Calculation (Total Drawdown)

```
Maximum Loss = Initial_Account_Balance - Current_Equity

If Equity < 90% of Initial_Balance → VIOLATION!
```

### Example (account $25,000):

- Initial balance: $25,000
- Max Loss: $2,500 (10%)
- Equity must NEVER go below $22,500

---

## Prohibited Actions

1. **Trading without Stop Loss** — SL is mandatory on every trade
2. **Martingale** — increasing position size after a loss is prohibited
3. **Grid Trading** — placing a grid of orders is prohibited
4. **HFT / Scalping < 1 min** — trades shorter than 1 minute are prohibited
5. **Arbitrage between accounts** — prohibited
6. **Hedging** — simultaneous LONG and SHORT on the same pair is prohibited
7. **Trading on delisting/listing** — trading anomalous pumps/dumps is prohibited
8. **Copy trading** — copying other signals via API is prohibited
9. **Drawdown manipulation** — artificially avoiding drawdown (tick trading) is prohibited

---

## Stop Loss Requirements

| Rule                        | Value                                  |
| --------------------------- | -------------------------------------- |
| **SL is mandatory**         | On EVERY position                      |
| **Max risk per trade**      | **3%** of balance (HyroTrade rule)     |
| **Agent uses**              | **2%** of balance (safety buffer)      |
| **SL must be realistic**    | Not 50% of balance — reasonable distance |

---

## Agent Safety Buffer

The agent uses STRICTER limits to maintain a safety margin:

| Parameter      | HyroTrade Limit | Agent Uses          | Buffer |
| -------------- | --------------- | ------------------- | ------ |
| Daily Drawdown | 5%              | **4%**              | 1%     |
| Maximum Loss   | 10%             | **8%**              | 2%     |
| Risk per trade | 3%              | **2%**              | 1%     |
| Max positions  | Unlimited       | **3**               | —      |
| Max leverage   | Unlimited       | **5x** (usually 3x) | —      |

### Agent Alerts:

- Daily Drawdown > **3%** → ALERT, cautious trading
- Daily Drawdown > **4%** → STOP trading for the day
- Total Drawdown > **6%** → ALERT, reduce positions
- Total Drawdown > **8%** → STOP trading, notify user

---

## Crypto Trading Hours

- **24/7** — crypto markets operate around the clock
- **Caution**: Sunday (low liquidity)
- **Do not trade**: 30 min before/after FOMC, CPI and major crypto events (unlocks, listings)

---

## Pre-Trade Checklist (before every trade)

```
□ Stop Loss set?
□ Risk ≤ 2% of balance?
□ R:R ≥ 1:2?
□ Daily drawdown < 4%?
□ Total drawdown < 8%?
□ Coin market cap > $100M?
□ If low-cap — allocation ≤ 5%?
□ Not martingale or grid?
□ No major news in the next 30 min?
□ Max 3 positions simultaneously?
□ Leverage ≤ 5x?
□ Minimum 5 trading days to pass the phase?
```

---

## Links

- HyroTrade Challenge: https://hyrotrade.com/challenges
- HyroTrade FAQ: https://hyrotrade.com/faq

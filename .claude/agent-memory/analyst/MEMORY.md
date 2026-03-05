# Analyst Agent Memory

## Архитектура крипто-трейдера (изучено 2026-03-05)

### Ключевые файлы
- Конфиг: `src/trading/crypto/config.ts`
- Confluence: `src/trading/shared/confluence.ts` — 6 модулей, веса 25/15/15/15/15/15
- Regime: `src/trading/shared/regime.ts` — пороги 30/45/50/65/80
- LLM: `src/trading/crypto/llm-advisor.ts` — claude-sonnet-4, temperature=0.1
- Executor: `src/trading/crypto/signal-executor.ts`
- Analyzer: `src/trading/crypto/market-analyzer.ts` — pre-filters + confluence

### Реальный диапазон confluence scores
- Типичный нейтральный рынок: |25-35|
- Хороший сигнал (weak trend): |40-55|
- Сильный сигнал (strong trend): |60-75|
- Максимум теоретический: ±100

### Главные bottleneck системы
1. `maxStopsPerDay=2` — при 2 стопах торговля останавливается до следующего дня
2. `aggregate risk = 50% maxDailyLoss = $250` — де-факто 1 позиция одновременно при balance $10k
3. Порог RANGING=50 при типичных scores 31-45 — боковик = "не торгуем"
4. 9 из 12 пар в ecosystem groups — correlation filter сильно ограничивает

### Особенности LLM Advisor
- Fallback при ошибке парсинга → ENTER (риск неконтролируемых входов)
- Urgency HIGH при hoursLeft <= 8 провоцирует концентрацию рисков в конце дня
- Нет данных о новостях и экономическом календаре

### Анализы
- Полный анализ: `.claude/analysis/2026-03-05-crypto-trading-logic-deep-analysis.md`

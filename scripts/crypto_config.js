#!/usr/bin/env node
'use strict';
/**
 * Конфигурация автоторговли crypto-trader.
 *
 * Все лимиты, пары и параметры в одном месте.
 * Подключается из crypto_monitor.js, crypto_report.js, crypto_state.js.
 */

module.exports = {
  // ─── Торговые пары ───────────────────────────────────────────
  // Основные + топ-10 ликвидных альткоинов
  pairs: [
    'BTCUSDT',
    'ETHUSDT',
    'SOLUSDT',
    'XRPUSDT',
    'DOGEUSDT',
    'AVAXUSDT',
    'LINKUSDT',
    'ADAUSDT',
    'DOTUSDT',
    'MATICUSDT',
    'ARBUSDT',
    'OPUSDT',
  ],

  // ─── Ордера ──────────────────────────────────────────────────
  allowedOrderTypes: ['Market', 'Limit'], // Market + Limit разрешены

  // ─── Расписание ──────────────────────────────────────────────
  monitorIntervalMin: 10, // мониторинг каждые 10 минут
  reportIntervalMin: 60, // отчёт каждый час
  reportOffsetMin: 10, // в :10 UTC (не :00)

  // ─── Риск-менеджмент ─────────────────────────────────────────
  riskPerTrade: 0.02, // 2% депозита на сделку
  maxDailyLoss: 500, // макс дневной убыток $500
  maxStopsPerDay: 2, // 2 стопа → стоп день
  maxRiskPerTrade: 250, // макс убыток на одну сделку $250 (maxDailyLoss / maxStopsPerDay)
  maxOpenPositions: 3, // макс одновременных позиций
  maxLeverage: 5, // макс плечо
  defaultLeverage: 3, // плечо по умолчанию
  minRR: 2, // минимальный R:R = 1:2

  // ─── Управление позицией ─────────────────────────────────────
  partialCloseAtR: 1.0, // закрыть 50% при +1R
  partialClosePercent: 0.5, // 50% позиции
  trailingStartR: 1.5, // трейлинг-стоп после +1.5R
  trailingDistanceR: 0.5, // расстояние трейлинга 0.5R

  // ─── Фильтры входа ──────────────────────────────────────────
  maxFundingRate: 0.0005, // > 0.05% = не входить в лонг
  minFundingRate: -0.0005, // < -0.05% = не входить в шорт
  maxSpreadPercent: 0.1, // макс спред 0.1%

  // ─── Режим ───────────────────────────────────────────────────
  mode: 'execute', // 'execute' = full-auto | 'dry-run' = только анализ
  demoTrading: true, // Demo Trading аккаунт

  // ─── Таймфреймы анализа ──────────────────────────────────────
  trendTF: '240', // 4h — определение тренда
  zonesTF: '60', // 1h — зоны спроса/предложения
  entryTF: '15', // 15m — точка входа
  precisionTF: '5', // 5m — уточнение входа

  // ─── Kill Switch ─────────────────────────────────────────────
  killSwitchFile: '/root/Projects/openclaw-assistent/scripts/data/KILL_SWITCH',

  // ─── Файлы данных ────────────────────────────────────────────
  stateFile: '/root/Projects/openclaw-assistent/scripts/data/state.json',
  eventsFile: '/root/Projects/openclaw-assistent/scripts/data/events.jsonl',

  // ─── Telegram ────────────────────────────────────────────────
  telegramEnabled: true,
  telegramViaOpenClaw: true, // отправка через OpenClaw routing (не напрямую)
};

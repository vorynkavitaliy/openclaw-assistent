#!/usr/bin/env node
'use strict';
/**
 * Crypto Kill Switch — CLI для управления аварийной остановкой.
 *
 * Использование:
 *   node scripts/crypto_killswitch.js --on                  # Включить kill-switch
 *   node scripts/crypto_killswitch.js --on --reason="..."   # С указанием причины
 *   node scripts/crypto_killswitch.js --off                 # Выключить kill-switch
 *   node scripts/crypto_killswitch.js --status              # Проверить статус
 *   node scripts/crypto_killswitch.js --close-all           # Kill + закрыть все позиции
 */

const { execSync } = require('child_process');
const path = require('path');
const state = require('./crypto_state');

const TRADE_JS = path.join(__dirname, 'bybit_trade.js');

function getArg(name, def) {
  const p = `--${name}=`;
  const f = process.argv.find(a => a.startsWith(p));
  return f ? f.slice(p.length) : def;
}
function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function runTrade(args) {
  try {
    const out = execSync(`node "${TRADE_JS}" ${args}`, {
      timeout: 30000,
      encoding: 'utf-8',
      env: { ...process.env, HOME: process.env.HOME || '/root' },
    });
    return JSON.parse(out.trim());
  } catch (e) {
    try {
      return JSON.parse(e.stdout?.trim());
    } catch {
      return { status: 'ERROR', error: e.message };
    }
  }
}

async function main() {
  state.load();

  if (hasFlag('on')) {
    const reason = getArg('reason', 'manual kill-switch');
    state.activateKillSwitch(reason);

    // Если --close-all → закрыть все позиции
    if (hasFlag('close-all')) {
      console.log('🔴 Закрываю все позиции...');
      const res = runTrade('--action=close_all');
      console.log(`   Закрыто: ${res.closed || 0}/${res.total || 0}`);
    }

    console.log(`🚨 KILL SWITCH АКТИВИРОВАН`);
    console.log(`   Причина: ${reason}`);
    console.log(`   Время: ${new Date().toISOString()}`);
    console.log(`   Торговля полностью остановлена.`);
    console.log(`   Для снятия: node scripts/crypto_killswitch.js --off`);
    return;
  }

  if (hasFlag('off')) {
    state.deactivateKillSwitch();
    console.log('✅ Kill Switch снят. Торговля возобновлена.');
    return;
  }

  if (hasFlag('close-all')) {
    state.activateKillSwitch('emergency close-all');
    console.log('🔴 Закрываю все позиции...');
    const res = runTrade('--action=close_all');
    console.log(`   Закрыто: ${res.closed || 0}/${res.total || 0}`);
    console.log('🚨 KILL SWITCH АКТИВИРОВАН (emergency close-all)');
    return;
  }

  // --status (по умолчанию)
  const active = state.isKillSwitchActive();
  const s = state.get();

  console.log(`\n📊 Статус автоторговли:`);
  console.log(`   Kill Switch: ${active ? '🔴 АКТИВЕН' : '🟢 Выключен'}`);
  console.log(`   Стоп-день: ${s.daily.stopDay ? '⛔ ДА — ' + s.daily.stopDayReason : '✅ Нет'}`);
  console.log(`   Дневных сделок: ${s.daily.trades}`);
  console.log(`   Стопов: ${s.daily.stops}/${require('./crypto_config').maxStopsPerDay}`);
  console.log(`   Дневной P&L: $${(s.daily.totalPnl || 0).toFixed(2)}`);
  console.log(`   Позиций: ${s.positions.length}`);
  console.log(`   Баланс: $${(s.balance.total || 0).toFixed(2)}`);
  console.log(`   Режим: ${require('./crypto_config').mode}`);
  console.log(`   Последний мониторинг: ${s.lastMonitor || 'нет'}`);
  console.log(`   Последний отчёт: ${s.lastReport || 'нет'}`);
}

main().catch(err => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});

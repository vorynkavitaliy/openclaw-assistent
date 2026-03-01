import { submitOrder, setLeverage, getBalance } from '../../src/trading/crypto/bybit-client.js';

const SYMBOL = 'BTCUSDT';
const ENTRY_PRICE = 67150; // Текущая рыночная цена
const STOP_LOSS = 65767;   // -2.06%
const TAKE_PROFIT = 69916; // +4.12%
const LEVERAGE = 3;
const RISK_AMOUNT = 200;   // $200 риск (2% от $10,000)

async function openTrade() {
  try {
    console.log('🪙 Открытие LONG позиции BTC/USDT...');
    
    // Получаем баланс
    const balance = await getBalance();
    console.log(`💰 Баланс: $${balance.totalEquity.toFixed(2)}`);
    
    // Рассчитываем размер позиции
    const riskDistance = ENTRY_PRICE - STOP_LOSS;
    const baseQty = RISK_AMOUNT / riskDistance; // Базовая позиция без рычага
    const rawQty = baseQty * LEVERAGE; // С учетом рычага 3x
    
    // Округляем до минимального шага 0.001
    const qty = (Math.floor(rawQty * 1000) / 1000).toFixed(3);
    
    console.log(`📊 Параметры сделки:`);
    console.log(`   Entry: $${ENTRY_PRICE}`);
    console.log(`   SL: $${STOP_LOSS} (-${((ENTRY_PRICE - STOP_LOSS) / ENTRY_PRICE * 100).toFixed(2)}%)`);
    console.log(`   TP: $${TAKE_PROFIT} (+${((TAKE_PROFIT - ENTRY_PRICE) / ENTRY_PRICE * 100).toFixed(2)}%)`);
    console.log(`   Размер: ${qty} BTC`);
    console.log(`   Риск: $${RISK_AMOUNT}`);
    console.log(`   R:R: 1:${((TAKE_PROFIT - ENTRY_PRICE) / (ENTRY_PRICE - STOP_LOSS)).toFixed(2)}`);
    
    // Устанавливаем рычаг
    await setLeverage(SYMBOL, LEVERAGE);
    console.log(`⚖️ Рычаг установлен: ${LEVERAGE}x`);
    
    // Открываем позицию с SL/TP
    const order = await submitOrder({
      symbol: SYMBOL,
      side: 'Buy',
      orderType: 'Market',
      qty: qty,
      stopLoss: STOP_LOSS.toString(),
      takeProfit: TAKE_PROFIT.toString()
    });
    
    console.log(`✅ Ордер создан: ${order.orderId}`);
    console.log(`📈 Статус: ${order.status}`);
    
    return {
      orderId: order.orderId,
      entry: ENTRY_PRICE,
      sl: STOP_LOSS,
      tp: TAKE_PROFIT,
      qty: qty,
      risk: RISK_AMOUNT,
      rr: ((TAKE_PROFIT - ENTRY_PRICE) / (ENTRY_PRICE - STOP_LOSS)).toFixed(2)
    };
    
  } catch (error) {
    console.error('❌ Ошибка при открытии сделки:', error.message);
    throw error;
  }
}

openTrade()
  .then(result => {
    console.log('\n🎯 Сделка успешно открыта!');
    console.log(JSON.stringify(result, null, 2));
  })
  .catch(error => {
    console.error('\n💥 Не удалось открыть сделку:', error.message);
    process.exit(1);
  });
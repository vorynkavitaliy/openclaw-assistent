#!/usr/bin/env node
import { BybitClient } from './bybit-client.js';
import { KillSwitch } from './killswitch.js';

interface DailyReport {
  timestamp: string;
  date: string;
  balance: {
    total: number;
    available: number;
    unrealizedPnl: number;
  };
  positions: Array<{
    symbol: string;
    side: string;
    size: number;
    entryPrice: number;
    markPrice: number;
    pnl: number;
    percentage: number;
  }>;
  market: {
    fearGreed: number;
    btcDominance: number;
    funding: { [symbol: string]: number };
  };
  killSwitch: {
    enabled: boolean;
    reason?: string;
    dailyLoss: number;
  };
  stats: {
    openPositions: number;
    totalPnl: number;
    dailyPnlPercent: number;
  };
}

class TradingReporter {
  private client: BybitClient;
  private killSwitch: KillSwitch;
  private pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  
  constructor() {
    this.client = new BybitClient();
    this.killSwitch = new KillSwitch();
  }
  
  async generateReport(): Promise<DailyReport> {
    const timestamp = new Date().toISOString();
    const date = timestamp.split('T')[0];
    
    // Gather data
    const [positions, balance, fearGreed, btcDominance, killSwitchStatus] = await Promise.all([
      this.client.getPositions(),
      this.client.getBalance('USDT'),
      this.client.getFearGreedIndex(),
      this.client.getBitcoinDominance(),
      this.killSwitch.getStatus(),
    ]);
    
    // Get funding rates
    const funding: { [symbol: string]: number } = {};
    for (const pair of this.pairs) {
      try {
        const marketInfo = await this.client.getMarketInfo(pair);
        funding[pair] = marketInfo.fundingRate;
      } catch (error) {
        funding[pair] = 0;
      }
    }
    
    const balanceData = balance[0] || { walletBalance: 0, availableBalance: 0, unrealizedPnl: 0 };
    const totalPnl = positions.reduce((sum, p) => sum + p.unrealizedPnl, 0);
    
    const report: DailyReport = {
      timestamp,
      date,
      balance: {
        total: balanceData.walletBalance,
        available: balanceData.availableBalance,
        unrealizedPnl: balanceData.unrealizedPnl,
      },
      positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
        markPrice: p.markPrice,
        pnl: p.unrealizedPnl,
        percentage: p.percentage,
      })),
      market: {
        fearGreed: fearGreed?.value || 50,
        btcDominance: btcDominance || 50,
        funding,
      },
      killSwitch: {
        enabled: killSwitchStatus.killSwitch,
        reason: killSwitchStatus.reason,
        dailyLoss: killSwitchStatus.dailyLoss,
      },
      stats: {
        openPositions: positions.length,
        totalPnl,
        dailyPnlPercent: totalPnl / balanceData.walletBalance * 100,
      },
    };
    
    return report;
  }
  
  formatTelegramMessage(report: DailyReport): string {
    const date = new Date(report.timestamp).toLocaleString('ru-RU', {
      timeZone: 'Europe/Kiev',
      day: '2-digit',
      month: '2-digit', 
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
    
    let message = `🪙 Крипто Отчёт - ${date}\n\n`;
    
    // Balance
    message += `💰 Баланс: $${report.balance.total.toFixed(2)}\n`;
    message += `💵 Доступно: $${report.balance.available.toFixed(2)}\n`;
    if (report.balance.unrealizedPnl !== 0) {
      const pnlEmoji = report.balance.unrealizedPnl > 0 ? '📈' : '📉';
      message += `${pnlEmoji} Нереал. ПнЛ: $${report.balance.unrealizedPnl.toFixed(2)}\n`;
    }
    message += `\n`;
    
    // Positions
    message += `📊 Позиции (${report.positions.length}):\n`;
    if (report.positions.length === 0) {
      message += `   Нет открытых позиций\n`;
    } else {
      report.positions.forEach(p => {
        const emoji = p.pnl > 0 ? '🟢' : '🔴';
        const side = p.side === 'Buy' ? 'LONG' : 'SHORT';
        message += `   ${emoji} ${p.symbol} ${side} ${p.size}\n`;
        message += `      Вход: $${p.entryPrice.toFixed(2)} | Цена: $${p.markPrice.toFixed(2)}\n`;
        message += `      ПнЛ: $${p.pnl.toFixed(2)} (${p.percentage.toFixed(2)}%)\n`;
      });
    }
    message += `\n`;
    
    // Market data
    message += `📈 Рынок:\n`;
    message += `   😱 Страх/Жадность: ${report.market.fearGreed}\n`;
    message += `   ₿ Доминация BTC: ${report.market.btcDominance.toFixed(1)}%\n`;
    
    // Funding rates
    message += `   💱 Фандинг:\n`;
    Object.entries(report.market.funding).forEach(([symbol, rate]) => {
      const percentage = (rate * 100).toFixed(4);
      const emoji = rate > 0.03 ? '🔴' : rate < -0.03 ? '🟢' : '⚪';
      message += `      ${symbol}: ${emoji} ${percentage}%\n`;
    });
    message += `\n`;
    
    // Kill switch status
    if (report.killSwitch.enabled) {
      message += `🛑 Kill Switch: ВКЛЮЧЁН\n`;
      if (report.killSwitch.reason) {
        message += `   Причина: ${report.killSwitch.reason}\n`;
      }
      message += `\n`;
    }
    
    // Daily stats
    if (report.stats.totalPnl !== 0) {
      const pnlEmoji = report.stats.totalPnl > 0 ? '📈' : '📉';
      message += `${pnlEmoji} Дневной ПнЛ: $${report.stats.totalPnl.toFixed(2)} (${report.stats.dailyPnlPercent.toFixed(2)}%)\n`;
    }
    
    return message;
  }
  
  async sendToTelegram(message: string) {
    // This would need to be implemented with OpenClaw's message system
    console.log('TELEGRAM MESSAGE:');
    console.log(message);
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const reporter = new TradingReporter();
  const jsonFormat = args.includes('--format=json');
  
  reporter.generateReport()
    .then(report => {
      if (jsonFormat) {
        console.log(JSON.stringify(report, null, 2));
      } else {
        const telegramMessage = reporter.formatTelegramMessage(report);
        console.log(telegramMessage);
        // Auto-send to Telegram in future
        // await reporter.sendToTelegram(telegramMessage);
      }
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error generating report:', error.message);
      process.exit(1);
    });
}

export { TradingReporter };
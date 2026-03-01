#!/usr/bin/env node
import { BybitClient } from './bybit-client.js';

interface TechnicalAnalysis {
  symbol: string;
  timeframe: string;
  trend: 'bullish' | 'bearish' | 'neutral';
  signal: 'buy' | 'sell' | 'neutral';
  strength: number; // 0-100
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  riskReward?: number;
  reasoning: string[];
}

interface MarketAnalysis {
  timestamp: number;
  fearGreed: number;
  btcDominance: number;
  funding: { [symbol: string]: number };
  analysis: TechnicalAnalysis[];
  signals: TechnicalAnalysis[];
  positions: any[];
  balance: any[];
}

class CryptoMonitor {
  private client: BybitClient;
  private pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ARBUSDT', 'OPUSDT', 'LINKUSDT', 'AVAXUSDT'];
  private dryRun: boolean;
  
  constructor(dryRun = false) {
    this.client = new BybitClient();
    this.dryRun = dryRun;
  }
  
  async runAnalysis(specificPair?: string): Promise<MarketAnalysis> {
    const timestamp = Date.now();
    const pairsToAnalyze = specificPair ? [specificPair] : this.pairs;
    
    console.log(`[${new Date().toISOString()}] Starting analysis for: ${pairsToAnalyze.join(', ')}${this.dryRun ? ' (DRY-RUN)' : ''}`);
    
    try {
      // Get market data
      const [fearGreed, btcDominance, positions, balance] = await Promise.all([
        this.client.getFearGreedIndex(),
        this.client.getBitcoinDominance(),
        this.client.getPositions(),
        this.client.getBalance('USDT'),
      ]);
      
      // Analyze each pair
      const analysis: TechnicalAnalysis[] = [];
      const funding: { [symbol: string]: number } = {};
      
      for (const pair of pairsToAnalyze) {
        try {
          const pairAnalysis = await this.analyzePair(pair);
          analysis.push(pairAnalysis);
          
          const marketInfo = await this.client.getMarketInfo(pair);
          funding[pair] = marketInfo.fundingRate;
          
        } catch (error) {
          console.error(`Error analyzing ${pair}:`, error);
          analysis.push({
            symbol: pair,
            timeframe: '15m',
            trend: 'neutral',
            signal: 'neutral',
            strength: 0,
            reasoning: [`Error: ${error.message}`],
          });
        }
      }
      
      // Filter strong signals
      const signals = analysis.filter(a => 
        a.signal !== 'neutral' && 
        a.strength >= 60 && 
        a.riskReward && 
        a.riskReward >= 2
      );
      
      const result: MarketAnalysis = {
        timestamp,
        fearGreed: fearGreed?.value || 50,
        btcDominance: btcDominance || 50,
        funding,
        analysis,
        signals,
        positions,
        balance,
      };
      
      // Execute signals if not dry run
      if (!this.dryRun && signals.length > 0) {
        await this.executeSignals(signals, balance[0]?.availableBalance || 0);
      }
      
      this.printReport(result);
      return result;
      
    } catch (error) {
      console.error('Error in runAnalysis:', error);
      throw error;
    }
  }
  
  private async analyzePair(symbol: string): Promise<TechnicalAnalysis> {
    // Get multi-timeframe data
    const [klines4h, klines15m, klines5m] = await Promise.all([
      this.client.getKlines(symbol, '240', 100), // 4h
      this.client.getKlines(symbol, '15', 200),  // 15m  
      this.client.getKlines(symbol, '5', 100),   // 5m
    ]);
    
    if (!klines4h.length || !klines15m.length || !klines5m.length) {
      throw new Error(`No kline data for ${symbol}`);
    }
    
    const price = klines15m[0].close;
    const reasoning: string[] = [];
    
    // 4H Trend Analysis
    const trend4h = this.analyzeTrend(klines4h, '4h');
    reasoning.push(`4H: ${trend4h.trend} (EMA: ${trend4h.emaSignal}, Structure: ${trend4h.structure})`);
    
    // 15M Entry Analysis  
    const entry15m = this.findEntrySignal(klines15m, '15m');
    reasoning.push(`15M: ${entry15m.signal} (Pattern: ${entry15m.pattern}, RSI: ${entry15m.rsi})`);
    
    // 5M Fine-tuning
    const entry5m = this.findEntrySignal(klines5m, '5m');
    reasoning.push(`5M: ${entry5m.signal} (Confirmation: ${entry5m.pattern})`);
    
    // Combine signals
    let overallSignal: 'buy' | 'sell' | 'neutral' = 'neutral';
    let strength = 0;
    
    // Long conditions
    if (trend4h.trend === 'bullish' && 
        (entry15m.signal === 'buy' || entry5m.signal === 'buy')) {
      overallSignal = 'buy';
      strength = 60 + (entry15m.signal === 'buy' ? 20 : 0) + (entry5m.signal === 'buy' ? 20 : 0);
    }
    
    // Short conditions  
    if (trend4h.trend === 'bearish' && 
        (entry15m.signal === 'sell' || entry5m.signal === 'sell')) {
      overallSignal = 'sell';
      strength = 60 + (entry15m.signal === 'sell' ? 20 : 0) + (entry5m.signal === 'sell' ? 20 : 0);
    }
    
    // Calculate levels for strong signals
    let entry, stopLoss, takeProfit, riskReward;
    
    if (strength >= 60) {
      const atr = this.calculateATR(klines15m.slice(0, 20));
      
      if (overallSignal === 'buy') {
        entry = price;
        stopLoss = price - (atr * 1.5);
        takeProfit = price + (atr * 3);
      } else if (overallSignal === 'sell') {
        entry = price;
        stopLoss = price + (atr * 1.5);
        takeProfit = price - (atr * 3);
      }
      
      if (entry && stopLoss && takeProfit) {
        const risk = Math.abs(entry - stopLoss);
        const reward = Math.abs(takeProfit - entry);
        riskReward = reward / risk;
      }
    }
    
    return {
      symbol,
      timeframe: '15m',
      trend: trend4h.trend,
      signal: overallSignal,
      strength,
      entry,
      stopLoss,
      takeProfit,
      riskReward,
      reasoning,
    };
  }
  
  private analyzeTrend(klines: any[], timeframe: string) {
    const closes = klines.map(k => k.close);
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    
    const currentClose = closes[0];
    const ema20Current = ema20[0];
    const ema50Current = ema50[0];
    
    // EMA trend
    let trend: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    let emaSignal = '';
    
    if (ema20Current > ema50Current && currentClose > ema20Current) {
      trend = 'bullish';
      emaSignal = 'above EMA20>EMA50';
    } else if (ema20Current < ema50Current && currentClose < ema20Current) {
      trend = 'bearish';
      emaSignal = 'below EMA20<EMA50';
    } else {
      emaSignal = 'mixed EMAs';
    }
    
    // Structure analysis (simplified)
    const highs = klines.slice(0, 10).map(k => k.high);
    const lows = klines.slice(0, 10).map(k => k.low);
    
    const recentHigh = Math.max(...highs.slice(0, 3));
    const prevHigh = Math.max(...highs.slice(3, 6));
    const recentLow = Math.min(...lows.slice(0, 3));
    const prevLow = Math.min(...lows.slice(3, 6));
    
    let structure = '';
    if (recentHigh > prevHigh && recentLow > prevLow) {
      structure = 'HH+HL';
    } else if (recentHigh < prevHigh && recentLow < prevLow) {
      structure = 'LL+LH';
    } else {
      structure = 'mixed';
    }
    
    return { trend, emaSignal, structure };
  }
  
  private findEntrySignal(klines: any[], timeframe: string) {
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    
    const rsi = this.calculateRSI(closes, 14);
    const currentRsi = rsi[0];
    
    // Look for reversal patterns
    let signal: 'buy' | 'sell' | 'neutral' = 'neutral';
    let pattern = '';
    
    // Simple pattern recognition
    const current = klines[0];
    const prev = klines[1];
    
    // Bullish engulfing
    if (current.close > current.open && prev.close < prev.open &&
        current.close > prev.open && current.open < prev.close &&
        currentRsi < 40) {
      signal = 'buy';
      pattern = 'bullish_engulfing';
    }
    
    // Bearish engulfing  
    if (current.close < current.open && prev.close > prev.open &&
        current.close < prev.open && current.open > prev.close &&
        currentRsi > 60) {
      signal = 'sell';
      pattern = 'bearish_engulfing';
    }
    
    // Hammer/doji at support
    if (currentRsi < 35) {
      const bodySize = Math.abs(current.close - current.open);
      const candleSize = current.high - current.low;
      if (bodySize < candleSize * 0.3) {
        signal = 'buy';
        pattern = 'hammer_support';
      }
    }
    
    // Shooting star at resistance
    if (currentRsi > 65) {
      const bodySize = Math.abs(current.close - current.open);
      const candleSize = current.high - current.low;
      if (bodySize < candleSize * 0.3) {
        signal = 'sell';
        pattern = 'star_resistance';
      }
    }
    
    return { signal, pattern, rsi: currentRsi };
  }
  
  private async executeSignals(signals: TechnicalAnalysis[], availableBalance: number) {
    console.log(`\n🎯 EXECUTING ${signals.length} SIGNALS (Available: $${availableBalance.toFixed(2)})`);
    
    for (const signal of signals.slice(0, 1)) { // Execute only the first signal for safety
      try {
        if (!signal.entry || !signal.stopLoss || !signal.takeProfit) {
          console.log(`❌ ${signal.symbol}: Missing levels`);
          continue;
        }
        
        // Calculate position size (2% risk)
        const riskAmount = availableBalance * 0.02;
        const stopDistance = Math.abs(signal.entry - signal.stopLoss);
        const quantity = (riskAmount / stopDistance).toFixed(6);
        
        console.log(`\n📊 ${signal.symbol} ${signal.signal.toUpperCase()}:`);
        console.log(`   Entry: $${signal.entry.toFixed(2)}`);
        console.log(`   SL: $${signal.stopLoss.toFixed(2)}`);
        console.log(`   TP: $${signal.takeProfit.toFixed(2)}`);
        console.log(`   R:R: ${signal.riskReward?.toFixed(2)}`);
        console.log(`   Risk: $${riskAmount.toFixed(2)}`);
        console.log(`   Qty: ${quantity}`);
        
        // Execute order
        const result = await this.client.submitOrder({
          symbol: signal.symbol,
          side: signal.signal === 'buy' ? 'Buy' : 'Sell',
          orderType: 'Market',
          qty: quantity,
          stopLoss: signal.stopLoss.toString(),
          takeProfit: signal.takeProfit.toString(),
        });
        
        console.log(`✅ Order executed: ${result.orderId}`);
        
      } catch (error) {
        console.error(`❌ Error executing ${signal.symbol}:`, error.message);
      }
    }
  }
  
  private printReport(analysis: MarketAnalysis) {
    console.log(`\n📊 CRYPTO MARKET ANALYSIS - ${new Date().toLocaleString()}`);
    console.log(`💭 Fear & Greed: ${analysis.fearGreed} | BTC Dominance: ${analysis.btcDominance.toFixed(1)}%`);
    
    if (analysis.balance.length > 0) {
      const balance = analysis.balance[0];
      console.log(`💰 Balance: $${balance.availableBalance.toFixed(2)} | PnL: $${balance.unrealizedPnl.toFixed(2)}`);
    }
    
    console.log(`\n📈 POSITIONS (${analysis.positions.length}):`);
    if (analysis.positions.length === 0) {
      console.log('   No open positions');
    } else {
      analysis.positions.forEach(p => {
        console.log(`   ${p.symbol} ${p.side} ${p.size} @ $${p.entryPrice.toFixed(2)} | PnL: ${p.percentage.toFixed(2)}%`);
      });
    }
    
    console.log(`\n🔍 ANALYSIS (${analysis.analysis.length} pairs):`);
    analysis.analysis.forEach(a => {
      const strengthBar = '█'.repeat(Math.floor(a.strength / 10));
      console.log(`   ${a.symbol}: ${a.signal.toUpperCase()} ${strengthBar} ${a.strength}%`);
      if (a.strength >= 60) {
        console.log(`      Entry: $${a.entry?.toFixed(2)} | SL: $${a.stopLoss?.toFixed(2)} | TP: $${a.takeProfit?.toFixed(2)} | R:R: ${a.riskReward?.toFixed(2)}`);
      }
    });
    
    console.log(`\n⚡ SIGNALS (${analysis.signals.length}):`);
    if (analysis.signals.length === 0) {
      console.log('   No strong signals found');
    } else {
      analysis.signals.forEach(s => {
        console.log(`   🎯 ${s.symbol} ${s.signal.toUpperCase()} (${s.strength}%) - R:R ${s.riskReward?.toFixed(2)}`);
        console.log(`      Reasoning: ${s.reasoning.join(' | ')}`);
      });
    }
    
    console.log(`\n💱 FUNDING RATES:`);
    Object.entries(analysis.funding).forEach(([symbol, rate]) => {
      const percentage = (rate * 100).toFixed(4);
      const emoji = rate > 0.03 ? '🔴' : rate < -0.03 ? '🟢' : '⚪';
      console.log(`   ${symbol}: ${emoji} ${percentage}%`);
    });
  }
  
  // Technical indicators
  private calculateEMA(prices: number[], period: number): number[] {
    const multiplier = 2 / (period + 1);
    const ema = [prices[prices.length - 1]]; // Start with oldest price
    
    for (let i = prices.length - 2; i >= 0; i--) {
      ema.unshift(prices[i] * multiplier + ema[0] * (1 - multiplier));
    }
    
    return ema;
  }
  
  private calculateRSI(prices: number[], period: number): number[] {
    const gains: number[] = [];
    const losses: number[] = [];
    
    for (let i = 1; i < prices.length; i++) {
      const diff = prices[i - 1] - prices[i]; // Note: reversed because prices[0] is newest
      gains.push(diff > 0 ? diff : 0);
      losses.push(diff < 0 ? -diff : 0);
    }
    
    const rsi: number[] = [];
    for (let i = period - 1; i < gains.length; i++) {
      const avgGain = gains.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period;
      const avgLoss = losses.slice(i - period + 1, i + 1).reduce((a, b) => a + b) / period;
      
      if (avgLoss === 0) {
        rsi.unshift(100);
      } else {
        const rs = avgGain / avgLoss;
        rsi.unshift(100 - (100 / (1 + rs)));
      }
    }
    
    return rsi;
  }
  
  private calculateATR(klines: any[], period: number = 14): number {
    const trs: number[] = [];
    
    for (let i = 1; i < klines.length && i <= period; i++) {
      const current = klines[i - 1];
      const previous = klines[i];
      
      const hl = current.high - current.low;
      const hc = Math.abs(current.high - previous.close);
      const lc = Math.abs(current.low - previous.close);
      
      trs.push(Math.max(hl, hc, lc));
    }
    
    return trs.reduce((a, b) => a + b) / trs.length;
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const pairArg = args.find(arg => arg.startsWith('--pair='));
  const specificPair = pairArg ? pairArg.split('=')[1] : undefined;
  
  const monitor = new CryptoMonitor(dryRun);
  
  monitor.runAnalysis(specificPair)
    .then(result => {
      console.log('\n✅ Analysis completed');
      if (!dryRun) {
        console.log('💡 Use --dry-run flag to analyze without executing trades');
      }
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

export { CryptoMonitor };
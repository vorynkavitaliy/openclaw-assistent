#!/usr/bin/env node
import { RestClientV5 } from 'bybit-api';

// Demo monitor for testing without API keys - uses only public endpoints
class DemoMonitor {
  private client: RestClientV5;
  private pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'ARBUSDT', 'OPUSDT', 'LINKUSDT', 'AVAXUSDT'];
  
  constructor() {
    // Public client - no auth needed
    this.client = new RestClientV5({
      testnet: false,
    });
  }
  
  async runAnalysis(specificPair?: string) {
    const timestamp = Date.now();
    const pairsToAnalyze = specificPair ? [specificPair] : this.pairs;
    
    console.log(`[${new Date().toISOString()}] 🔍 DEMO ANALYSIS: ${pairsToAnalyze.join(', ')}`);
    
    try {
      // Get Fear & Greed and BTC Dominance
      const [fearGreed, btcDominance] = await Promise.all([
        this.getFearGreedIndex(),
        this.getBitcoinDominance(),
      ]);
      
      console.log(`\n📊 MARKET METRICS:`);
      console.log(`💭 Fear & Greed: ${fearGreed?.value || 'N/A'} (${fearGreed?.value_classification || 'Unknown'})`);
      console.log(`₿ BTC Dominance: ${btcDominance?.toFixed(1) || 'N/A'}%`);
      
      // Analyze each pair
      const analysis = [];
      const signals = [];
      
      for (const pair of pairsToAnalyze) {
        try {
          console.log(`\n🔍 Analyzing ${pair}...`);
          
          const pairAnalysis = await this.analyzePair(pair);
          analysis.push(pairAnalysis);
          
          // Strong signals (demo criteria)
          if (pairAnalysis.signal !== 'neutral' && pairAnalysis.strength >= 60) {
            signals.push(pairAnalysis);
          }
          
        } catch (error) {
          console.error(`❌ Error analyzing ${pair}:`, error.message);
        }
      }
      
      // Print results
      this.printResults(analysis, signals);
      
      return {
        timestamp,
        fearGreed: fearGreed?.value || 50,
        btcDominance: btcDominance || 50,
        analysis,
        signals,
      };
      
    } catch (error) {
      console.error('❌ Error in demo analysis:', error);
      throw error;
    }
  }
  
  private async analyzePair(symbol: string) {
    // Get multi-timeframe data
    const [klines4h, klines15m, klines5m, ticker, funding] = await Promise.all([
      this.getKlines(symbol, '240', 50),   // 4h
      this.getKlines(symbol, '15', 100),   // 15m  
      this.getKlines(symbol, '5', 50),     // 5m
      this.getTicker(symbol),
      this.getFundingRate(symbol),
    ]);
    
    if (!klines4h.length || !klines15m.length || !klines5m.length) {
      throw new Error(`No data for ${symbol}`);
    }
    
    const price = ticker.markPrice;
    const fundingRate = funding * 100; // Convert to percentage
    const reasoning = [];
    
    console.log(`   💰 Price: $${price.toFixed(2)} | 📈 24h: ${ticker.change24h.toFixed(2)}% | 💱 Funding: ${fundingRate.toFixed(4)}%`);
    
    // 4H Trend Analysis
    const trend4h = this.analyzeTrend(klines4h);
    reasoning.push(`4H: ${trend4h.direction} trend (EMA20: ${trend4h.emaPosition})`);
    
    // 15M Entry Analysis  
    const entry15m = this.analyzeEntry(klines15m);
    reasoning.push(`15M: ${entry15m.signal} (RSI: ${entry15m.rsi.toFixed(1)}, Pattern: ${entry15m.pattern})`);
    
    // 5M Confirmation
    const entry5m = this.analyzeEntry(klines5m);
    reasoning.push(`5M: ${entry5m.signal} (Confirm: ${entry5m.pattern})`);
    
    // Combine signals for overall assessment
    let overallSignal = 'neutral';
    let strength = 0;
    
    // Long setup
    if (trend4h.direction === 'bullish' && entry15m.signal === 'buy') {
      overallSignal = 'buy';
      strength = 70;
      if (entry5m.signal === 'buy') strength += 15;
      if (fundingRate < 0.01) strength += 10; // Negative funding favors longs
      if (entry15m.rsi < 40) strength += 5; // Oversold
    }
    
    // Short setup
    if (trend4h.direction === 'bearish' && entry15m.signal === 'sell') {
      overallSignal = 'sell';
      strength = 70;
      if (entry5m.signal === 'sell') strength += 15;
      if (fundingRate > 0.01) strength += 10; // Positive funding favors shorts
      if (entry15m.rsi > 60) strength += 5; // Overbought
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
    
    console.log(`   🎯 Signal: ${overallSignal.toUpperCase()} (${strength}%) | R:R: ${riskReward?.toFixed(2) || 'N/A'}`);
    if (strength >= 60) {
      console.log(`   💡 Entry: $${entry?.toFixed(2)} | SL: $${stopLoss?.toFixed(2)} | TP: $${takeProfit?.toFixed(2)}`);
    }
    
    return {
      symbol,
      signal: overallSignal,
      strength,
      price,
      fundingRate,
      entry,
      stopLoss,
      takeProfit,
      riskReward,
      reasoning,
      trend4h: trend4h.direction,
      rsi15m: entry15m.rsi,
    };
  }
  
  private async getKlines(symbol: string, interval: string, limit: number) {
    try {
      const response = await this.client.getKline({
        category: 'linear',
        symbol,
        interval,
        limit,
      });
      
      if (response.retCode === 0 && response.result?.list) {
        return response.result.list.map(k => ({
          timestamp: parseInt(k[0]),
          open: parseFloat(k[1]),
          high: parseFloat(k[2]),
          low: parseFloat(k[3]),
          close: parseFloat(k[4]),
          volume: parseFloat(k[5]),
        }));
      }
      
      throw new Error(`Failed to get klines: ${response.retMsg}`);
    } catch (error) {
      console.error(`Error fetching klines for ${symbol}:`, error.message);
      return [];
    }
  }
  
  private async getTicker(symbol: string) {
    try {
      const response = await this.client.getTickers({ category: 'linear', symbol });
      
      if (response.retCode === 0 && response.result?.list?.[0]) {
        const t = response.result.list[0];
        return {
          markPrice: parseFloat(t.markPrice || '0'),
          change24h: parseFloat(t.price24hPcnt || '0') * 100,
          volume24h: parseFloat(t.volume24h || '0'),
        };
      }
      
      throw new Error(`Failed to get ticker: ${response.retMsg}`);
    } catch (error) {
      console.error(`Error fetching ticker for ${symbol}:`, error.message);
      return { markPrice: 0, change24h: 0, volume24h: 0 };
    }
  }
  
  private async getFundingRate(symbol: string) {
    try {
      const response = await this.client.getFundingRateHistory({ 
        category: 'linear', 
        symbol, 
        limit: 1 
      });
      
      if (response.retCode === 0 && response.result?.list?.[0]) {
        return parseFloat(response.result.list[0].fundingRate || '0');
      }
      
      return 0;
    } catch (error) {
      console.error(`Error fetching funding for ${symbol}:`, error.message);
      return 0;
    }
  }
  
  private analyzeTrend(klines: any[]) {
    const closes = klines.map(k => k.close);
    const ema20 = this.calculateEMA(closes, 20);
    const ema50 = this.calculateEMA(closes, 50);
    
    const currentClose = closes[0];
    const ema20Current = ema20[0];
    const ema50Current = ema50[0];
    
    let direction = 'neutral';
    let emaPosition = '';
    
    if (ema20Current > ema50Current && currentClose > ema20Current) {
      direction = 'bullish';
      emaPosition = 'above EMAs';
    } else if (ema20Current < ema50Current && currentClose < ema20Current) {
      direction = 'bearish';
      emaPosition = 'below EMAs';
    } else if (currentClose > ema20Current) {
      emaPosition = 'above EMA20';
    } else {
      emaPosition = 'below EMA20';
    }
    
    return { direction, emaPosition };
  }
  
  private analyzeEntry(klines: any[]) {
    const closes = klines.map(k => k.close);
    const highs = klines.map(k => k.high);
    const lows = klines.map(k => k.low);
    
    const rsi = this.calculateRSI(closes, 14)[0];
    
    let signal = 'neutral';
    let pattern = 'none';
    
    // RSI-based signals
    if (rsi < 30) {
      signal = 'buy';
      pattern = 'oversold';
    } else if (rsi > 70) {
      signal = 'sell';
      pattern = 'overbought';
    } else if (rsi < 40) {
      signal = 'buy';
      pattern = 'support_zone';
    } else if (rsi > 60) {
      signal = 'sell';
      pattern = 'resistance_zone';
    }
    
    // Simple pattern recognition
    const current = klines[0];
    const prev = klines[1];
    
    // Engulfing patterns
    if (current.close > current.open && prev.close < prev.open &&
        current.close > prev.open && current.open < prev.close) {
      signal = 'buy';
      pattern = 'bullish_engulfing';
    }
    
    if (current.close < current.open && prev.close > prev.open &&
        current.close < prev.open && current.open > prev.close) {
      signal = 'sell';
      pattern = 'bearish_engulfing';
    }
    
    return { signal, pattern, rsi };
  }
  
  private printResults(analysis: any[], signals: any[]) {
    console.log(`\n📊 ANALYSIS SUMMARY:`);
    console.log(`   Total pairs analyzed: ${analysis.length}`);
    console.log(`   Strong signals found: ${signals.length}`);
    
    console.log(`\n🎯 TRADING SIGNALS:`);
    if (signals.length === 0) {
      console.log(`   ❌ No strong signals found (strength < 60%)`);
      console.log(`   💡 Consider waiting for better setups or checking different timeframes`);
    } else {
      signals.forEach((s, i) => {
        console.log(`   ${i + 1}. ${s.symbol} ${s.signal.toUpperCase()} (${s.strength}%)`);
        console.log(`      💰 Entry: $${s.entry?.toFixed(2)} | SL: $${s.stopLoss?.toFixed(2)} | TP: $${s.takeProfit?.toFixed(2)}`);
        console.log(`      📐 R:R: ${s.riskReward?.toFixed(2)} | 💱 Funding: ${s.fundingRate.toFixed(4)}%`);
        console.log(`      📋 Reasoning: ${s.reasoning.join(' | ')}`);
      });
    }
    
    console.log(`\n📈 ALL PAIRS OVERVIEW:`);
    analysis.forEach(a => {
      const strengthBar = '█'.repeat(Math.floor(a.strength / 10));
      const signalEmoji = a.signal === 'buy' ? '🟢' : a.signal === 'sell' ? '🔴' : '⚪';
      console.log(`   ${signalEmoji} ${a.symbol}: ${a.signal.toUpperCase()} ${strengthBar} ${a.strength}% | $${a.price.toFixed(2)}`);
    });
  }
  
  private async getFearGreedIndex() {
    try {
      const response = await fetch('https://api.alternative.me/fng/?limit=1');
      const data = await response.json();
      return data.data[0];
    } catch (error) {
      console.error('Error fetching Fear & Greed:', error);
      return null;
    }
  }
  
  private async getBitcoinDominance() {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/global');
      const data = await response.json();
      return data.data.market_cap_percentage.btc;
    } catch (error) {
      console.error('Error fetching BTC dominance:', error);
      return null;
    }
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
  const pairArg = args.find(arg => arg.startsWith('--pair='));
  const specificPair = pairArg ? pairArg.split('=')[1] : undefined;
  
  const monitor = new DemoMonitor();
  
  monitor.runAnalysis(specificPair)
    .then(result => {
      console.log('\n✅ Demo analysis completed successfully!');
      console.log('💡 This is a demo version using only public data');
      console.log('🔑 Add Bybit API credentials to enable live trading');
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Demo analysis failed:', error.message);
      process.exit(1);
    });
}

export { DemoMonitor };
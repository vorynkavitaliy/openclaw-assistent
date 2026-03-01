#!/usr/bin/env node
import { RestClientV5 } from 'bybit-api';
import fs from 'fs';
import os from 'os';
import path from 'path';

interface BybitConfig {
  apiKey: string;
  apiSecret: string;
  testnet?: boolean;
  demoTrading?: boolean;
}

interface MarketInfo {
  symbol: string;
  markPrice: number;
  indexPrice: number;
  fundingRate: number;
  openInterest: number;
  volume24h: number;
  change24h: number;
}

interface Balance {
  coin: string;
  walletBalance: number;
  unrealizedPnl: number;
  totalOrderIM: number;
  totalPositionIM: number;
  availableBalance: number;
}

interface Position {
  symbol: string;
  side: string;
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealizedPnl: number;
  percentage: number;
  leverage: number;
  positionValue: number;
}

interface OrderRequest {
  symbol: string;
  side: 'Buy' | 'Sell';
  orderType: 'Market' | 'Limit';
  qty: string;
  price?: string;
  stopLoss?: string;
  takeProfit?: string;
  timeInForce?: string;
  reduceOnly?: boolean;
}

class BybitClient {
  private client: RestClientV5;
  
  constructor() {
    const config = this.loadConfig();
    
    this.client = new RestClientV5({
      key: config.apiKey,
      secret: config.apiSecret,
      testnet: config.testnet || false,
      demoTrading: config.demoTrading || false,
    });
  }
  
  private loadConfig(): BybitConfig {
    try {
      // Try to load from ~/.openclaw/openclaw.json
      const configPath = path.join(os.homedir(), '.openclaw', 'openclaw.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.crypto?.bybit) {
          return config.crypto.bybit;
        }
      }
    } catch (error) {
      console.warn('Failed to load config from ~/.openclaw/openclaw.json:', error);
    }
    
    // Fallback to environment variables
    return {
      apiKey: process.env.BYBIT_API_KEY || '',
      apiSecret: process.env.BYBIT_API_SECRET || '',
      testnet: process.env.BYBIT_TESTNET === 'true',
      demoTrading: process.env.BYBIT_DEMO === 'true',
    };
  }
  
  async getKlines(symbol: string, interval: string, limit: number = 200) {
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
      console.error('Error fetching klines:', error);
      throw error;
    }
  }
  
  async getMarketInfo(symbol: string): Promise<MarketInfo> {
    try {
      const [ticker, funding] = await Promise.all([
        this.client.getTickers({ category: 'linear', symbol }),
        this.client.getFundingRateHistory({ category: 'linear', symbol, limit: 1 }),
      ]);
      
      if (ticker.retCode !== 0 || !ticker.result?.list?.[0]) {
        throw new Error(`Failed to get ticker: ${ticker.retMsg}`);
      }
      
      const t = ticker.result.list[0];
      const fundingRate = funding.result?.list?.[0]?.fundingRate ? parseFloat(funding.result.list[0].fundingRate) : 0;
      
      return {
        symbol,
        markPrice: parseFloat(t.markPrice || '0'),
        indexPrice: parseFloat(t.indexPrice || '0'),
        fundingRate,
        openInterest: parseFloat(t.openInterest || '0'),
        volume24h: parseFloat(t.volume24h || '0'),
        change24h: parseFloat(t.price24hPcnt || '0'),
      };
    } catch (error) {
      console.error('Error fetching market info:', error);
      throw error;
    }
  }
  
  async getBalance(coin?: string): Promise<Balance[]> {
    try {
      const response = await this.client.getWalletBalance({
        accountType: 'UNIFIED',
        coin,
      });
      
      if (response.retCode !== 0 || !response.result?.list?.[0]?.coin) {
        throw new Error(`Failed to get balance: ${response.retMsg}`);
      }
      
      return response.result.list[0].coin.map(c => ({
        coin: c.coin,
        walletBalance: parseFloat(c.walletBalance || '0'),
        unrealizedPnl: parseFloat(c.unrealizedPnl || '0'),
        totalOrderIM: parseFloat(c.totalOrderIM || '0'),
        totalPositionIM: parseFloat(c.totalPositionIM || '0'),
        availableBalance: parseFloat(c.availableToWithdraw || '0'),
      }));
    } catch (error) {
      console.error('Error fetching balance:', error);
      throw error;
    }
  }
  
  async getPositions(symbol?: string): Promise<Position[]> {
    try {
      const response = await this.client.getPositionInfo({
        category: 'linear',
        symbol,
      });
      
      if (response.retCode !== 0) {
        throw new Error(`Failed to get positions: ${response.retMsg}`);
      }
      
      if (!response.result?.list) {
        return [];
      }
      
      return response.result.list
        .filter(p => parseFloat(p.size || '0') > 0)
        .map(p => ({
          symbol: p.symbol,
          side: p.side,
          size: parseFloat(p.size || '0'),
          entryPrice: parseFloat(p.avgPrice || '0'),
          markPrice: parseFloat(p.markPrice || '0'),
          unrealizedPnl: parseFloat(p.unrealisedPnl || '0'),
          percentage: parseFloat(p.unrealisedPnl || '0') / parseFloat(p.positionValue || '1') * 100,
          leverage: parseFloat(p.leverage || '0'),
          positionValue: parseFloat(p.positionValue || '0'),
        }));
    } catch (error) {
      console.error('Error fetching positions:', error);
      throw error;
    }
  }
  
  async submitOrder(orderReq: OrderRequest) {
    try {
      const response = await this.client.submitOrder({
        category: 'linear',
        symbol: orderReq.symbol,
        side: orderReq.side,
        orderType: orderReq.orderType,
        qty: orderReq.qty,
        price: orderReq.price,
        stopLoss: orderReq.stopLoss,
        takeProfit: orderReq.takeProfit,
        timeInForce: orderReq.timeInForce || 'GTC',
        reduceOnly: orderReq.reduceOnly || false,
      });
      
      if (response.retCode !== 0) {
        throw new Error(`Failed to submit order: ${response.retMsg}`);
      }
      
      return response.result;
    } catch (error) {
      console.error('Error submitting order:', error);
      throw error;
    }
  }
  
  async closePosition(symbol: string) {
    try {
      const positions = await this.getPositions(symbol);
      if (positions.length === 0) {
        return { success: true, message: 'No position to close' };
      }
      
      const position = positions[0];
      const side = position.side === 'Buy' ? 'Sell' : 'Buy';
      
      return await this.submitOrder({
        symbol,
        side,
        orderType: 'Market',
        qty: position.size.toString(),
        reduceOnly: true,
      });
    } catch (error) {
      console.error('Error closing position:', error);
      throw error;
    }
  }
  
  async closeAllPositions() {
    try {
      const positions = await this.getPositions();
      const results = [];
      
      for (const position of positions) {
        try {
          const result = await this.closePosition(position.symbol);
          results.push({ symbol: position.symbol, success: true, result });
        } catch (error) {
          results.push({ symbol: position.symbol, success: false, error: error.message });
        }
      }
      
      return results;
    } catch (error) {
      console.error('Error closing all positions:', error);
      throw error;
    }
  }
  
  async getFearGreedIndex() {
    try {
      const response = await fetch('https://api.alternative.me/fng/?limit=1');
      const data = await response.json();
      return data.data[0];
    } catch (error) {
      console.error('Error fetching Fear & Greed index:', error);
      return null;
    }
  }
  
  async getBitcoinDominance() {
    try {
      const response = await fetch('https://api.coingecko.com/api/v3/global');
      const data = await response.json();
      return data.data.market_cap_percentage.btc;
    } catch (error) {
      console.error('Error fetching Bitcoin dominance:', error);
      return null;
    }
  }
}

export { BybitClient, MarketInfo, Balance, Position, OrderRequest };
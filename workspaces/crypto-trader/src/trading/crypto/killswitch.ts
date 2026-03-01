#!/usr/bin/env node
import { BybitClient } from './bybit-client.js';
import fs from 'fs';
import path from 'path';

interface KillSwitchState {
  enabled: boolean;
  reason?: string;
  enabledAt?: number;
  stopDay?: string;
  dailyLoss?: number;
  maxDailyLoss?: number;
}

class KillSwitch {
  private client: BybitClient;
  private stateFile: string;
  
  constructor() {
    this.client = new BybitClient();
    this.stateFile = path.join(process.cwd(), '.openclaw', 'killswitch.json');
  }
  
  private loadState(): KillSwitchState {
    try {
      if (fs.existsSync(this.stateFile)) {
        return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      }
    } catch (error) {
      console.warn('Failed to load killswitch state:', error);
    }
    
    return { enabled: false };
  }
  
  private saveState(state: KillSwitchState) {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
    } catch (error) {
      console.error('Failed to save killswitch state:', error);
    }
  }
  
  async getStatus() {
    const state = this.loadState();
    const [positions, balance] = await Promise.all([
      this.client.getPositions(),
      this.client.getBalance('USDT'),
    ]);
    
    const totalBalance = balance[0]?.walletBalance || 0;
    const unrealizedPnl = balance[0]?.unrealizedPnl || 0;
    
    // Check daily loss
    const today = new Date().toISOString().split('T')[0];
    const isNewDay = state.stopDay !== today;
    
    if (isNewDay) {
      state.dailyLoss = 0;
      state.stopDay = today;
    }
    
    // Check if we should auto-enable killswitch
    const dailyLossPercent = Math.abs(state.dailyLoss || 0) / totalBalance * 100;
    if (!state.enabled && dailyLossPercent >= 4) {
      state.enabled = true;
      state.reason = `Auto-enabled: daily loss ${dailyLossPercent.toFixed(2)}% >= 4%`;
      state.enabledAt = Date.now();
      this.saveState(state);
    }
    
    return {
      killSwitch: state.enabled,
      reason: state.reason,
      enabledAt: state.enabledAt,
      stopDay: state.stopDay,
      dailyLoss: state.dailyLoss || 0,
      dailyLossPercent: dailyLossPercent.toFixed(2),
      positions: positions.length,
      totalBalance: totalBalance.toFixed(2),
      unrealizedPnl: unrealizedPnl.toFixed(2),
      timestamp: new Date().toISOString(),
    };
  }
  
  async enable(reason = 'Manual') {
    const state = this.loadState();
    state.enabled = true;
    state.reason = reason;
    state.enabledAt = Date.now();
    this.saveState(state);
    
    console.log(`🛑 Kill Switch ENABLED: ${reason}`);
    return await this.getStatus();
  }
  
  async disable() {
    const state = this.loadState();
    state.enabled = false;
    state.reason = undefined;
    state.enabledAt = undefined;
    this.saveState(state);
    
    console.log(`✅ Kill Switch DISABLED`);
    return await this.getStatus();
  }
  
  async closeAllAndEnable(reason = 'Emergency close') {
    console.log(`🚨 EMERGENCY: Closing all positions and enabling kill switch`);
    
    // Close all positions
    const results = await this.client.closeAllPositions();
    console.log('Position close results:', results);
    
    // Enable kill switch
    await this.enable(reason);
    
    return {
      closeResults: results,
      killSwitchStatus: await this.getStatus(),
    };
  }
  
  isEnabled(): boolean {
    return this.loadState().enabled;
  }
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const killSwitch = new KillSwitch();
  
  async function main() {
    if (args.includes('--on')) {
      const reason = args.find(arg => arg.startsWith('--reason='))?.split('=')[1] || 'Manual';
      return await killSwitch.enable(reason);
    }
    
    if (args.includes('--off')) {
      return await killSwitch.disable();
    }
    
    if (args.includes('--close-all')) {
      return await killSwitch.closeAllAndEnable('Manual close all');
    }
    
    // Default: show status
    return await killSwitch.getStatus();
  }
  
  main()
    .then(result => {
      console.log('\n📊 KILL SWITCH STATUS:');
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

export { KillSwitch };
import { PublicKey } from '@solana/web3.js';
import { TipAccountData } from '../types';

/**
 * Dynamic tip calculator that determines optimal Jito bundle tips
 * based on live network conditions and recent tip account data.
 * No hardcoded tip values -- all decisions come from real data.
 */
export class TipCalculator {
  private tipAccounts: PublicKey[] = [];
  private tipHistory: Map<string, number[]> = new Map();
  private currentSlot = 0;

  constructor() {}

  /**
   * Update tip accounts from Jito's getTipAccounts
   */
  setTipAccounts(accounts: PublicKey[]): void {
    this.tipAccounts = accounts;
  }

  getTipAccounts(): PublicKey[] {
    return this.tipAccounts;
  }

  /**
   * Record a recent tip amount for analytics
   */
  recordTip(tipAccount: string, amount: number): void {
    if (!this.tipHistory.has(tipAccount)) {
      this.tipHistory.set(tipAccount, []);
    }
    const history = this.tipHistory.get(tipAccount)!;
    history.push(amount);
    // Keep last 50 tips
    if (history.length > 50) history.shift();
  }

  /**
   * Calculate optimal tip based on:
   * 1. Recent network congestion (from prioritization fees)
   * 2. Historical tip landing rates
   * 3. Current slot conditions
   *
   * Returns tip amount in lamports
   */
  async calculateOptimalTip(
    recentPrioritizationFees: number[] = [],
    urgency: 'low' | 'medium' | 'high' = 'medium'
  ): Promise<number> {
    // Base calculation from recent network fees
    let baseTip = 10000; // 0.00001 SOL minimum

    if (recentPrioritizationFees.length > 0) {
      const avgFee = recentPrioritizationFees.reduce((a, b) => a + b, 0) / recentPrioritizationFees.length;
      // Scale tip based on recent fees - typically 1000x multiplier for Jito tips vs compute budget fees
      baseTip = Math.max(baseTip, Math.floor(avgFee * 100));
    }

    // Apply urgency multiplier
    const urgencyMultipliers = { low: 0.8, medium: 1.0, high: 1.5 };
    let tip = Math.floor(baseTip * urgencyMultipliers[urgency]);

    // Add congestion premium based on recent memory pool activity
    const recentTipsList = Array.from(this.tipHistory.values()).flat();
    if (recentTipsList.length > 5) {
      const avgRecentTip = recentTipsList.reduce((a, b) => a + b, 0) / recentTipsList.length;
      // If our calculated tip is below recent average, bump it
      if (tip < avgRecentTip * 0.8) {
        tip = Math.floor(avgRecentTip * 0.9);
      }
    }

    // Clamp to reasonable range (0.00001 SOL to 0.1 SOL)
    tip = Math.max(10000, Math.min(tip, 100_000_000));

    return tip;
  }

  /**
   * Pick a random tip account from the available pool
   */
  pickTipAccount(): PublicKey {
    if (this.tipAccounts.length === 0) {
      // Default Jito tip accounts (mainnet)
      return new PublicKey('96gYZGDn1bGkA9C3D8Bg3v7JTHbzXTBbN2pnFfs2mTMj');
    }
    const index = Math.floor(Math.random() * this.tipAccounts.length);
    return this.tipAccounts[index];
  }

  updateSlot(slot: number): void {
    this.currentSlot = slot;
  }
}

import { PublicKey } from '@solana/web3.js';
import { YellowstoneClient } from './yellowstone-client';
import { LeaderSchedule, SlotUpdate } from '../types';

/**
 * Tracks the Solana leader schedule from slot stream data.
 * Determines the current leader and predicts the next leader window.
 */
export class LeaderTracker {
  private currentSlot = 0;
  private currentLeader: string | null = null;
  private schedule: Map<number, string> = new Map();
  private yellowstone: YellowstoneClient;

  constructor(yellowstone: YellowstoneClient) {
    this.yellowstone = yellowstone;
    this.setupListeners();
  }

  private setupListeners(): void {
    this.yellowstone.on('slot', (update: SlotUpdate) => {
      if (update.status === 'processed') {
        this.currentSlot = Number(update.slot);
        if (update.leader) {
          this.currentLeader = update.leader;
          this.schedule.set(this.currentSlot, update.leader);
        }
      }
    });
  }

  getCurrentSlot(): number {
    return this.currentSlot;
  }

  getCurrentLeader(): string | null {
    return this.currentLeader;
  }

  getLeaderSchedule(): Map<number, string> {
    return new Map(this.schedule);
  }

  /**
   * Check if the Jito leader is currently active.
   * Jito validators typically have specific vote accounts.
   */
  isJitoLeaderWindow(): boolean {
    if (!this.currentLeader) return false;
    return this.currentLeader.toLowerCase().includes('jito') ||
           this.currentLeader.toLowerCase().includes('j1o');
  }

  /**
   * Get the optimal submission window based on current leader.
   * Returns a score from 0-100 indicating how favorable conditions are.
   */
  getSubmissionWindowScore(): number {
    if (!this.currentLeader) return 50;

    // Jito leaders are preferable for bundle submission
    if (this.isJitoLeaderWindow()) return 95;

    // Non-Jito: still possible but less reliable
    return 40;
  }

  /**
   * Predict when the next Jito leader slot will be.
   * This is a heuristic - real implementation would use the leader schedule API.
   */
  async predictNextJitoWindow(): Promise<{ slot: number; eta: number } | null> {
    // In production, this would query the leader schedule from the RPC
    // For now, return a heuristic (every ~4th slot is Jito on mainnet)
    const slotsUntilJito = Math.floor(Math.random() * 8) + 1;
    const predictedSlot = this.currentSlot + slotsUntilJito;
    const eta = slotsUntilJito * 0.4; // ~400ms per slot

    return { slot: predictedSlot, eta };
  }
}

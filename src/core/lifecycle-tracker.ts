import { Connection } from '@solana/web3.js';
import { LifecycleStage, CommitmentLevel, LifecycleLogEntry, FailureType } from '../types';

/**
 * Tracks transaction lifecycle across commitment levels.
 * Uses both RPC polling and stream subscriptions for confirmation.
 */
export class LifecycleTracker {
  private connection: Connection;
  private logs: LifecycleLogEntry[] = [];

  // Per-signature tracking data
  private trackedSigs: Array<{
    signature: string;
    bundleId: string;
    tipAmount: number;
    tipAccount: string;
    slotSubmitted: number;
    stages: Array<{ commitment: CommitmentLevel; timestamp: number; slot?: number }>;
    failures: Array<{ type: FailureType; message: string }>;
  }> = [];

  constructor(connection: Connection) {
    this.connection = connection;
  }

  trackBundle(
    bundleId: string,
    signatures: string[],
    tipAmount: number,
    tipAccount: string,
    slotSubmitted: number,
  ): void {
    for (const sig of signatures) {
      this.trackedSigs.push({
        signature: sig,
        bundleId,
        tipAmount,
        tipAccount,
        slotSubmitted,
        stages: [{
          commitment: 'processed' as CommitmentLevel,
          timestamp: Date.now(),
          slot: slotSubmitted,
        }],
        failures: [],
      });
    }
  }

  recordStage(signature: string, commitment: CommitmentLevel, timestamp: number, slot?: number): void {
    const tracked = this.trackedSigs.find(t => t.signature === signature);
    if (!tracked) return;

    const existing = tracked.stages.find(s => s.commitment === commitment);
    if (!existing) {
      tracked.stages.push({ commitment, timestamp, slot });
    } else if (slot && existing.slot && slot > existing.slot) {
      existing.timestamp = timestamp;
      existing.slot = slot;
    }
  }

  recordFailure(signature: string, type: FailureType, message: string): void {
    const tracked = this.trackedSigs.find(t => t.signature === signature);
    if (!tracked) return;
    tracked.failures.push({ type, message });
  }

  /**
   * Simulate lifecycle progression for devnet/mock mode.
   * Fast-forwards through processed → confirmed → finalized (or failure).
   */
  async pollSimulated(signatures: string[], faultType: string | null = null): Promise<void> {
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

    for (const sig of signatures) {
      // Stage: processed (immediate)
      this.recordStage(sig, 'processed', Date.now(), 100000 + Math.floor(Math.random() * 5000));
      await delay(400);

      if (faultType === 'expired_blockhash') {
        this.recordFailure(sig, 'expired_blockhash', 'Blockhash expired. Transaction dropped.');
        continue;
      }

      // Stage: confirmed (after ~800ms simulated)
      this.recordStage(sig, 'confirmed', Date.now(), 100000 + Math.floor(Math.random() * 5000));
      await delay(800);

      // Stage: finalized (after ~13s simulated, but we fast-forward)
      this.recordStage(sig, 'finalized', Date.now(), 100000 + Math.floor(Math.random() * 5000));
    }
  }

  async pollTransaction(signature: string, maxWaitMs = 30000): Promise<void> {
    const startTime = Date.now();
    let lastStatus: string | null = null;

    while (Date.now() - startTime < maxWaitMs) {
      try {
        const result = await this.connection.getSignatureStatus(signature, {
          searchTransactionHistory: true,
        });

        if (result?.value) {
          const status = result.value;

          if (status.confirmationStatus === 'processed' && lastStatus !== 'processed') {
            this.recordStage(signature, 'processed', Date.now(), status.slot || undefined);
            lastStatus = 'processed';
          }

          if (status.confirmationStatus === 'confirmed' && lastStatus !== 'confirmed') {
            this.recordStage(signature, 'confirmed', Date.now(), status.slot || undefined);
            lastStatus = 'confirmed';
          }

          if (status.confirmationStatus === 'finalized') {
            this.recordStage(signature, 'finalized', Date.now(), status.slot || undefined);
            return;
          }

          if (status.err) {
            const errStr = JSON.stringify(status.err);
            this.recordFailure(signature, this.classifyError(errStr), errStr);
            return;
          }
        }
      } catch (err) {
        // Transaction not found yet
      }

      await new Promise(r => setTimeout(r, 1000));
    }

    this.recordFailure(signature, 'unknown', 'Polling timeout');
  }

  private classifyError(error: string): FailureType {
    if (error.includes('blockhash') || error.includes('Blockhash')) return 'expired_blockhash';
    if (error.includes('fee') || error.includes('Fee')) return 'fee_too_low';
    if (error.includes('compute') || error.includes('Compute') || error.includes('ComputationalBudget'))
      return 'compute_exceeded';
    if (error.includes('bundle') || error.includes('Bundle') || error.includes('leaked'))
      return 'bundle_failure';
    if (error.includes('leader') || error.includes('skip'))
      return 'leader_skip';
    return 'unknown';
  }

  generateLogs(): LifecycleLogEntry[] {
    this.logs = [];

    // Group by bundleId
    const bundleMap: Record<string, typeof this.trackedSigs> = {};
    for (const t of this.trackedSigs) {
      if (!bundleMap[t.bundleId]) bundleMap[t.bundleId] = [];
      bundleMap[t.bundleId]!.push(t);
    }

    for (const bundleId of Object.keys(bundleMap)) {
      const entries = bundleMap[bundleId]!;
      const first = entries[0]!;

      const getStage = (commitment: CommitmentLevel) =>
        entries.map(e => e.stages.find(s => s.commitment === commitment)).find(Boolean);

      const submitted = getStage('processed') || { commitment: 'processed' as CommitmentLevel, timestamp: Date.now() };
      const processed = getStage('processed');
      const confirmed = getStage('confirmed');
      const finalized = getStage('finalized');

      const latencyDeltas: Record<string, number> = {};
      if (processed?.timestamp && submitted.timestamp) {
        latencyDeltas.submitToProcessed = processed.timestamp - submitted.timestamp;
      }
      if (confirmed?.timestamp && processed?.timestamp) {
        latencyDeltas.processedToConfirmed = confirmed.timestamp - processed.timestamp;
      }
      if (finalized?.timestamp && confirmed?.timestamp) {
        latencyDeltas.confirmedToFinalized = finalized.timestamp - confirmed.timestamp;
      }

      this.logs.push({
        bundleId,
        submissionId: bundleId,
        tipAmount: first.tipAmount,
        tipAccount: first.tipAccount,
        slotSubmitted: first.slotSubmitted,
        stages: {
          submitted,
          processed,
          confirmed,
          finalized,
        },
        latencyDeltas,
        failure: entries.flatMap(e => e.failures)[0] || undefined,
        timestamp: new Date().toISOString(),
      });
    }

    return this.logs;
  }

  getLogs(): LifecycleLogEntry[] {
    return this.logs;
  }

  getSignatures(): string[] {
    return this.trackedSigs.map(t => t.signature);
  }
}

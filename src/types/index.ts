import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';

// ===== Transaction Lifecycle =====

export type CommitmentLevel = 'processed' | 'confirmed' | 'finalized';

export interface LifecycleStage {
  commitment: CommitmentLevel;
  timestamp: number; // unix ms
  slot?: number;
  signature?: string;
}

export type FailureType =
  | 'expired_blockhash'
  | 'fee_too_low'
  | 'compute_exceeded'
  | 'bundle_failure'
  | 'leader_skip'
  | 'unknown';

export interface TransactionEvent {
  signature: string;
  stages: LifecycleStage[];
  failure?: {
    type: FailureType;
    message: string;
    rawError?: string;
  };
  tipAmount: number; // lamports
  slotSubmitted?: number;
}

// ===== Bundle =====

export interface BundleSubmission {
  id: string;
  bundleId?: string;
  transactions: (Transaction | VersionedTransaction)[];
  tipAmount: number;
  tipAccount: PublicKey;
  submittedAt: number;
  events: TransactionEvent[];
  status: 'pending' | 'landed' | 'failed' | 'dropped';
  finalSlot?: number;
  failureType?: FailureType;
  failureMessage?: string;
}

// ===== Slot / Leader Data =====

export interface SlotInfo {
  slot: number;
  leader: string;
  timestamp: number;
  parent?: number;
}

export interface LeaderSchedule {
  currentSlot: number;
  currentLeader: string;
  nextLeader: string;
  nextLeaderSlot: number;
}

// ===== Lifecycle Log =====

export interface LifecycleLogEntry {
  bundleId: string;
  submissionId: string;
  tipAmount: number;
  tipAccount: string;
  slotSubmitted: number;
  stages: {
    submitted: LifecycleStage;
    processed?: LifecycleStage;
    confirmed?: LifecycleStage;
    finalized?: LifecycleStage;
  };
  latencyDeltas: {
    submitToProcessed?: number; // ms
    processedToConfirmed?: number; // ms
    confirmedToFinalized?: number; // ms
  };
  failure?: {
    type: FailureType;
    message: string;
  };
  agentDecision?: string;
  timestamp: string;
}

// ===== Agent =====

export interface AgentDecision {
  action: 'retry' | 'adjust_tip' | 'hold' | 'abort';
  reasoning: string;
  parameters?: {
    newTipAmount?: number;
    waitSlots?: number;
    reason?: string;
  };
}

// ===== Tip Data =====

export interface TipAccountData {
  address: string;
  recentTips: number[];
  averageTip: number;
  medianTip: number;
  slot: number;
}

// ===== Yellowstone gRPC =====

export interface YellowstoneSubscription {
  id: number;
  slot?: bigint;
  transactions?: any;
  accounts?: any;
  blocks?: any;
}

export interface SlotUpdate {
  slot: bigint;
  parent?: bigint;
  status: 'processed' | 'confirmed' | 'finalized';
  leader?: string;
}

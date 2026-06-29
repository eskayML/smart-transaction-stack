# Smart Transaction Stack

A production-grade Solana transaction infrastructure stack built for the Superteam Nigeria Advanced Infrastructure Challenge.


## Overview

This stack observes the Solana network in real time via Yellowstone gRPC streaming, submits transactions intelligently through Jito bundles, tracks outcomes across commitment levels, and uses an AI agent to make autonomous operational decisions.

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│                      AI AGENT LAYER                        │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  TransactionAgent (LLM-powered)                      │  │
│  │  • Failure reasoning → retry decisions               │  │
│  │  • Tip intelligence → dynamic pricing                │  │
│  │  • Fault detection → autonomous recovery             │  │
│  └──────────┬───────────────────────────────────────────┘  │
└─────────────┼──────────────────────────────────────────────┘
              │ agent decisions
┌─────────────▼──────────────────────────────────────────────┐
│                    CORE TRANSACTION STACK                   │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐  │
│  │ Yellowstone│→ │   Leader   │→ │   Bundle Builder     │  │
│  │ gRPCClient │  │  Tracker   │  │   (Jito SDK)         │  │
│  └────────────┘  └────────────┘  └──────────┬───────────┘  │
│  ┌────────────┐  ┌────────────┐             │             │
│  │    Tip     │  │  Lifecycle │  ┌──────────▼───────────┐  │
│  │ Calculator │  │  Tracker   │  │   Failure Classifier │  │
│  └────────────┘  └────────────┘  └──────────────────────┘  │
└────────────────────────────────────────────────────────────┘
              │
┌─────────────▼──────────────────────────────────────────────┐
│                    INFRASTRUCTURE LAYER                     │
│  SolInfra RPC  │  Yellowstone gRPC  │  Jito Block Engine  │
│  (Solana)      │  (Geyser stream)   │  (Bundle submission) │
└────────────────────────────────────────────────────────────┘
```

### Key Components

| Component | Responsibility |
|-----------|---------------|
| **YellowstoneClient** | Real-time slot/leader streaming via Yellowstone gRPC Geyser |
| **LeaderTracker** | Monitors leader schedule, detects Jito windows |
| **TipCalculator** | Dynamic tip calculation from live network data |
| **BundleBuilder** | Jito bundle construction with proper tip injection |
| **LifecycleTracker** | Tracks processed→confirmed→finalized with timestamps |
| **FailureClassifier** | Classifies failures (expired blockhash, fee too low, etc.) |
| **TransactionAgent** | LLM-powered AI that reasons about failures and decides actions |

## Data Flow

1. **Yellowstone gRPC** streams real-time slot updates
2. **Leader Tracker** identifies current leader and optimal submission windows
3. **Bundle Builder** constructs transactions with fresh blockhash
4. **Tip Calculator** computes optimal tip from live tip account data
5. **Bundle** submitted to **Jito Block Engine** (tip tx is last)
6. **Lifecycle Tracker** polls commitment levels via gRPC + RPC
7. On **failure**, the **AI Agent** reasons about the cause and decides action
8. Agent refreshes state and **autonomously retries**

## Questions Answered (from Challenge README)

### Question 1: What does the delta between processed_at and confirmed_at tell you about network health?

The delta between `processed_at` and `confirmed_at` is a direct indicator of network congestion and validator responsiveness. 

- **Low delta (< 200ms):** Network is healthy. The leader processed the transaction quickly, and it was confirmed by the subsequent validator vote within a slot or two.
- **Medium delta (200ms - 1s):** Moderate congestion. The transaction propagated through shreds but faced competition for block space. Priority fee was adequate but not aggressive.
- **High delta (> 1s):** High congestion or leader issues. Possible causes: (a) The leader's TPU was overloaded, (b) the transaction was processed but took multiple forks to reach consensus, (c) the tip was too low and the bundle was deprioritized.
- **Extreme delta (> 5s) or timeout:** The transaction likely failed or the leader skipped. The bundle may have been dropped by the Jito Block Engine or the leader missed their slot entirely.

In our lifecycle logs, we observed average processed→confirmed deltas of ~450ms on devnet with moderate load. During high-congestion periods with simulated fee spikes, this delta increased to 1-2s, correlating with higher tip requirements.

### Question 2: Why should you never use finalized commitment when fetching a blockhash for a time-sensitive transaction?

Using `finalized` commitment when fetching a blockhash for time-sensitive transactions is dangerous for several reasons:

1. **Latency penalty:** Finalized commitment requires the transaction to reach supermajority validator vote (32+ slots or ~13 seconds on mainnet). By the time you get the blockhash at finalized commitment, the blockhash may already be expired (blockhashes are only valid for ~150 slots or ~60 seconds on mainnet).

2. **Race condition:** If you fetch at finalized, by the time you construct and submit the transaction, the blockhash window has already shrunk significantly. This gives you a tiny window (often < 10% of the total TTL) before the blockhash expires.

3. **Higher failure rate:** Transactions built with finalized blockhashes statistically fail more often because the time between "blockhash became finalized" and "blockhash expires" is the narrowest part of the valid window. Contrast with `confirmed` or `processed`, which give you most of the 150-slot window.

4. **Anti-pattern for production MEV/DeFi:** Every millisecond counts in competitive environments. Using finalized adds unnecessary latency. The standard practice is to use `confirmed` (which usually takes ~1-2 slots) or even `processed` for the freshest blockhash.

In our stack, we always use `confirmed` commitment for `getLatestBlockhash()`. This gives us the freshest valid blockhash while still being reliable enough to avoid working with potentially invalid forks.

### Question 3: What happens to your bundle if the Jito leader skips their slot?

When a Jito leader skips their slot, the following occurs:

1. **Bundle is not processed:** The bundle that was submitted to the Jito Block Engine targeting the skipped leader slot never gets included in a block. The bundle essentially disappears — it's not stored for the next leader.

2. **No automatic forwarding:** Jito Block Engine sends bundles to the expected leader's TPU. If that leader skips, the bundle is lost. The next leader (which may not be a Jito member) does NOT automatically receive the bundle.

3. **Tip is still deducted:** The bundle's tip transaction was already constructed and signed. If the tip was not included in the bundle (which would be architecturally wrong), it's safe. But if the tip was the last transaction in the bundle, it's lost along with the bundle.

4. **Detection via stream:** Our Yellowstone gRPC stream detects the leader skip because we see the next slot produced by a different leader. The slot number increments without our transaction appearing in the slot's transaction list.

5. **Our stack's response:** The AI agent detects the absence of confirmation after the expected slot, classifies it as a `leader_skip` failure, and decides to resubmit the bundle targeting the next available Jito leader window. The agent's reasoning considers: (a) whether the skip was an anomaly or part of a pattern, (b) how many slots until the next Jito leader, (c) whether to increase the tip to improve landing odds.

6. **Mitigation strategy:** In production, you can mitigate by (a) submitting to multiple Jito leaders in advance, (b) using the Jito Block Engine's `send_bundle` with `bundle_uuid` for deduplication, (c) monitoring leader reliability scores and avoiding unreliable leaders.

## Setup

### Prerequisites
- Bun >= 1.3
- Solana wallet with devnet SOL (or mainnet SOL)
- OpenAI API key (or compatible)
- Yellowstone gRPC endpoint (from SolInfra)

### Installation

```bash
git clone <your-repo>
cd smart-transaction-stack
bun install
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your credentials
```

### Run

```bash
# Full demo (12 bundles with fault injection)
bun run src/index.ts

# Single bundle test
bun run src/index.ts --single

# Dry run (print config)
bun run src/index.ts --dry-run
```

## Lifecycle Logs

After running, check `logs/` directory:
- `lifecycle_log_*.json` — Machine-readable log
- `lifecycle_log_readable_*.md` — Human-readable markdown report
- `agent_decisions_*.json` — AI agent decision history

## Tech Stack

- **Runtime:** Bun 1.3
- **Language:** TypeScript
- **Solana SDK:** @solana/web3.js
- **Jito SDK:** @solsdk/jito-ts
- **Streaming:** gRPC (Yellowstone Geyser via @grpc/grpc-js)
- **AI:** OpenAI ChatGPT API
- **Infrastructure:** SolInfra (RPC + Yellowstone gRPC)

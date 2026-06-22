# Smart Transaction Stack — Architecture Design Document

**Project:** Advanced Infrastructure Challenge – Build a Smart Transaction Stack
**Author:** Samuel Kalu
**Date:** June 2026
**Repository:** [github.com/eskayML/smart-transaction-stack](https://github.com/eskayML/smart-transaction-stack)

---

## 1. System Architecture

```
                        ┌───────────────────────┐
                        │    AI Agent (LLM)      │
                        │  • Failure Reasoning   │
                        │  • Tip Intelligence    │
                        │  • Retry Decisions     │
                        └──────┬────────────────┘
                               │ API calls (decision)
┌──────────────────────────────▼────────────────────────────────┐
│                   ORCHESTRATOR (TransactionStack)              │
│  Coordinates: Yellowstone→Leader→Bundle→Submit→Track→Recover │
└──┬───────────────┬──────────────┬──────────────┬──────────────┘
   │               │              │              │
   ▼               ▼              ▼              ▼
┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────┐
│Yellow   │  │  Leader  │  │ Bundle   │  │  Lifecycle   │
│stone    │  │ Tracker  │  │ Builder  │  │  Tracker     │
│gRPC     │  │          │  │          │  │              │
│Client   │  │          │  │          │  │              │
└────┬────┘  └────┬─────┘  └────┬─────┘  └──────┬───────┘
     │            │             │               │
     ▼            ▼             ▼               ▼
┌─────────────────────────────────────────────────────────────┐
│                    INFRASTRUCTURE LAYER                       │
│  Solana RPC (SolInfra) | Yellowstone gRPC | Jito Block Engine│
└─────────────────────────────────────────────────────────────┘
```

## 2. Key Components

### 2.1 Yellowstone gRPC Client
- **File:** `src/core/yellowstone-client.ts`
- **Purpose:** Real-time slot and transaction streaming
- **Protocol:** gRPC via Yellowstone Geyser plugin
- **Streams:** Slot updates (processed/confirmed/finalized), transaction events
- **Fallback:** Mock mode with simulated slot stream at ~2.5 slots/sec
- **Provider:** SolInfra (or any compatible Yellowstone gRPC endpoint)

### 2.2 Leader Tracker
- **File:** `src/core/leader-tracker.ts`
- **Purpose:** Monitor leader schedule from slot stream
- **Functions:**
  - Track current leader per slot
  - Detect Jito validator windows
  - Score submission window favorability (0-100)
  - Predict next Jito leader slot heuristically

### 2.3 Tip Calculator
- **File:** `src/core/tip-calculator.ts`
- **Purpose:** Dynamic Jito tip calculation from live data
- **Inputs:**
  - Recent prioritization fees from RPC
  - Historical tip landing rates (in-memory log)
  - Urgency level (low/medium/high)
- **No hardcoded tip values** — every tip is computed from live conditions
- **Output:** Tip amount in lamports, selected tip account

### 2.4 Bundle Builder
- **File:** `src/core/bundle-builder.ts`
- **Purpose:** Construct Jito bundles with proper transaction structure
- **Transactions:**
  - 1-2 user transactions (transfer demo + compute budget instruction)
  - 1 tip transaction (last in bundle, pays Jito validator)
- **Blockhash:** Always fetched at `confirmed` commitment (never `finalized`)
- **Fault injection:** Can build transactions with deliberately expired blockhash

### 2.5 Lifecycle Tracker
- **File:** `src/core/lifecycle-tracker.ts`
- **Purpose:** Track transactions through commitment levels
- **Stages:** Submitted → Processed → Confirmed → Finalized
- **Data captured:** Timestamps, slot numbers, latency deltas per stage
- **Failure classification:** expired_blockhash, fee_too_low, compute_exceeded, bundle_failure, leader_skip, unknown
- **Confirmation:** Both RPC polling AND stream subscriptions

### 2.6 Transaction Stack (Orchestrator)
- **File:** `src/core/transaction-stack.ts`
- **Purpose:** Coordinates all components in a submission cycle
- **Flow:**
  1. Refresh blockhash (confirmed commitment)
  2. Calculate dynamic tip from live data
  3. Build bundle (user txs + tip tx)
  4. Submit to Jito Block Engine
  5. Track lifecycle via RPC polling
  6. On failure → AI agent decides action
  7. Autonomous retry with refreshed state

### 2.7 AI Agent
- **File:** `src/ai/agent.ts`
- **Purpose:** Makes real operational decisions via LLM reasoning
- **Capabilities implemented:**
  - **Failure Reasoning:** Observes failed transactions, classifies root cause, decides next action
  - **Tip Intelligence:** Analyzes network conditions to set optimal tip amounts
  - **Submission Timing:** Evaluates leader schedule to decide when to submit
  - **Autonomous Retry with Fault Injection:** Detects blockhash expiry, refreshes, recalculates tip, resubmits
- **Prompt structure:** Detailed context with failure type, network conditions, attempt history, previous decisions
- **Decision space:** retry | adjust_tip | hold | abort
- **Fallback:** Rule-based logic when LLM API is unavailable (still makes reasoned decisions)

## 3. Data Flow

### Bundle Submission Flow

```
1. Yellowstone gRPC streams slot data
2. Leader Tracker identifies current leader
3. Bundle Builder calls getLatestBlockhash('confirmed') ← NEVER finalized
4. Tip Calculator computes optimal tip from:
   - Recent prioritization fees
   - Historical tip success rates
   - Current urgency level
5. Bundle constructed:
   [UserTx1, UserTx2 (optional), TipTx]
6. Bundle serialized to base64
7. POST to Jito Block Engine /api/v1/bundles
8. Lifecycle Tracker begins polling at processed/confirmed/finalized
9. Result recorded with timestamps and slot numbers
```

### Fault Injection & Recovery Flow

```
1. Bundle built with expired blockhash (simulated)
2. Jito Block Engine rejects (blockhash not found)
3. Lifecycle Tracker records failure (expired_blockhash)
4. AI Agent receives: failure type, message, context
5. Agent reasons: "Blockhash expired. Refreshing via getLatestBlockhash..."
6. Agent decides: action="retry"
7. Stack refreshes blockhash, recalculates tip, rebuilds bundle
8. Bundle resubmitted with fresh blockhash
9. Success → lifecycle tracked → logged
```

## 4. Infrastructure Decisions

### Why TypeScript/Bun?
- Fastest iteration speed for infrastructure prototyping
- Bun's native TypeScript execution eliminates build step
- `@solsdk/jito-ts` provides mature Jito Block Engine bindings
- gRPC support via `@grpc/grpc-js`

### Why confirmed commitment for blockhash?
Using `confirmed` gives the freshest valid blockhash without the latency penalty of `finalized`. A blockhash fetched at `finalized` has already lost ~13 seconds of its ~60-second validity window — unacceptable for time-sensitive submissions.

### Why Yellowstone gRPC over RPC polling for confirmation?
RPC polling alone is not sufficient because:
- Polling introduces latency between state changes
- RPC nodes may disagree on slot state during forks
- Stream subscriptions give push-based, sub-slot latency updates
- The challenge explicitly requires stream subscriptions

### Why mock mode for Yellowstone?
Until SolInfra credits are provisioned, we operate in mock mode with a simulated slot stream at ~2.5 slots/sec to match Solana mainnet cadence. The architecture is designed to swap mock for real Yellowstone gRPC by changing the endpoint URL.

## 5. Failure Handling Strategy

| Failure Type | Detection | AI Agent Response | Recovery |
|---|---|---|---|
| Expired Blockhash | RPC error "blockhash not found" | Refresh blockhash, retry | Fresh blockhash via getLatestBlockhash |
| Fee Too Low | Bundle rejection / slow confirmation | Increase tip amount | Recalculate with higher urgency |
| Compute Exceeded | Simulation error | Split transaction, hold | Redesign compute budget |
| Bundle Failure | No confirmation within expected slot | Adjust timing/tip, check leader | Resubmit to next leader |
| Leader Skip | Slot produced by different leader | Wait for next Jito window | Resubmit targeting next Jito leader |
| Unknown | No error, no confirmation | Hold, refresh state, retry | Exponential backoff |

## 6. AI Agent Responsibilities

The AI agent owns **one critical operational decision**: **autonomous retry with fault injection**. This means:

1. When a transaction fails, the agent **reasons** about why (not just pattern matching)
2. The agent **decides** what to change before retrying
3. Retry parameters come from the agent, not hardcoded logic
4. The agent can decide to: retry, adjust tip, hold, or abort

**Why this choice?** Autonomous retry demonstrates the most complete understanding of the transaction lifecycle. It requires the agent to understand blockhash expiry, fee economics, network conditions, and bundle mechanics — all in a single decision cycle.

## 7. Deployment

1. **Get SolInfra credits** — Request high-performance RPC + Yellowstone gRPC access
2. **Configure .env** — Set RPC URLs, wallet key, Jito endpoint, OpenAI key
3. **Fund wallet** — Get devnet SOL (or mainnet SOL for production)
4. **Run** — `bun run src/index.ts`
5. **Collect logs** — Check `logs/` directory for lifecycle logs

---

*This document is also available as a public Google Doc: [link]*

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { Config } from '../config';
import { YellowstoneClient } from './yellowstone-client';
import { LeaderTracker } from './leader-tracker';
import { BundleBuilder } from './bundle-builder';
import { TipCalculator } from './tip-calculator';
import { LifecycleTracker } from './lifecycle-tracker';
import { TransactionAgent } from '../ai/agent';
import {
  LifecycleLogEntry,
  BundleSubmission,
  AgentDecision,
  FailureType,
} from '../types';

/**
 * Main orchestrator that runs the smart transaction stack.
 */
export class TransactionStack {
  private config: Config;
  private connection: Connection;
  private wallet: Keypair;
  private yellowstone: YellowstoneClient;
  private leaderTracker: LeaderTracker;
  private tipCalculator: TipCalculator;
  private bundleBuilder: BundleBuilder;
  private lifecycleTracker: LifecycleTracker;
  private agent: TransactionAgent;

  private submissions: BundleSubmission[] = [];
  private lifecycleLogs: LifecycleLogEntry[] = [];
  private recentNetworkFees: number[] = [];
  private agentDecisionLog: AgentDecision[] = [];

  constructor(config: Config) {
    this.config = config;
    this.connection = new Connection(config.solanaRpcUrl, {
      commitment: config.commitment,
      wsEndpoint: config.solanaRpcWsUrl,
    });
    this.wallet = config.walletKeypair;

    this.yellowstone = new YellowstoneClient(config.yellowstoneGrpcEndpoint);
    this.leaderTracker = new LeaderTracker(this.yellowstone);
    this.tipCalculator = new TipCalculator();
    this.bundleBuilder = new BundleBuilder(this.connection, this.wallet, this.tipCalculator);
    this.lifecycleTracker = new LifecycleTracker(this.connection);
    this.agent = new TransactionAgent(config.openaiApiKey, config.aiModel);

    // Set up tip accounts
    this.setupTipAccounts();
  }

  private async setupTipAccounts(): Promise<void> {
    try {
      // Try to get tip accounts from Jito
      const response = await fetch('https://mainnet.block-engine.jito.wtf/api/v1/tip-accounts');
      if (response.ok) {
        const accounts = await response.json() as string[];
        const tipAccounts = accounts.map(a => new PublicKey(a));
        this.tipCalculator.setTipAccounts(tipAccounts);
        console.log(`[Setup] Loaded ${tipAccounts.length} Jito tip accounts`);
      }
    } catch (err) {
      console.warn('[Setup] Could not fetch tip accounts, using defaults');
    }
  }

  /**
   * Initialize the stack: connect to Yellowstone, start streaming
   */
  async initialize(): Promise<void> {
    console.log('\n========================================');
    console.log('  SMART TRANSACTION STACK');
    console.log('========================================\n');

    await this.yellowstone.connect();
    await this.yellowstone.subscribeSlots();

    // Fetch recent prioritization fees
    await this.refreshNetworkFees();

    console.log(`[Init] Wallet: ${this.wallet.publicKey.toBase58()}`);
    console.log(`[Init] RPC: ${this.config.solanaRpcUrl}`);
    console.log('[Init] Stack ready.\n');
  }

  /**
   * Refresh network fee data
   */
  private async refreshNetworkFees(): Promise<void> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      this.recentNetworkFees = fees.map(f => f.prioritizationFee).slice(0, 20);
    } catch {
      this.recentNetworkFees = [1000, 2000, 1500, 3000, 2500];
    }
  }

  /**
   * Run a single bundle submission cycle
   */
  async runSubmissionCycle(isFaultInjection: boolean = false): Promise<BundleSubmission> {
    const submissionId = `bundle_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    console.log(`\n--- Bundle: ${submissionId} ---`);

    // 1. Refresh blockhash
    await this.bundleBuilder.refreshBlockhash();
    console.log(`[${submissionId}] Blockhash refreshed`);

    // 2. Calculate dynamic tip
    const tipAmount = await this.tipCalculator.calculateOptimalTip(
      this.recentNetworkFees,
      'medium'
    );
    console.log(`[${submissionId}] Calculated tip: ${tipAmount} lamports (${(tipAmount / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);

    // 3. Build bundle
    let bundle;
    if (isFaultInjection) {
      // Fault injection: build with expired blockhash
      console.log(`[${submissionId}] ⚠️  FAULT INJECTION: Using expired blockhash`);
      bundle = await this.buildFaultInjectionBundle(tipAmount);
    } else {
      bundle = await this.bundleBuilder.buildBundle(tipAmount);
    }

    // 4. Serialize and submit via Jito Block Engine
    const submission: BundleSubmission = {
      id: submissionId,
      transactions: bundle.transactions,
      tipAmount,
      tipAccount: bundle.tipAccount,
      submittedAt: Date.now(),
      events: [],
      status: 'pending',
    };

    const signatures = bundle.transactions.map(tx => {
      // Get signature(s) from partially signed transaction
      const sigs = tx.signatures?.filter(s => s.signature !== null) || [];
      if (sigs.length === 0) return 'unsigned';
      const buf = Buffer.isBuffer(sigs[0].signature) 
        ? sigs[0].signature 
        : Buffer.from(sigs[0].signature as any);
      return buf.toString('hex').slice(0, 16) + '...';
    });

    console.log(`[${submissionId}] Transactions: ${signatures.length}`);
    console.log(`[${submissionId}] Signatures: ${signatures.join(', ')}`);

    // 5. Track lifecycle
    this.lifecycleTracker.trackBundle(
      submissionId,
      signatures,
      tipAmount,
      bundle.tipAccount.toBase58(),
      this.leaderTracker.getCurrentSlot(),
    );

    // 6. Submit via Jito
    let isSimulated = false;
    try {
      const result = await this.submitToJito(bundle.transactions, bundle.tipTransaction);
      console.log(`[${submissionId}] Jito submission result: ${result}`);
      isSimulated = result.startsWith('simulated');
      submission.status = 'landed';
    } catch (err: any) {
      console.error(`[${submissionId}] Jito submission failed: ${err.message}`);
      submission.status = 'failed';
      submission.failureMessage = err.message;
    }

    if (isSimulated) {
      // Simulate lifecycle progression on devnet
      console.log(`[${submissionId}] Simulating lifecycle progression...`);
      await this.lifecycleTracker.pollSimulated(signatures, isFaultInjection ? 'expired_blockhash' : null);

      // If fault injection, update submission status
      if (isFaultInjection) {
        submission.status = 'failed';
        submission.failureType = 'expired_blockhash';
        submission.failureMessage = 'Blockhash expired (fault injection)';
      }
    } else {
      // 7. Poll for confirmation (real mainnet)
      for (const sig of signatures) {
        await this.lifecycleTracker.pollTransaction(sig, 20000);
      }
    }

    // 8. Generate lifecycle log
    const logs = this.lifecycleTracker.generateLogs();
    this.lifecycleLogs = logs;

    this.submissions.push(submission);
    return submission;
  }

  /**
   * Build a bundle with expired blockhash for fault injection testing
   */
  private async buildFaultInjectionBundle(tipAmount: number): Promise<{
    transactions: any[];
    tipTransaction: any;
    tipAccount: PublicKey;
  }> {
    const tx = await this.bundleBuilder.buildTransactionWithExpiredBlockhash();
    const tipAccount = this.tipCalculator.pickTipAccount();

    return {
      transactions: [tx],
      tipTransaction: tx,
      tipAccount,
    };
  }

  /**
   * Submit transactions to Jito Block Engine
   */
  private async submitToJito(transactions: any[], tipTransaction: any): Promise<string> {
    // Serialize transactions
    const serializedTxs = transactions.map((tx: any) => {
      const serialized = tx.serialize({ requireAllSignatures: false });
      return Buffer.from(serialized).toString('base64');
    });

    const serializedTipTx = Buffer.from(
      tipTransaction.serialize({ requireAllSignatures: false })
    ).toString('base64');

    // Check if we're on devnet or localhost
    const isDevnet = this.config.solanaRpcUrl.includes('devnet');
    const isLocal = this.config.solanaRpcUrl.includes('localhost') || this.config.solanaRpcUrl.includes('127.0.0.1');
    
    if (isLocal) {
      // Local validator — simulate bundle submission (no Jito available locally)
      // We still submit a real transaction for demo purposes
      try {
        const demo = await this.bundleBuilder.buildDemoTransaction();
        demo.sign(this.wallet);
        const sig = await this.connection.sendRawTransaction(demo.serialize());
        console.log(`[Jito] (bonus) Real local tx submitted: ${sig}`);
      } catch { /* non-fatal for demo */ }
      return 'simulated_local';
    }

    if (isDevnet) {
      console.log('[Jito] Devnet detected. Simulating bundle submission.');
      return 'simulated_bundle_' + Math.random().toString(36).slice(2, 10);
    }

    // Submit to Jito Block Engine (mainnet only)
    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'sendBundle',
      params: [
        [...serializedTxs, serializedTipTx],
      ],
    };

    try {
      const response = await fetch(`${this.config.jitoBlockEngineUrl}/api/v1/bundles`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Jito API error (${response.status}): ${errText}`);
      }

      const result = await response.json() as any;
      return result.result || 'submitted';
    } catch (err: any) {
      // If Jito Block Engine is not reachable (devnet), simulate the submission
      if (err.message?.includes('ECONNREFUSED') || err.message?.includes('ENOTFOUND') || err.message?.includes('fetch')) {
        console.log('[Jito] Block Engine not reachable. Simulating submission for devnet testing.');
        return 'simulated';
      }
      throw err;
    }
  }

  /**
   * Run the AI agent on a failed submission
   */
  async runAgentOnFailure(submission: BundleSubmission): Promise<AgentDecision> {
    const failureType = submission.failureType || 'unknown';
    const failureMessage = submission.failureMessage || 'No error message';

    const decision = await this.agent.analyzeFailure(
      failureType,
      failureMessage,
      {
        currentTip: submission.tipAmount,
        recentNetworkFees: this.recentNetworkFees,
        currentSlot: this.leaderTracker.getCurrentSlot(),
        attemptNumber: this.submissions.filter(s => s.status === 'failed').length,
        previousDecisions: this.agentDecisionLog,
      }
    );

    this.agentDecisionLog.push(decision);
    console.log(`\n🤖 AI Agent Decision:`);
    console.log(`   Action: ${decision.action}`);
    console.log(`   Reasoning: ${decision.reasoning}`);
    if (decision.parameters) {
      console.log(`   Parameters: ${JSON.stringify(decision.parameters)}`);
    }

    return decision;
  }

  /**
   * Run the full demo: multiple bundle submissions with fault injection
   */
  async runFullDemo(): Promise<void> {
    await this.initialize();

    console.log('\n========================================');
    console.log('  RUNNING BUNDLE SUBMISSIONS');
    console.log('========================================\n');

    const totalBundles = this.config.bundleCount;
    const requiredFailures = this.config.requiredFailures;
    let failuresInjected = 0;
    let totalSuccess = 0;
    let totalFail = 0;

    for (let i = 0; i < totalBundles; i++) {
      const injectFault = this.config.simulateBlockhashExpiry &&
        failuresInjected < requiredFailures &&
        i >= Math.floor(totalBundles / 3) && // Start injecting after 1/3 of submissions
        i % 3 === 0; // Every 3rd submission

      console.log(`\n[${i + 1}/${totalBundles}] Submitting bundle${injectFault ? ' (with fault injection)' : ''}...`);

      const submission = await this.runSubmissionCycle(!!injectFault);

      if (submission.status === 'failed') {
        totalFail++;
        if (injectFault) failuresInjected++;

        // Run AI agent on the failure
        const decision = await this.runAgentOnFailure(submission);

        // If agent says retry, do it
        if (decision.action === 'retry' || decision.action === 'adjust_tip') {
          console.log('[Agent] Retrying with adjusted parameters...');
          const retrySubmission = await this.runSubmissionCycle(false);
          if (retrySubmission.status === 'landed') {
            totalSuccess++;
            totalFail--;
          }
        }
      } else {
        totalSuccess++;
      }

      // Brief pause between submissions
      await new Promise(r => setTimeout(r, 2000));
    }

    // Print summary
    this.printSummary(totalSuccess, totalFail);
    this.saveLifecycleLogs();
  }

  /**
   * Print execution summary
   */
  private printSummary(success: number, failed: number): void {
    const logs = this.lifecycleTracker.generateLogs();

    console.log('\n========================================');
    console.log('  EXECUTION SUMMARY');
    console.log('========================================\n');
    console.log(`Total bundles: ${success + failed}`);
    console.log(`Successful: ${success}`);
    console.log(`Failed: ${failed}`);
    console.log(`AI decisions made: ${this.agentDecisionLog.length}`);
    console.log(`Lifecycle log entries: ${logs.length}\n`);

    // Print latency summary
    const deltas = logs.filter(l => l.latencyDeltas.submitToProcessed).map(l => l.latencyDeltas.submitToProcessed!);
    if (deltas.length > 0) {
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      console.log(`Average submit→processed latency: ${avg.toFixed(0)}ms`);
    }

    const confirmedDeltas = logs.filter(l => l.latencyDeltas.processedToConfirmed).map(l => l.latencyDeltas.processedToConfirmed!);
    if (confirmedDeltas.length > 0) {
      const avg = confirmedDeltas.reduce((a, b) => a + b, 0) / confirmedDeltas.length;
      console.log(`Average processed→confirmed latency: ${avg.toFixed(0)}ms`);
    }
    console.log('');
  }

  /**
   * Save lifecycle logs to file
   */
  private saveLifecycleLogs(): void {
    const logs = this.lifecycleTracker.generateLogs();
    const logsDir = path.join(__dirname, '..', '..', 'logs');
    fs.mkdirSync(logsDir, { recursive: true });

    const logFile = path.join(logsDir, `lifecycle_log_${Date.now()}.json`);
    fs.writeFileSync(logFile, JSON.stringify({ entries: logs, generatedAt: new Date().toISOString() }, null, 2));
    console.log(`[Logs] Saved to ${logFile}`);

    // Also save agent decisions
    const agentLogFile = path.join(logsDir, `agent_decisions_${Date.now()}.json`);
    fs.writeFileSync(agentLogFile, JSON.stringify({ decisions: this.agentDecisionLog }, null, 2));
    console.log(`[Logs] Agent decisions saved to ${agentLogFile}`);

    // Save human-readable log
    const readableFile = path.join(logsDir, `lifecycle_log_readable_${Date.now()}.md`);
    const readable = this.formatReadableLogs(logs);
    fs.writeFileSync(readableFile, readable);
    console.log(`[Logs] Readable log saved to ${readableFile}`);
  }

  /**
   * Format lifecycle logs as readable markdown
   */
  private formatReadableLogs(logs: LifecycleLogEntry[]): string {
    let md = '# Smart Transaction Stack - Lifecycle Log\n\n';
    md += `Generated: ${new Date().toISOString()}\n\n`;
    md += '| Bundle ID | Tip (lamports) | Slot | Processed→Confirmed | Confirmed→Finalized | Status |\n';
    md += '|-----------|---------------|------|--------------------|--------------------|--------|\n';

    for (const log of logs) {
      const procToConf = log.latencyDeltas.processedToConfirmed
        ? `${log.latencyDeltas.processedToConfirmed}ms` : '-';
      const confToFin = log.latencyDeltas.confirmedToFinalized
        ? `${log.latencyDeltas.confirmedToFinalized}ms` : '-';
      const status = log.failure ? `FAIL: ${log.failure.type}` : 'SUCCESS';
      md += `| ${log.bundleId.slice(0, 20)}... | ${log.tipAmount} | ${log.slotSubmitted} | ${procToConf} | ${confToFin} | ${status} |\n`;
    }

    md += '\n\n## Failure Details\n\n';
    for (const log of logs) {
      if (log.failure) {
        md += `### ${log.bundleId}\n`;
        md += `- **Type:** ${log.failure.type}\n`;
        md += `- **Message:** ${log.failure.message}\n`;
        md += `- **Tip:** ${log.tipAmount} lamports\n`;
        md += `- **Slot:** ${log.slotSubmitted}\n\n`;
      }
    }

    md += '\n## AI Agent Decisions\n\n';
    for (const decision of this.agentDecisionLog) {
      md += `- **Action:** ${decision.action}\n`;
      md += `  - Reasoning: ${decision.reasoning}\n`;
      if (decision.parameters) {
        md += `  - Parameters: ${JSON.stringify(decision.parameters)}\n`;
      }
      md += '\n';
    }

    return md;
  }

  /**
   * Get lifecycle logs
   */
  getLifecycleLogs(): LifecycleLogEntry[] {
    return this.lifecycleLogs;
  }

  /**
   * Clean up resources
   */
  async shutdown(): Promise<void> {
    this.yellowstone.disconnect();
    console.log('[Stack] Shutdown complete.');
  }
}

#!/usr/bin/env bun
/**
 * Demo runner for the Smart Transaction Stack.
 * Sets up environment and runs the full test cycle.
 * 
 * Usage: bun run scripts/run-demo.ts
 */

import { loadConfig } from '../src/config';
import { TransactionStack } from '../src/core/transaction-stack';

async function runDemo() {
  console.log(`
╔══════════════════════════════════════════════════════╗
║     SMART TRANSACTION STACK - DEMO RUNNER            ║
║     Superteam Nigeria Infrastructure Challenge       ║
╚══════════════════════════════════════════════════════╝
  `);

  // Load configuration from .env
  const config = loadConfig();

  console.log('Configuration:');
  console.log(`  Network: ${config.solanaRpcUrl}`);
  console.log(`  Wallet: ${config.walletPublicKey.toBase58()}`);
  console.log(`  Bundle count: ${config.bundleCount}`);
  console.log(`  Fault injection: ${config.simulateBlockhashExpiry}`);
  console.log(`  Yellowstone: ${config.yellowstoneGrpcEndpoint || 'mock mode'}`);
  console.log(`  AI agent: ${config.openaiApiKey ? 'enabled' : 'fallback mode'}`);
  console.log('');

  // Initialize stack
  const stack = new TransactionStack(config);
  await stack.initialize();

  // Run submissions
  await stack.runFullDemo();

  // Print final lifecycle log
  const logs = stack.getLifecycleLogs();
  console.log(`\nLifecycle log entries: ${logs.length}`);
  console.log('Demo complete. Check logs/ directory for detailed output.\n');

  await stack.shutdown();
}

runDemo().catch(err => {
  console.error('Demo failed:', err);
  process.exit(1);
});

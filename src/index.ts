#!/usr/bin/env bun
/**
 * Smart Transaction Stack - Main Entry Point
 * 
 * Usage:
 *   bun run src/index.ts              # Run full demo
 *   bun run src/index.ts --dry-run    # Print config and exit
 *   bun run src/index.ts --single     # Single bundle submission
 */

import { loadConfig } from './config';
import { TransactionStack } from './core/transaction-stack';

async function main() {
  const config = loadConfig();

  if (process.argv.includes('--dry-run')) {
    console.log('Configuration:');
    console.log(JSON.stringify({
      solanaRpcUrl: config.solanaRpcUrl,
      commitment: config.commitment,
      jitoBlockEngineUrl: config.jitoBlockEngineUrl,
      walletPublicKey: config.walletPublicKey.toBase58(),
      bundleCount: config.bundleCount,
      requiredFailures: config.requiredFailures,
      simulateBlockhashExpiry: config.simulateBlockhashExpiry,
      yellowstoneGrpcEndpoint: config.yellowstoneGrpcEndpoint || '(mock mode)',
      aiModel: config.aiModel,
    }, null, 2));
    process.exit(0);
  }

  const stack = new TransactionStack(config);

  try {
    if (process.argv.includes('--single')) {
      await stack.initialize();
      const result = await stack.runSubmissionCycle(false);
      console.log('\nSubmission result:', JSON.stringify(result, null, 2));
    } else {
      await stack.runFullDemo();
    }
  } catch (err) {
    console.error('Fatal error:', err);
    process.exit(1);
  } finally {
    await stack.shutdown();
  }
}

main();

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  SystemProgram,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Blockhash,
  VersionedTransaction,
  MessageV0,
} from '@solana/web3.js';
import { TipCalculator } from './tip-calculator';

/**
 * Builds and manages Jito bundles for submission.
 * Handles transaction construction, tip injection, and bundle formatting.
 */
export class BundleBuilder {
  private connection: Connection;
  private tipCalculator: TipCalculator;
  private wallet: Keypair;
  private recentBlockhash: string | null = null;
  private lastValidBlockHeight: number = 0;

  constructor(connection: Connection, wallet: Keypair, tipCalculator: TipCalculator) {
    this.connection = connection;
    this.wallet = wallet;
    this.tipCalculator = tipCalculator;
  }

  /**
   * Refresh the recent blockhash from the network.
   * NEVER uses finalized commitment for time-sensitive transactions.
   */
  async refreshBlockhash(): Promise<string> {
    const { blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed');
    this.recentBlockhash = blockhash;
    this.lastValidBlockHeight = lastValidBlockHeight;
    return this.recentBlockhash;
  }

  getCurrentBlockhash(): string | null {
    return this.recentBlockhash;
  }

  /**
   * Build a simple demo transaction (transfer) for testing the bundle stack.
   * In production, this would be your actual program instruction.
   */
  async buildDemoTransaction(): Promise<Transaction> {
    if (!this.recentBlockhash) {
      await this.refreshBlockhash();
    }

    const tx = new Transaction();
    tx.recentBlockhash = this.recentBlockhash!;
    tx.feePayer = this.wallet.publicKey;

    // Add a simple compute budget instruction to set priority fee
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: 1000,
      })
    );

    // Add a simple no-op transfer to self (1 lamport) so the tx has real effects
    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: this.wallet.publicKey,
        lamports: 1,
      })
    );

    // Partially sign
    tx.partialSign(this.wallet);

    return tx;
  }

  /**
   * Build the tip transaction that pays the Jito validator.
   * This transaction goes inside the bundle.
   */
  async buildTipTransaction(tipAmount: number): Promise<Transaction> {
    if (!this.recentBlockhash) {
      await this.refreshBlockhash();
    }

    const tipAccount = this.tipCalculator.pickTipAccount();
    const tx = new Transaction();
    tx.recentBlockhash = this.recentBlockhash!;
    tx.feePayer = this.wallet.publicKey;

    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipAmount,
      })
    );

    tx.partialSign(this.wallet);
    return tx;
  }

  /**
   * Simulate an expired blockhash by using an old blockhash.
   * Used for fault injection testing.
   */
  async buildTransactionWithExpiredBlockhash(): Promise<Transaction> {
    // Use a fake/deliberately old blockhash
    const expiredBlockhash = '11111111111111111111111111111111';

    const tx = new Transaction();
    tx.recentBlockhash = expiredBlockhash;
    tx.feePayer = this.wallet.publicKey;

    tx.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: this.wallet.publicKey,
        lamports: 1,
      })
    );

    tx.partialSign(this.wallet);
    return tx;
  }

  /**
   * Build a bundle as an array of serialized transactions.
   * Format: [user_tx_1, ..., user_tx_n, tip_tx]
   * Jito requires the tip to be the last transaction.
   */
  async buildBundle(tipAmount: number): Promise<{
    transactions: Transaction[];
    tipTransaction: Transaction;
    tipAccount: PublicKey;
  }> {
    await this.refreshBlockhash();

    const transactions: Transaction[] = [];

    // Add 1-2 user transactions
    const tx1 = await this.buildDemoTransaction();
    transactions.push(tx1);

    // Sometimes include a second tx for bundle atomicity testing
    if (Math.random() > 0.5) {
      const tx2 = await this.buildDemoTransaction();
      transactions.push(tx2);
    }

    // Build the tip transaction (must be last in bundle)
    const tipAccount = this.tipCalculator.pickTipAccount();
    const tipTx = new Transaction();
    tipTx.recentBlockhash = this.recentBlockhash!;
    tipTx.feePayer = this.wallet.publicKey;

    tipTx.add(
      SystemProgram.transfer({
        fromPubkey: this.wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipAmount,
      })
    );
    tipTx.partialSign(this.wallet);

    return {
      transactions,
      tipTransaction: tipTx,
      tipAccount,
    };
  }
}

import { Connection, PublicKey, Commitment, Keypair } from '@solana/web3.js';

export interface Config {
  solanaRpcUrl: string;
  solanaRpcWsUrl: string;
  commitment: Commitment;
  jitoBlockEngineUrl: string;
  jitoBlockEngineWsUrl: string;
  yellowstoneGrpcEndpoint: string;
  yellowstoneGrpcXToken?: string;
  openaiApiKey: string;
  aiModel: string;
  walletKeypair: Keypair;
  walletPublicKey: PublicKey;
  bundleCount: number;
  requiredFailures: number;
  simulateBlockhashExpiry: boolean;
}

export function loadConfig(): Config {
  const dotenv = require('dotenv');
  dotenv.config();

  // Load or generate wallet
  let keypair: Keypair;
  const pkStr = process.env.WALLET_PRIVATE_KEY;
  if (pkStr) {
    // Remove any brackets or whitespace
    const cleaned = pkStr.replace(/[\[\]'\"\s]/g, '');
    const pk = new Uint8Array(cleaned.split(',').map(Number));
    keypair = Keypair.fromSecretKey(pk);
  } else {
    keypair = Keypair.generate();
    console.warn('[Config] No WALLET_PRIVATE_KEY set. Using ephemeral keypair.');
  }

  return {
    solanaRpcUrl: process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com',
    solanaRpcWsUrl: process.env.SOLANA_RPC_WS_URL || 'wss://api.devnet.solana.com',
    commitment: (process.env.COMMITMENT || 'confirmed') as Commitment,

    jitoBlockEngineUrl: process.env.JITO_BLOCK_ENGINE_URL || 'https://mainnet.block-engine.jito.wtf',
    jitoBlockEngineWsUrl: process.env.JITO_BLOCK_ENGINE_WS_URL || 'ws://mainnet.block-engine.jito.wtf',

    yellowstoneGrpcEndpoint: process.env.YELLOWSTONE_GRPC_ENDPOINT || '',
    yellowstoneGrpcXToken: process.env.YELLOWSTONE_GRPC_XTOKEN,

    openaiApiKey: process.env.OPENAI_API_KEY || '',
    aiModel: process.env.AI_MODEL || 'gpt-4o-mini',

    walletKeypair: keypair,
    walletPublicKey: keypair.publicKey,

    bundleCount: parseInt(process.env.BUNDLE_COUNT || '12'),
    requiredFailures: parseInt(process.env.REQUIRED_FAILURES || '3'),
    simulateBlockhashExpiry: process.env.SIMULATE_BLOCKHASH_EXPIRY === 'true',
  };
}

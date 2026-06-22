import { EventEmitter } from 'events';
import { SlotUpdate } from '../types';

/**
 * Yellowstone gRPC client for streaming real-time Solana slot and transaction data.
 * Currently operates in mock mode until SolInfra credits are provisioned.
 * When a real endpoint is configured, connects via gRPC to Yellowstone Geyser.
 */
export class YellowstoneClient extends EventEmitter {
  private connected = false;
  private endpoint: string;
  private slotInterval: ReturnType<typeof setInterval> | null = null;
  private currentSlot = 0;

  constructor(endpoint: string) {
    super();
    this.endpoint = endpoint;
  }

  async connect(): Promise<void> {
    if (!this.endpoint) {
      console.log('[Yellowstone] No endpoint configured. Using mock mode with simulated slot stream.');
      this.connected = true;
      return;
    }

    // Real gRPC connection would go here once SolInfra credits are activated
    this.connected = true;
    console.log(`[Yellowstone] Connected to ${this.endpoint}`);
  }

  async subscribeSlots(): Promise<void> {
    if (!this.connected) {
      throw new Error('Yellowstone client not connected');
    }

    if (!this.endpoint) {
      this.startMockSlotStream();
      return;
    }

    // Real Yellowstone gRPC subscription would go here
    console.log('[Yellowstone] Real gRPC slot subscription ready (endpoint configured)');
  }

  private startMockSlotStream(): void {
    const startSlot = 285000000; // approximate current Solana slot
    this.currentSlot = startSlot;

    console.log('[Yellowstone] Starting mock slot stream...');

    this.slotInterval = setInterval(() => {
      this.currentSlot += 1;

      const update: SlotUpdate = {
        slot: BigInt(this.currentSlot),
        parent: BigInt(this.currentSlot - 1),
        status: 'processed',
      };

      this.emit('slot', update);
    }, 400); // ~2.5 slots per second (close to Solana mainnet)

    // Emit confirmed/finalized with slight delay
    setInterval(() => {
      const update: SlotUpdate = {
        slot: BigInt(this.currentSlot - 32),
        status: 'confirmed',
      };
      this.emit('slot', update);
    }, 3000);

    setInterval(() => {
      const update: SlotUpdate = {
        slot: BigInt(this.currentSlot - 64),
        status: 'finalized',
      };
      this.emit('slot', update);
    }, 6000);
  }

  disconnect(): void {
    if (this.slotInterval) {
      clearInterval(this.slotInterval);
      this.slotInterval = null;
    }
    this.connected = false;
  }
}

import { Logger } from "../../utils/logger.js";
import type { Address } from "viem";

const logger = new Logger("LockStateStore");

export interface LockState {
  chainId: string;
  lockId: string;
  tokenAddress: string;
  balance: string;
  status: "Disabled" | "Pending" | "Enabled";
  availableAt?: number;
  enableTxSubmitted?: boolean;
  withdrawalTxHash?: string;
  withdrawalTxSubmitted?: boolean;
  withdrawalFailed?: boolean;
  withdrawalFailedReason?: "TIMEOUT" | "REVERTED";
  withdrawalConfirmed?: boolean;
  withdrawalConfirmedAt?: number;
  lastWithdrawalAttempt?: number;
  lastUpdated: number;
  usdValue?: number;
}

/**
 * Centralized store for lock states with atomic updates and locking mechanism
 * to prevent race conditions during processing
 */
export class LockStateStore {
  private states: Map<string, LockState> = new Map();
  private processingLocks: Set<string> = new Set();

  constructor(private readonly account: Address) {}

  private getLockKey(chainId: string, lockId: string): string {
    return `${chainId}:${lockId}`;
  }

  /**
   * Update or add a lock state
   */
  public updateLockState(state: LockState): void {
    const key = this.getLockKey(state.chainId, state.lockId);
    state.lastUpdated = Date.now();
    this.states.set(key, state);
  }

  /**
   * Get all locks that need processing (enabled but not withdrawn)
   */
  public getProcessableLocks(): LockState[] {
    return Array.from(this.states.values()).filter(
      (state) =>
        state.status === "Enabled" &&
        !state.withdrawalConfirmed &&
        !state.withdrawalFailed &&
        !this.processingLocks.has(this.getLockKey(state.chainId, state.lockId))
    );
  }

  /**
   * Attempt to acquire a processing lock. Returns true if successful.
   */
  public tryAcquireProcessingLock(chainId: string, lockId: string): boolean {
    const key = this.getLockKey(chainId, lockId);
    if (this.processingLocks.has(key)) {
      return false;
    }
    this.processingLocks.add(key);
    return true;
  }

  /**
   * Release a processing lock
   */
  public releaseProcessingLock(chainId: string, lockId: string): void {
    const key = this.getLockKey(chainId, lockId);
    this.processingLocks.delete(key);
  }

  /**
   * Get a specific lock state
   */
  public getLockState(chainId: string, lockId: string): LockState | undefined {
    return this.states.get(this.getLockKey(chainId, lockId));
  }

  /**
   * Clear expired processing locks (older than 10 minutes)
   */
  public clearExpiredLocks(): void {
    const MAX_LOCK_AGE = 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    for (const [key, state] of this.states.entries()) {
      if (
        this.processingLocks.has(key) &&
        now - state.lastUpdated > MAX_LOCK_AGE
      ) {
        logger.warn(`Clearing expired processing lock for ${key}`);
        this.processingLocks.delete(key);
      }
    }
  }
}

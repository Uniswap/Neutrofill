import { Logger } from "../../utils/logger.js";
import type { Address } from "viem";

const logger = new Logger("LockStateStore");

export type LockStatus =
  | "Disabled"
  | "Pending"
  | "Enabled"
  | "Processing"
  | "Withdrawing"
  | "Withdrawn"
  | "Failed";

export interface LockState {
  chainId: string;
  lockId: string;
  tokenAddress: string;
  status: LockStatus;
  balance: string;
  usdValue?: number;
  availableAt?: number;
  enableTxHash?: string;
  enableTxSubmitted?: boolean;
  enableTxConfirmed?: boolean;
  withdrawalTxHash?: string;
  withdrawalTxSubmitted?: boolean;
  withdrawalConfirmed?: boolean;
  withdrawalConfirmedAt?: number;
  withdrawalFailed?: boolean;
  withdrawalFailedReason?: "TIMEOUT" | "REVERTED";
  lastWithdrawalAttempt?: number;
  lastUpdated: number;
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
  public updateState(chainId: number, lockId: string, state: LockState): void {
    const key = this.getLockKey(state.chainId, state.lockId);
    logger.debug(`[LockStateStore] Updating state for key ${key}`, { state });
    state.lastUpdated = Date.now();
    this.states.set(key, state);
    logger.debug("[LockStateStore] Current states:", {
      states: Array.from(this.states.entries()),
    });
  }

  /**
   * Get all locks that need processing (enabled but not withdrawn)
   */
  public getProcessableLocks(): LockState[] {
    const processableLocks = Array.from(this.states.values()).filter(
      (state) => {
        const key = this.getLockKey(state.chainId, state.lockId);
        const isProcessable =
          state.status === "Enabled" &&
          !state.withdrawalConfirmed &&
          !state.withdrawalFailed &&
          !this.processingLocks.has(key) &&
          state.usdValue !== undefined &&
          state.usdValue > 0;

        if (!isProcessable) {
          logger.debug(
            `Lock ${state.lockId} on chain ${state.chainId} not processable:`,
            {
              status: state.status,
              withdrawalConfirmed: state.withdrawalConfirmed,
              withdrawalFailed: state.withdrawalFailed,
              isProcessing: this.processingLocks.has(key),
              usdValue: state.usdValue,
            }
          );
        }

        return isProcessable;
      }
    );

    logger.debug(
      `Found ${processableLocks.length} processable locks out of ${this.states.size} total locks`
    );
    return processableLocks;
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
   * Get all lock states
   */
  public getAllStates(): LockState[] {
    return Array.from(this.states.values());
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

import type { Address, PublicClient, WalletClient } from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";
import type { LockState, LockStateStore } from "./LockStateStore.js";

const logger = new Logger("ForcedWithdrawalEnablerService");

/**
 * Service that monitors locks and enables forced withdrawals where needed
 */
export class ForcedWithdrawalEnablerService {
  private readonly compactService: TheCompactService;
  private readonly stateStore: LockStateStore;
  private readonly account: Address;
  private intervalId?: NodeJS.Timeout;
  private static readonly MAX_CONFIRMATION_WAIT = 10 * 60 * 1000; // 10 minutes
  private static readonly ENABLE_COOLDOWN = 60 * 1000; // 1 minute cooldown between enable attempts
  private readonly enableAttempts: Map<string, number> = new Map(); // Track last enable attempt timestamps

  constructor(
    account: Address,
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>,
    stateStore: LockStateStore
  ) {
    this.account = account;
    this.compactService = new TheCompactService(publicClients, walletClients);
    this.stateStore = stateStore;
  }

  private getLockKey(chainId: number | string, lockId: string): string {
    return `${chainId}:${lockId}`;
  }

  private canAttemptEnable(chainId: number | string, lockId: string): boolean {
    const key = this.getLockKey(chainId, lockId);
    const lastAttempt = this.enableAttempts.get(key);
    const now = Date.now();

    if (!lastAttempt) return true;
    return now - lastAttempt >= ForcedWithdrawalEnablerService.ENABLE_COOLDOWN;
  }

  private markEnableAttempt(chainId: number | string, lockId: string): void {
    const key = this.getLockKey(chainId, lockId);
    this.enableAttempts.set(key, Date.now());
  }

  private async isTransactionConfirmed(
    chainId: number | string,
    txHash: string
  ): Promise<boolean> {
    try {
      const publicClient = this.compactService.getPublicClient(
        Number(chainId) as SupportedChainId
      );
      if (!publicClient) {
        logger.error(
          `No public client found for chain ${chainId} while monitoring tx ${txHash}`
        );
        return false;
      }

      // Wait for transaction receipt with timeout
      logger.info(`Waiting for transaction ${txHash} confirmation...`);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: txHash as `0x${string}`,
        timeout: ForcedWithdrawalEnablerService.MAX_CONFIRMATION_WAIT,
      });

      const confirmed = receipt.status === "success";
      logger.info(
        `Transaction ${txHash} ${confirmed ? "confirmed" : "reverted"}`,
        {
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          status: receipt.status,
        }
      );

      return confirmed;
    } catch (error) {
      logger.error(`Error monitoring transaction ${txHash}:`, error);
      return false;
    }
  }

  private async monitorTransaction(
    state: LockState,
    txHash: string,
    timedOut = false
  ): Promise<void> {
    const confirmed = await this.isTransactionConfirmed(state.chainId, txHash);

    if (!confirmed) {
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        tokenAddress: state.tokenAddress,
        status: "Disabled",
        enableTxSubmitted: false,
        enableTxHash: undefined,
        lastUpdated: Date.now(),
      });
    } else {
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        tokenAddress: state.tokenAddress,
        status: "Enabled",
        enableTxSubmitted: true,
        enableTxConfirmed: true,
        enableTxHash: txHash,
        lastUpdated: Date.now(),
      });
    }
  }

  private async processLock(state: LockState): Promise<void> {
    try {
      // Skip if already withdrawn
      if (state.status === "Withdrawn") {
        logger.debug(
          `[ForcedWithdrawalEnablerService] Skipping processing for withdrawn lock ${state.lockId} on chain ${state.chainId}`
        );
        return;
      }

      // Skip if already enabled
      if (state.status === "Enabled" && state.enableTxConfirmed) {
        logger.debug(
          `[ForcedWithdrawalEnablerService] Lock ${state.lockId} on chain ${state.chainId} already enabled in local state`
        );
        return;
      }

      const chainIdNum = Number(state.chainId) as SupportedChainId;

      // Check cooldown period before any further processing
      if (!this.canAttemptEnable(state.chainId, state.lockId)) {
        logger.info(
          `[ForcedWithdrawalEnablerService] Skipping enable attempt for lock ${state.lockId} on chain ${state.chainId} - in cooldown period`
        );
        return;
      }

      // Sanity check the on-chain status before submitting a transaction
      const { status: onChainStatus } =
        await this.compactService.getForcedWithdrawalStatus(
          chainIdNum,
          this.account,
          BigInt(state.lockId)
        );

      // If already enabled on-chain but not in our state, update our state
      if (onChainStatus === "Enabled") {
        logger.debug(
          `[ForcedWithdrawalEnablerService] Found lock ${state.lockId} already enabled on-chain, updating local state`
        );
        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          tokenAddress: state.tokenAddress,
          status: "Enabled",
          enableTxConfirmed: true,
          lastUpdated: Date.now(),
        });
        return;
      }

      // Only proceed with enablement if status is Disabled
      if (onChainStatus !== "Disabled") {
        logger.warn(
          `[ForcedWithdrawalEnablerService] Unexpected forced withdrawal status for lock ${state.lockId} on chain ${state.chainId}: ${onChainStatus}`
        );
        return;
      }

      logger.info(
        `[ForcedWithdrawalEnablerService] Attempting to enable forced withdrawal for lock ${state.lockId} on chain ${state.chainId}`
      );

      // Mark the enable attempt before making the call
      this.markEnableAttempt(state.chainId, state.lockId);

      const hash = await this.compactService.enableForcedWithdrawal(
        chainIdNum,
        BigInt(state.lockId)
      );

      logger.info(
        `[ForcedWithdrawalEnablerService] Submitted enable transaction ${hash} for chain ${chainIdNum} lock ${state.lockId}`
      );

      // Update state with transaction hash
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        tokenAddress: state.tokenAddress,
        status: "Processing",
        enableTxSubmitted: true,
        enableTxHash: hash,
        lastUpdated: Date.now(),
      });

      // Monitor enable transaction
      await this.monitorTransaction(state, hash);
    } catch (error) {
      logger.error(
        `[ForcedWithdrawalEnablerService] Error processing lock ${state.lockId} on chain ${state.chainId}:`,
        error
      );
      // Update state to mark as failed
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        status: "Failed",
        lastUpdated: Date.now(),
      });
    } finally {
      // Release processing lock
      this.stateStore.releaseProcessingLock(state.chainId, state.lockId);
    }
  }

  private async processAvailableLocks(): Promise<void> {
    try {
      // Clear any expired processing locks first
      this.stateStore.clearExpiredLocks();

      // Get all processable locks
      const locks = this.stateStore.getProcessableLocks();
      logger.debug(
        `[ForcedWithdrawalEnablerService] Found ${locks.length} processable locks`
      );

      // Process each lock sequentially
      for (const lock of locks) {
        logger.debug(
          `[ForcedWithdrawalEnablerService] Attempting to process lock ${lock.lockId} on chain ${lock.chainId}`,
          {
            status: lock.status,
            balance: lock.balance,
          }
        );

        if (
          this.stateStore.tryAcquireProcessingLock(lock.chainId, lock.lockId)
        ) {
          logger.debug(
            `[ForcedWithdrawalEnablerService] Acquired processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
          await this.processLock(lock);
        } else {
          logger.debug(
            `[ForcedWithdrawalEnablerService] Failed to acquire processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
        }
      }
    } catch (error) {
      logger.error(
        "[ForcedWithdrawalEnablerService] Error in processAvailableLocks:",
        error
      );
    }
  }

  public start(): void {
    if (this.intervalId) {
      logger.warn("ForcedWithdrawalEnablerService already running");
      return;
    }

    // Process immediately on start
    void this.processAvailableLocks();

    // Then process every 5 seconds
    this.intervalId = setInterval(() => {
      void this.processAvailableLocks();
    }, 5000);

    logger.info("ForcedWithdrawalEnablerService started");
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info("ForcedWithdrawalEnablerService stopped");
    }
  }
}

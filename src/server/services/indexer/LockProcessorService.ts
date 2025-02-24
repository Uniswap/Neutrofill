import type { Address, PublicClient, WalletClient } from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";
import type { LockState } from "./LockStateStore.js";
import { LockStateStore } from "./LockStateStore.js";
import type { TransactionReceipt } from "viem";

const logger = new Logger("LockProcessorService");

// Minimum USD value to trigger a withdrawal
const MIN_USD_VALUE = 1;

export class LockProcessorService {
  private readonly compactService: TheCompactService;
  private readonly stateStore: LockStateStore;
  private readonly account: Address;
  private intervalId?: NodeJS.Timeout;
  private static readonly MAX_CONFIRMATION_WAIT = 10 * 60 * 1000; // 10 minutes

  constructor(
    account: Address,
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>
  ) {
    this.account = account;
    this.compactService = new TheCompactService(publicClients, walletClients);
    this.stateStore = new LockStateStore(account);
  }

  private async monitorTransaction(
    chainId: number,
    lockId: string,
    txHash: `0x${string}`,
    isEnableTx = false
  ): Promise<boolean> {
    const publicClient = this.compactService.getPublicClient(
      chainId as SupportedChainId
    );
    if (!publicClient) {
      logger.error(
        `No public client found for chain ${chainId} while monitoring tx ${txHash}`
      );
      return false;
    }

    const startTime = Date.now();
    let confirmed = false;
    let timedOut = false;

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("Transaction confirmation timeout"));
        }, LockProcessorService.MAX_CONFIRMATION_WAIT);
      });

      // Wait for transaction receipt with timeout
      logger.info(`Waiting for transaction ${txHash} confirmation...`);
      const receipt = (await Promise.race([
        publicClient.waitForTransactionReceipt({ hash: txHash }),
        timeoutPromise,
      ])) as TransactionReceipt;

      confirmed = receipt.status === "success";
      const duration = Date.now() - startTime;
      logger.info(
        `Transaction ${txHash} ${confirmed ? "confirmed" : "reverted"} after ${duration}ms`,
        {
          blockNumber: receipt.blockNumber.toString(),
          gasUsed: receipt.gasUsed.toString(),
          status: receipt.status,
          duration,
        }
      );
    } catch (error) {
      const duration = Date.now() - startTime;
      timedOut = duration >= LockProcessorService.MAX_CONFIRMATION_WAIT;

      logger.error(
        `Error monitoring transaction ${txHash} after ${duration}ms: ${
          timedOut ? "TIMED OUT" : error
        }`
      );
      confirmed = false;
    }

    // Update lock state based on confirmation
    const state = this.stateStore.getLockState(chainId.toString(), lockId);
    if (!state) {
      logger.warn(
        `Lock ${lockId} state not found while updating confirmation status`
      );
      return false;
    }

    if (isEnableTx) {
      if (!confirmed) {
        this.stateStore.updateLockState({
          ...state,
          status: "Disabled",
          enableTxSubmitted: false,
        });
      } else {
        this.stateStore.updateLockState({
          ...state,
          status: "Enabled",
          enableTxSubmitted: true,
        });
      }
    } else {
      if (!confirmed) {
        this.stateStore.updateLockState({
          ...state,
          withdrawalFailed: true,
          withdrawalFailedReason: timedOut ? "TIMEOUT" : "REVERTED",
          lastWithdrawalAttempt: Date.now(),
        });
      } else {
        this.stateStore.updateLockState({
          ...state,
          withdrawalConfirmed: true,
          withdrawalConfirmedAt: Date.now(),
        });
      }
    }

    return confirmed;
  }

  private async processLock(state: LockState): Promise<void> {
    const { chainId, lockId, tokenAddress, balance, usdValue } = state;

    try {
      // Skip if value too low
      if (!usdValue || usdValue < MIN_USD_VALUE) {
        logger.debug(
          `Skipping withdrawal for lock ${lockId} on chain ${chainId} - value too low`,
          { usdValue, minimum: MIN_USD_VALUE }
        );
        return;
      }

      // Check if withdrawal is enabled
      const chainIdNum = Number(chainId) as SupportedChainId;
      const { status, availableAt } =
        await this.compactService.getForcedWithdrawalStatus(
          chainIdNum,
          this.account,
          BigInt(lockId)
        );

      if (status === "Disabled") {
        logger.info(
          `Attempting to enable forced withdrawal for lock ${lockId} on chain ${chainId}`
        );

        const hash = await this.compactService.enableForcedWithdrawal(
          chainIdNum,
          BigInt(lockId)
        );

        this.stateStore.updateLockState({
          ...state,
          status: "Pending",
          enableTxSubmitted: true,
          availableAt,
        });

        // Monitor enable transaction
        const confirmed = await this.monitorTransaction(
          chainIdNum,
          lockId,
          hash,
          true
        );
        if (!confirmed) return;
      }

      // Execute withdrawal if enabled
      if (status === "Enabled") {
        logger.info(
          `Executing withdrawal for lock ${lockId} on chain ${chainId}`,
          { balance, usdValue }
        );

        const hash = await this.compactService.executeForcedWithdrawal(
          chainIdNum,
          BigInt(lockId),
          BigInt(balance)
        );

        this.stateStore.updateLockState({
          ...state,
          withdrawalTxHash: hash,
          withdrawalTxSubmitted: true,
          lastWithdrawalAttempt: Date.now(),
        });

        // Monitor withdrawal transaction
        await this.monitorTransaction(chainIdNum, lockId, hash);
      }
    } catch (error) {
      logger.error(
        `Error processing lock ${lockId} on chain ${chainId}:`,
        error
      );
    } finally {
      this.stateStore.releaseProcessingLock(chainId, lockId);
    }
  }

  private async processAvailableLocks(): Promise<void> {
    try {
      // Clear any expired processing locks first
      this.stateStore.clearExpiredLocks();

      // Get all processable locks
      const locks = this.stateStore.getProcessableLocks();

      // Process each lock sequentially
      for (const lock of locks) {
        if (
          this.stateStore.tryAcquireProcessingLock(lock.chainId, lock.lockId)
        ) {
          await this.processLock(lock);
        }
      }
    } catch (error) {
      logger.error("Error in processAvailableLocks:", error);
    }
  }

  public start(): void {
    if (this.intervalId) {
      logger.warn("LockProcessorService already running");
      return;
    }

    // Process immediately on start
    void this.processAvailableLocks();

    // Then process every 5 seconds
    this.intervalId = setInterval(() => {
      void this.processAvailableLocks();
    }, 5000);

    logger.info("LockProcessorService started");
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info("LockProcessorService stopped");
    }
  }

  public getStateStore(): LockStateStore {
    return this.stateStore;
  }
}

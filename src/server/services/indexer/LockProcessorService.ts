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
        timeout: LockProcessorService.MAX_CONFIRMATION_WAIT,
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
    isEnableTx: boolean,
    txHash: string,
    timedOut = false
  ): Promise<void> {
    const confirmed = await this.isTransactionConfirmed(state.chainId, txHash);

    if (isEnableTx) {
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
          lastUpdated: Date.now(),
        });
      }
    } else {
      if (!confirmed) {
        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          tokenAddress: state.tokenAddress,
          withdrawalFailed: true,
          withdrawalFailedReason: timedOut ? "TIMEOUT" : "REVERTED",
          withdrawalTxHash: undefined,
          lastUpdated: Date.now(),
        });
      } else {
        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          tokenAddress: state.tokenAddress,
          withdrawalConfirmed: true,
          withdrawalConfirmedAt: Date.now(),
          lastUpdated: Date.now(),
        });
      }
    }
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

        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          tokenAddress: state.tokenAddress,
          status: "Pending",
          enableTxSubmitted: true,
          enableTxHash: hash,
          availableAt,
          lastUpdated: Date.now(),
        });

        // Monitor enable transaction
        await this.monitorTransaction(state, true, hash);
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

        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          tokenAddress: state.tokenAddress,
          withdrawalTxHash: hash,
          withdrawalTxSubmitted: true,
          lastWithdrawalAttempt: Date.now(),
          lastUpdated: Date.now(),
        });

        // Monitor withdrawal transaction
        await this.monitorTransaction(state, false, hash);
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
      logger.debug(`Found ${locks.length} processable locks`);

      // Process each lock sequentially
      for (const lock of locks) {
        logger.debug(
          `Attempting to process lock ${lock.lockId} on chain ${lock.chainId}`,
          {
            status: lock.status,
            balance: lock.balance,
            usdValue: lock.usdValue,
          }
        );

        if (
          this.stateStore.tryAcquireProcessingLock(lock.chainId, lock.lockId)
        ) {
          logger.debug(
            `Acquired processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
          await this.processLock(lock);
        } else {
          logger.debug(
            `Failed to acquire processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
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

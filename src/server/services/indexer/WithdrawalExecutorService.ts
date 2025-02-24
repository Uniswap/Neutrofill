import type {
  Address,
  PublicClient,
  WalletClient,
  WriteContractParameters,
} from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";
import type { LockState, LockStateStore } from "./LockStateStore.js";

const logger = new Logger("WithdrawalExecutorService");

const lockAbi = [
  {
    inputs: [{ type: "uint256", name: "amount" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const MIN_USD_VALUE = 1;

/**
 * Service that executes withdrawals for locks that have forced withdrawals enabled
 */
export class WithdrawalExecutorService {
  private readonly compactService: TheCompactService;
  private readonly stateStore: LockStateStore;
  private readonly walletClients: Map<SupportedChainId, WalletClient>;
  private readonly account: Address;
  private intervalId?: NodeJS.Timeout;
  private static readonly MAX_CONFIRMATION_WAIT = 10 * 60 * 1000; // 10 minutes

  constructor(
    account: Address,
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>,
    stateStore: LockStateStore
  ) {
    this.account = account;
    this.compactService = new TheCompactService(publicClients, walletClients);
    this.stateStore = stateStore;
    this.walletClients = new Map(
      Object.entries(walletClients).map(([chainId, client]) => [
        Number(chainId) as SupportedChainId,
        client,
      ])
    );
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
        timeout: WithdrawalExecutorService.MAX_CONFIRMATION_WAIT,
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
        withdrawalFailed: true,
        withdrawalFailedReason: timedOut ? "TIMEOUT" : "REVERTED",
        withdrawalTxHash: undefined,
        lastUpdated: Date.now(),
      });
    } else {
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        tokenAddress: state.tokenAddress,
        balance: "0", // Clear the balance after successful withdrawal
        usdValue: 0, // Reset USD value
        status: "Withdrawn",
        withdrawalConfirmed: true,
        withdrawalConfirmedAt: Date.now(),
        withdrawalTxHash: txHash,
        lastUpdated: Date.now(),
      });
    }
  }

  private async processLock(state: LockState): Promise<void> {
    try {
      const chainIdNum = Number(state.chainId) as SupportedChainId;

      // Skip if already withdrawn
      if (state.status === "Withdrawn") {
        logger.debug(
          `[WithdrawalExecutorService] Skipping processing for withdrawn lock ${state.lockId} on chain ${state.chainId}`
        );
        return;
      }

      // Skip if value too low
      if (!state.usdValue || state.usdValue < MIN_USD_VALUE) {
        logger.debug(
          `[WithdrawalExecutorService] Skipping withdrawal for lock ${state.lockId} on chain ${state.chainId} - value too low`,
          { usdValue: state.usdValue, minimum: MIN_USD_VALUE }
        );
        return;
      }

      // Verify the lock is enabled before attempting withdrawal
      const { status: onChainStatus } =
        await this.compactService.getForcedWithdrawalStatus(
          chainIdNum,
          this.account,
          BigInt(state.lockId)
        );

      if (onChainStatus !== "Enabled") {
        logger.debug(
          `[WithdrawalExecutorService] Skipping withdrawal for lock ${state.lockId} on chain ${state.chainId} - not enabled (status: ${onChainStatus})`
        );
        return;
      }

      // Execute the withdrawal
      logger.info(
        `[WithdrawalExecutorService] Executing withdrawal for lock ${state.lockId} on chain ${state.chainId}`,
        { balance: state.balance, usdValue: state.usdValue }
      );

      const walletClient = this.walletClients.get(chainIdNum);
      if (!walletClient) {
        throw new Error(`No wallet client found for chain ${chainIdNum}`);
      }

      const writeParams: WriteContractParameters = {
        address: state.lockId as `0x${string}`,
        abi: lockAbi,
        functionName: "withdraw",
        args: [BigInt(state.balance)],
        chain: null,
        account: this.account,
      };

      const hash = await walletClient.writeContract(writeParams);

      logger.info(
        `[WithdrawalExecutorService] Submitted withdrawal transaction ${hash} for chain ${chainIdNum} lock ${state.lockId}`
      );

      // Update state with transaction hash
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        tokenAddress: state.tokenAddress,
        status: "Withdrawing",
        withdrawalTxHash: hash,
        withdrawalTxSubmitted: true,
        lastUpdated: Date.now(),
      });

      // Monitor withdrawal transaction
      await this.monitorTransaction(state, hash);
    } catch (error) {
      logger.error(
        `[WithdrawalExecutorService] Error processing lock ${state.lockId} on chain ${state.chainId}:`,
        error
      );
      // Update state to mark as failed
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        withdrawalFailed: true,
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
        `[WithdrawalExecutorService] Found ${locks.length} processable locks`
      );

      // Process each lock sequentially
      for (const lock of locks) {
        logger.debug(
          `[WithdrawalExecutorService] Attempting to process lock ${lock.lockId} on chain ${lock.chainId}`,
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
            `[WithdrawalExecutorService] Acquired processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
          await this.processLock(lock);
        } else {
          logger.debug(
            `[WithdrawalExecutorService] Failed to acquire processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
        }
      }
    } catch (error) {
      logger.error(
        "[WithdrawalExecutorService] Error in processAvailableLocks:",
        error
      );
    }
  }

  public start(): void {
    if (this.intervalId) {
      logger.warn("WithdrawalExecutorService already running");
      return;
    }

    // Process immediately on start
    void this.processAvailableLocks();

    // Then process every 5 seconds
    this.intervalId = setInterval(() => {
      void this.processAvailableLocks();
    }, 5000);

    logger.info("WithdrawalExecutorService started");
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info("WithdrawalExecutorService stopped");
    }
  }
}

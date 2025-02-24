import type {
  Address,
  PublicClient,
  WalletClient,
  WriteContractParameters,
} from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";
import { type LockState, LockStateStore } from "./LockStateStore.js";

const logger = new Logger("LockProcessorService");

const lockAbi = [
  {
    inputs: [],
    name: "enableWithdrawals",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
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
 * Service that processes resource locks by enabling withdrawals and executing withdrawals
 */
export class LockProcessorService {
  private readonly compactService: TheCompactService;
  private readonly stateStore: LockStateStore;
  private readonly walletClients: Map<SupportedChainId, WalletClient>;
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
    try {
      logger.debug(
        `[LockProcessorService] Processing lock ${state.lockId} on chain ${state.chainId}`,
        {
          state,
        }
      );

      const chainIdNum = Number(state.chainId) as SupportedChainId;

      // Skip if value too low
      if (!state.usdValue || state.usdValue < MIN_USD_VALUE) {
        logger.debug(
          `[LockProcessorService] Skipping withdrawal for lock ${state.lockId} on chain ${state.chainId} - value too low`,
          { usdValue: state.usdValue, minimum: MIN_USD_VALUE }
        );
        return;
      }

      // Check if withdrawals are enabled
      const status = (await this.isWithdrawalEnabled(chainIdNum))
        ? "Enabled"
        : "Disabled";

      if (status === "Disabled") {
        logger.info(
          `[LockProcessorService] Attempting to enable forced withdrawal for lock ${state.lockId} on chain ${state.chainId}`
        );

        const hash = await this.compactService.enableForcedWithdrawal(
          chainIdNum,
          BigInt(state.lockId)
        );

        logger.info(
          `[LockProcessorService] Submitted enable transaction ${hash} for chain ${chainIdNum} lock ${state.lockId}`
        );

        // Update state with transaction hash
        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          status: "Processing",
          enableTxSubmitted: true,
          enableTxHash: hash,
          lastUpdated: Date.now(),
        });

        // Monitor enable transaction
        await this.monitorTransaction(state, true, hash);
      }

      // Execute withdrawal if enabled
      if (status === "Enabled") {
        logger.info(
          `[LockProcessorService] Executing withdrawal for lock ${state.lockId} on chain ${state.chainId}`,
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

        const result = await walletClient.writeContract(writeParams);

        logger.info(
          `[LockProcessorService] Submitted withdrawal transaction ${result} for chain ${chainIdNum} lock ${state.lockId}`
        );

        // Update state with transaction hash
        this.stateStore.updateState(Number(state.chainId), state.lockId, {
          ...state,
          status: "Withdrawing",
          withdrawalTxHash: result,
          withdrawalTxSubmitted: true,
          lastUpdated: Date.now(),
        });

        // Monitor withdrawal transaction
        await this.monitorTransaction(state, false, result);
      }
    } catch (error) {
      logger.error(
        `[LockProcessorService] Error processing lock ${state.lockId} on chain ${state.chainId}:`,
        error
      );
      // Update state to mark as failed
      this.stateStore.updateState(Number(state.chainId), state.lockId, {
        ...state,
        status: "Failed",
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
        `[LockProcessorService] Found ${locks.length} processable locks`
      );

      // Process each lock sequentially
      for (const lock of locks) {
        logger.debug(
          `[LockProcessorService] Attempting to process lock ${lock.lockId} on chain ${lock.chainId}`,
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
            `[LockProcessorService] Acquired processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
          await this.processLock(lock);
        } else {
          logger.debug(
            `[LockProcessorService] Failed to acquire processing lock for ${lock.lockId} on chain ${lock.chainId}`
          );
        }
      }
    } catch (error) {
      logger.error(
        "[LockProcessorService] Error in processAvailableLocks:",
        error
      );
    }
  }

  private async isWithdrawalEnabled(chainId: number): Promise<boolean> {
    try {
      const { status } = await this.compactService.getForcedWithdrawalStatus(
        chainId as SupportedChainId,
        this.account,
        BigInt(0) // Just need to check global status
      );
      return status === "Enabled";
    } catch (error) {
      logger.error(
        `[LockProcessorService] Error checking withdrawal status for chain ${chainId}:`,
        error
      );
      return false;
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

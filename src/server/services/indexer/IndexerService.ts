import type { Address } from "viem";
import type { PublicClient, WalletClient } from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";
import type { TransactionReceipt } from "viem";

const logger = new Logger("IndexerService");

// Minimum USD value to trigger a withdrawal
const MIN_USD_VALUE = 1;

// Token addresses
const WETH_ADDRESSES: { [chainId: number]: string } = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  10: "0x4200000000000000000000000000000000000006",
  8453: "0x4200000000000000000000000000000000000006",
};

const USDC_ADDRESSES: { [chainId: number]: string } = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

// Price oracle endpoints
const PRICE_ENDPOINTS = {
  ETH: "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd",
};

interface ResourceLockItem {
  chainId: string;
  tokenAddress: string;
  balance: string;
  resourceLock: {
    lockId: string;
  };
}

interface IndexerResponse {
  data: {
    account: {
      resourceLocks: {
        items: ResourceLockItem[];
      };
    };
  };
}

interface CoinGeckoResponse {
  ethereum: {
    usd: number;
  };
}

// Track locks we've already processed or are processing
interface LockStatus {
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
}

interface TokenInfo {
  decimals: number;
  isUSDC?: boolean;
}

export class IndexerService {
  private readonly indexerUrl: string;
  private readonly account: Address;
  private readonly compactService: TheCompactService;
  private intervalId?: NodeJS.Timeout;
  private processedLocks: Map<string, LockStatus> = new Map();
  private lastEthPrice?: number;
  private lastPriceUpdate = 0;

  // Maximum time to wait for transaction confirmation (10 minutes)
  private static readonly MAX_CONFIRMATION_WAIT = 10 * 60 * 1000;

  constructor(
    indexerUrl: string,
    account: Address,
    publicClients: { [chainId: number]: PublicClient },
    walletClients: { [chainId: number]: WalletClient }
  ) {
    this.indexerUrl = indexerUrl;
    this.account = account;
    this.compactService = new TheCompactService(publicClients, walletClients);
  }

  private getLockKey(chainId: string, lockId: string): string {
    return `${chainId}:${lockId}`;
  }

  private async getEthPrice(): Promise<number> {
    const now = Date.now();
    if (this.lastEthPrice && now - this.lastPriceUpdate < 5 * 60 * 1000) {
      return this.lastEthPrice;
    }

    const response = await fetch(PRICE_ENDPOINTS.ETH);
    const data = (await response.json()) as CoinGeckoResponse;
    this.lastEthPrice = data.ethereum.usd;
    this.lastPriceUpdate = now;
    return this.lastEthPrice;
  }

  private isEthOrWeth(chainId: number, tokenAddress: string): boolean {
    const wethAddress = WETH_ADDRESSES[chainId]?.toLowerCase();
    return Boolean(
      tokenAddress === "0x0000000000000000000000000000000000000000" ||
        (wethAddress && tokenAddress.toLowerCase() === wethAddress)
    );
  }

  private isUSDC(chainId: number, tokenAddress: string): boolean {
    const usdcAddress = USDC_ADDRESSES[chainId]?.toLowerCase();
    return Boolean(usdcAddress && tokenAddress.toLowerCase() === usdcAddress);
  }

  private getTokenInfo(
    chainId: number,
    tokenAddress: string
  ): TokenInfo | null {
    if (this.isEthOrWeth(chainId, tokenAddress)) {
      return { decimals: 18 };
    }
    if (this.isUSDC(chainId, tokenAddress)) {
      return { decimals: 6, isUSDC: true };
    }
    return null;
  }

  private async checkAndProcessWithdrawal(
    chainId: string,
    lockId: string,
    tokenAddress: string,
    balance: string
  ): Promise<void> {
    const lockKey = this.getLockKey(chainId, lockId);
    const existingStatus = this.processedLocks.get(lockKey);

    // Skip if withdrawal already submitted or previously failed
    if (
      existingStatus?.withdrawalTxSubmitted ||
      existingStatus?.withdrawalFailed
    ) {
      logger.debug(
        `Skipping withdrawal for lock ${lockId} on chain ${chainId} - ${
          existingStatus.withdrawalFailed
            ? "previously failed"
            : "already submitted"
        }`
      );
      return;
    }

    const chainIdNum = Number(chainId);
    const balanceNum = BigInt(balance);

    // Skip if balance is 0
    if (balanceNum === 0n) {
      logger.debug(
        `Skipping withdrawal for lock ${lockId} on chain ${chainId} - zero balance`
      );
      return;
    }

    try {
      // Get token info
      const tokenInfo = this.getTokenInfo(chainIdNum, tokenAddress);
      if (!tokenInfo) {
        logger.debug(
          `Skipping withdrawal for lock ${lockId} on chain ${chainId} - unsupported token`,
          { tokenAddress }
        );
        return;
      }

      let usdValue: number;
      if (tokenInfo.isUSDC) {
        // For USDC, just convert from 6 decimals
        usdValue = Number(balanceNum) / 1e6;
      } else {
        // For ETH/WETH, get price and convert from 18 decimals
        const ethPrice = await this.getEthPrice();
        const balanceInEth = Number(balanceNum) / 1e18;
        usdValue = balanceInEth * ethPrice;
      }

      logger.info(
        `Checking withdrawal for lock ${lockId} on chain ${chainId}`,
        {
          balance: balanceNum.toString(),
          usdValue,
          tokenType: tokenInfo.isUSDC ? "USDC" : "ETH",
        }
      );

      // Only withdraw if value exceeds minimum
      if (usdValue < MIN_USD_VALUE) {
        logger.debug(
          `Skipping withdrawal for lock ${lockId} on chain ${chainId} - value too low`,
          { usdValue, minimum: MIN_USD_VALUE }
        );
        return;
      }

      // Check if withdrawal is enabled
      const { status } = await this.compactService.getForcedWithdrawalStatus(
        chainIdNum,
        this.account,
        BigInt(lockId)
      );

      if (status !== "Enabled") {
        logger.debug(
          `Skipping withdrawal for lock ${lockId} on chain ${chainId} - not enabled`,
          { status }
        );
        return;
      }

      // Execute withdrawal
      logger.info(
        `Executing withdrawal for lock ${lockId} on chain ${chainId}`,
        { balance: balanceNum.toString(), usdValue }
      );

      const hash = await this.compactService.executeForcedWithdrawal(
        chainIdNum,
        BigInt(lockId),
        balanceNum
      );

      // Update status
      this.processedLocks.set(lockKey, {
        ...existingStatus,
        status: existingStatus?.status || "Enabled",
        withdrawalTxHash: hash,
        withdrawalTxSubmitted: true,
        lastWithdrawalAttempt: Date.now(),
      });

      logger.info(
        `Submitted withdrawal transaction for lock ${lockId} on chain ${chainId}`,
        { hash }
      );

      // Start monitoring the transaction
      this.monitorWithdrawalTransaction(chainIdNum, lockId, hash);
    } catch (error) {
      logger.error(
        `Error processing withdrawal for lock ${lockId} on chain ${chainId}:`,
        error
      );

      // Mark as failed to prevent repeated attempts
      this.processedLocks.set(lockKey, {
        ...existingStatus,
        status: existingStatus?.status || "Disabled",
        withdrawalFailed: true,
        lastWithdrawalAttempt: Date.now(),
      });
    }
  }

  private async checkAndEnableForcedWithdrawal(
    chainId: string,
    lockId: string
  ): Promise<void> {
    const lockKey = this.getLockKey(chainId, lockId);
    const existingStatus = this.processedLocks.get(lockKey);

    logger.info(
      `Checking forced withdrawal status for lock ${lockId} on chain ${chainId}`,
      { existingStatus }
    );

    // Skip if we've already submitted a transaction or if it's already enabled
    if (
      existingStatus?.enableTxSubmitted ||
      existingStatus?.status === "Enabled"
    ) {
      logger.debug(
        `Skipping enableForcedWithdrawal for lock ${lockId} on chain ${chainId} - ${
          existingStatus.enableTxSubmitted
            ? "already submitted"
            : "already enabled"
        }`,
        { existingStatus }
      );
      return;
    }

    try {
      // Check current status
      logger.info(
        `Fetching current status for lock ${lockId} on chain ${chainId}`
      );
      const { status, availableAt } =
        await this.compactService.getForcedWithdrawalStatus(
          Number(chainId),
          this.account,
          BigInt(lockId)
        );

      logger.info(`Got status for lock ${lockId} on chain ${chainId}`, {
        status,
        availableAt,
      });

      // Update our tracking
      this.processedLocks.set(lockKey, {
        status,
        availableAt,
      });

      // If disabled, enable forced withdrawal
      if (status === "Disabled") {
        logger.info(
          `Attempting to enable forced withdrawal for lock ${lockId} on chain ${chainId}`
        );

        const hash = await this.compactService.enableForcedWithdrawal(
          Number(chainId),
          BigInt(lockId)
        );

        // Mark that we've submitted a transaction and set status to Pending
        this.processedLocks.set(lockKey, {
          status: "Pending",
          enableTxSubmitted: true,
          availableAt,
        });

        logger.info(
          `Successfully submitted enableForcedWithdrawal transaction for lock ${lockId} on chain ${chainId}: ${hash}`
        );
      } else {
        logger.info(
          `Forced withdrawal already ${status.toLowerCase()} for lock ${lockId} on chain ${chainId}`,
          availableAt > 0
            ? { availableAt: new Date(availableAt * 1000).toISOString() }
            : {}
        );
      }
    } catch (error) {
      logger.error(
        `Error checking/enabling forced withdrawal for lock ${lockId} on chain ${chainId}:`,
        error
      );
    }
  }

  private async pollIndexer(): Promise<void> {
    try {
      const url = `${this.indexerUrl}/graphql`;
      const query = `
        query MyQuery($server: String!) {
          account(address: $server) {
            resourceLocks {
              items {
                resourceLock {
                  lockId
                }
                chainId
                tokenAddress
                balance
              }
            }
          }
        }
      `;
      const variables = {
        server: this.account.toLowerCase(),
      };

      logger.info(`Polling indexer at ${url}`);

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(
          `HTTP error! status: ${response.status}, body: ${text}`
        );
      }

      const data = (await response.json()) as IndexerResponse;

      if (!data.data.account) {
        logger.info(`No account found for address ${this.account}`);
        return;
      }

      const items = data.data.account.resourceLocks?.items || [];

      if (items.length > 0) {
        for (const item of items) {
          logger.info(`Resource lock found on chain ${item.chainId}:`, {
            chainId: item.chainId,
            tokenAddress: item.tokenAddress,
            balance: item.balance,
            lockId: item.resourceLock.lockId,
          });

          // Check and potentially enable forced withdrawal
          await this.checkAndEnableForcedWithdrawal(
            item.chainId,
            item.resourceLock.lockId
          );

          // Check and potentially execute withdrawal
          await this.checkAndProcessWithdrawal(
            item.chainId,
            item.resourceLock.lockId,
            item.tokenAddress,
            item.balance
          );
        }
      }
    } catch (error) {
      logger.error("Error polling indexer:", error);
      if (error instanceof Error) {
        logger.error("URL:", `${this.indexerUrl}/graphql`);
        logger.error("Account:", this.account);
      }
    }
  }

  private async monitorWithdrawalTransaction(
    chainId: number,
    lockId: string,
    txHash: `0x${string}`
  ): Promise<void> {
    const lockKey = this.getLockKey(chainId.toString(), lockId);
    const publicClient = this.compactService.getPublicClient(chainId);
    if (!publicClient) {
      logger.error(
        `No public client found for chain ${chainId} while monitoring tx ${txHash}`
      );
      return;
    }

    const startTime = Date.now();
    let confirmed = false;
    let timedOut = false;

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error("Transaction confirmation timeout"));
        }, IndexerService.MAX_CONFIRMATION_WAIT);
      });

      // Wait for transaction receipt with timeout
      logger.info(`Waiting for transaction ${txHash} confirmation...`);
      const receipt = (await Promise.race([
        publicClient.waitForTransactionReceipt({
          hash: txHash,
        }),
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
      timedOut = duration >= IndexerService.MAX_CONFIRMATION_WAIT;

      logger.error(
        `Error monitoring transaction ${txHash} after ${duration}ms: ${
          timedOut ? "TIMED OUT" : error
        }`
      );
      confirmed = false;
    }

    // Update lock status based on confirmation
    const existingStatus = this.processedLocks.get(lockKey);
    if (!existingStatus) {
      logger.warn(
        `Lock ${lockId} status not found while updating confirmation status`
      );
      return;
    }

    if (!confirmed) {
      // Mark as failed and add to dead letter queue if timed out
      this.processedLocks.set(lockKey, {
        ...existingStatus,
        status: existingStatus.status,
        withdrawalFailed: true,
        withdrawalFailedReason: timedOut ? "TIMEOUT" : "REVERTED",
        lastWithdrawalAttempt: Date.now(),
      });

      logger.warn(
        `Withdrawal transaction ${txHash} ${
          timedOut ? "timed out" : "failed"
        } for lock ${lockId} on chain ${chainId} - added to dead letter queue`
      );
    } else {
      // Mark as successfully withdrawn
      this.processedLocks.set(lockKey, {
        ...existingStatus,
        status: existingStatus.status,
        withdrawalConfirmed: true,
        withdrawalConfirmedAt: Date.now(),
      });

      logger.info(
        `Withdrawal transaction ${txHash} confirmed for lock ${lockId} on chain ${chainId}`
      );
    }
  }

  public start(): void {
    if (this.intervalId) {
      logger.warn("IndexerService already running");
      return;
    }

    // Poll immediately on start
    void this.pollIndexer();

    // Then poll every 3 seconds
    this.intervalId = setInterval(() => {
      void this.pollIndexer();
    }, 3000);

    logger.info("IndexerService started");
  }

  public stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      logger.info("IndexerService stopped");
    }
  }
}

import type { Address } from "viem";
import type { PublicClient, WalletClient } from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";

const logger = new Logger("IndexerService");

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

// Track locks we've already processed or are processing
interface LockStatus {
  status: "Disabled" | "Pending" | "Enabled";
  availableAt?: number;
  enableTxSubmitted?: boolean;
}

export class IndexerService {
  private readonly indexerUrl: string;
  private readonly account: Address;
  private readonly compactService: TheCompactService;
  private intervalId?: NodeJS.Timeout;
  private processedLocks: Map<string, LockStatus> = new Map();

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

  private async checkAndEnableForcedWithdrawal(
    chainId: string,
    lockId: string
  ): Promise<void> {
    const lockKey = this.getLockKey(chainId, lockId);
    const existingStatus = this.processedLocks.get(lockKey);

    // Skip if we've already submitted a transaction or if withdrawals are already pending/enabled
    if (
      existingStatus?.enableTxSubmitted ||
      existingStatus?.status !== "Disabled"
    ) {
      return;
    }

    try {
      // Check current status
      const { status, availableAt } =
        await this.compactService.getForcedWithdrawalStatus(
          Number(chainId),
          this.account,
          BigInt(lockId)
        );

      // Update our tracking
      this.processedLocks.set(lockKey, {
        status,
        availableAt,
      });

      // If disabled, enable forced withdrawal
      if (status === "Disabled") {
        logger.info(
          `Enabling forced withdrawal for lock ${lockId} on chain ${chainId}`
        );

        const hash = await this.compactService.enableForcedWithdrawal(
          Number(chainId),
          BigInt(lockId)
        );

        // Mark that we've submitted a transaction
        this.processedLocks.set(lockKey, {
          status: "Disabled",
          enableTxSubmitted: true,
        });
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

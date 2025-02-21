import { Logger } from "../../utils/logger.js";
import type { Address } from "viem";

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

export class IndexerService {
  private readonly indexerUrl: string;
  private readonly account: Address;
  private intervalId?: NodeJS.Timeout;

  constructor(indexerUrl: string, account: Address) {
    this.indexerUrl = indexerUrl;
    this.account = account;
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
      logger.debug("Query:", query);
      logger.debug("Variables:", variables);

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
      logger.debug("Response:", data);

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
}

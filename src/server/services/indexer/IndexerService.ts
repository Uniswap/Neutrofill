import type { Address } from "viem";
import type { PublicClient, WalletClient } from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { TheCompactService } from "../TheCompactService.js";
import type { LockState, LockStatus } from "./LockStateStore.js";
import { LockStateStore } from "./LockStateStore.js";

const logger = new Logger("IndexerService");

// Token addresses
const WETH_ADDRESSES: Record<SupportedChainId, string> = {
  1: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  10: "0x4200000000000000000000000000000000000006",
  130: "0x4200000000000000000000000000000000000006",
  8453: "0x4200000000000000000000000000000000000006",
} as const;

const USDC_ADDRESSES: Record<SupportedChainId, string> = {
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  10: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  130: "0x078d782b760474a361dda0af3839290b0ef57ad6",
  8453: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
} as const;

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

interface TokenInfo {
  decimals: number;
  isUSDC?: boolean;
}

export class IndexerService {
  private readonly indexerUrl: string;
  private readonly account: Address;
  private readonly compactService: TheCompactService;
  private readonly stateStore: LockStateStore;
  private intervalId?: NodeJS.Timeout;
  private lastEthPrice?: number;
  private lastPriceUpdate = 0;

  constructor(
    indexerUrl: string,
    account: Address,
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>
  ) {
    this.indexerUrl = indexerUrl;
    this.account = account;
    this.compactService = new TheCompactService(publicClients, walletClients);
    this.stateStore = new LockStateStore(account);
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
    const chainIdNum = chainId as SupportedChainId;
    return (
      tokenAddress === "0x0000000000000000000000000000000000000000" ||
      tokenAddress.toLowerCase() === WETH_ADDRESSES[chainIdNum]?.toLowerCase()
    );
  }

  private isUSDC(chainId: number, tokenAddress: string): boolean {
    const chainIdNum = chainId as SupportedChainId;
    return (
      tokenAddress.toLowerCase() === USDC_ADDRESSES[chainIdNum]?.toLowerCase()
    );
  }

  private getTokenInfo(
    chainId: number,
    tokenAddress: string
  ): TokenInfo | null {
    const chainIdNum = chainId as SupportedChainId;
    if (this.isEthOrWeth(chainIdNum, tokenAddress)) {
      return { decimals: 18 };
    }
    if (this.isUSDC(chainIdNum, tokenAddress)) {
      return { decimals: 6, isUSDC: true };
    }
    return null;
  }

  private async calculateUsdValue(
    chainId: number,
    tokenAddress: string,
    balance: string
  ): Promise<number | undefined> {
    const tokenInfo = this.getTokenInfo(chainId, tokenAddress);
    if (!tokenInfo) return undefined;

    const balanceNum = BigInt(balance);
    if (balanceNum === 0n) return 0;

    if (tokenInfo.isUSDC) {
      // For USDC, just convert from 6 decimals
      return Number(balanceNum) / 1e6;
    }

    // For ETH/WETH, get price and convert from 18 decimals
    const ethPrice = await this.getEthPrice();
    const balanceInEth = Number(balanceNum) / 1e18;
    return balanceInEth * ethPrice;
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

      logger.debug(`Polling indexer at ${url}`);

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

      // Process each item and update state
      for (const item of items) {
        const chainId = item.chainId;
        const lockId = item.resourceLock.lockId;
        const chainIdNum = Number(chainId);

        // Calculate USD value
        const usdValue = await this.calculateUsdValue(
          chainIdNum,
          item.tokenAddress,
          item.balance
        );

        // Get current status
        const { status, availableAt } =
          await this.compactService.getForcedWithdrawalStatus(
            chainIdNum as SupportedChainId,
            this.account,
            BigInt(lockId)
          );

        // Update state store
        await this.updateLockState(
          chainIdNum,
          lockId,
          status,
          item.balance,
          usdValue,
          item.tokenAddress
        );

        logger.debug(`Updated state for lock ${lockId} on chain ${chainId}:`, {
          status,
          balance: item.balance,
          usdValue,
        });
      }
    } catch (error) {
      logger.error("Error polling indexer:", error);
      if (error instanceof Error) {
        logger.error("URL:", `${this.indexerUrl}/graphql`);
        logger.error("Account:", this.account);
      }
    }
  }

  private async updateLockState(
    chainId: number,
    lockId: string,
    status: LockStatus,
    balance: string,
    usdValue: number | undefined,
    tokenAddress: string
  ): Promise<void> {
    logger.debug(
      `[IndexerService] Updating state for lock ${lockId} on chain ${chainId}`,
      {
        status,
        balance,
        usdValue,
        tokenAddress,
        currentStates: this.stateStore.getAllStates(),
      }
    );

    const state: LockState = {
      chainId: chainId.toString(),
      lockId,
      status,
      balance,
      usdValue,
      tokenAddress,
      withdrawalConfirmed: false,
      withdrawalFailed: false,
      lastUpdated: Date.now(),
    };

    this.stateStore.updateState(chainId, lockId, state);

    logger.debug("[IndexerService] State store after update:", {
      totalStates: this.stateStore.getAllStates().length,
      states: this.stateStore.getAllStates(),
    });
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

  public getStateStore(): LockStateStore {
    return this.stateStore;
  }
}

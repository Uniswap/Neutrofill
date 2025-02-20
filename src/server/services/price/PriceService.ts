import EventEmitter from "node:events";
import {
  SUPPORTED_CHAINS,
  type SupportedChainId,
} from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { CoinGeckoProvider } from "./CoinGeckoProvider.js";

interface PriceData {
  price: number;
  lastUpdated: number;
}

export class PriceService extends EventEmitter {
  private prices: Map<SupportedChainId, PriceData>;
  private logger: Logger;
  private provider: CoinGeckoProvider;
  private updateInterval: NodeJS.Timeout | null;
  private readonly UPDATE_INTERVAL = 10000; // 10 seconds

  constructor(apiKey?: string) {
    super();
    this.prices = new Map();
    this.logger = new Logger("PriceService");
    this.provider = new CoinGeckoProvider(apiKey);
    this.updateInterval = null;
  }

  public start(): void {
    // Initial price fetch
    this.updatePrices().catch((error) => {
      this.logger.error("Failed to fetch initial prices:", error);
    });

    // Set up periodic updates
    this.updateInterval = setInterval(() => {
      this.updatePrices().catch((error) => {
        this.logger.error("Failed to update prices:", error);
      });
    }, this.UPDATE_INTERVAL);
  }

  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  public getPrice(chainId: SupportedChainId): number {
    const priceData = this.prices.get(chainId);
    if (!priceData) {
      throw new Error(`No price data available for chain ${chainId}`);
    }

    // Check if price is stale (older than 30 seconds)
    const stalePriceThreshold = 30000; // 30 seconds
    if (Date.now() - priceData.lastUpdated > stalePriceThreshold) {
      this.logger.warn(`Price data for chain ${chainId} is stale`);
    }

    return priceData.price;
  }

  private async updatePrices(): Promise<void> {
    for (const chainId of SUPPORTED_CHAINS) {
      try {
        const { price } = await this.provider.getEthPrice(chainId);
        this.prices.set(chainId, {
          price,
          lastUpdated: Date.now(),
        });
        this.logger.debug(`Updated ETH price for chain ${chainId}: $${price}`);

        // Emit the price update
        this.emit("price_update", chainId, price);
      } catch (error) {
        this.logger.error(
          `Failed to update price for chain ${chainId}:`,
          error
        );
        // Don't update the price if there's an error, keep using the old one
      }
    }
  }
}

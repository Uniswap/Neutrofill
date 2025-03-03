import { EventEmitter } from "node:events";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance, ChainBalance } from "../../types/balance.js";
import { Logger } from "../../utils/logger.js";
import type { PriceService } from "../price/PriceService.js";
import type { TokenBalanceService } from "./TokenBalanceService.js";

interface InternalAggregateBalances extends AggregateBalance {
  // Per-chain balances
  chainBalances: Record<SupportedChainId, ChainBalance>;
}

export class AggregateBalanceService extends EventEmitter {
  private logger: Logger;
  private aggregateBalances: InternalAggregateBalances | null = null;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 2500; // 2.5 seconds

  constructor(
    private readonly tokenBalanceService: TokenBalanceService,
    private readonly priceService: PriceService
  ) {
    super();
    this.logger = new Logger("AggregateBalanceService");
  }

  public start(): void {
    if (this.updateInterval) {
      return;
    }

    // Delay the initial start by 10 seconds to allow price data to be fetched
    setTimeout(() => {
      // Initial balance calculation
      this.calculateAggregateBalances().catch((error) => {
        this.logger.error(
          "Failed to calculate initial aggregate balances:",
          error
        );
      });

      // Set up periodic updates
      this.updateInterval = setInterval(() => {
        this.calculateAggregateBalances().catch((error) => {
          this.logger.error("Failed to update aggregate balances:", error);
        });
      }, this.UPDATE_INTERVAL);

      this.logger.info("Aggregate balance monitoring started");
    }, 10000); // 10 second delay
  }

  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.logger.info("Aggregate balance monitoring stopped");
    }
  }

  public getAggregateBalances(): AggregateBalance | null {
    return this.aggregateBalances;
  }

  private async calculateAggregateBalances(): Promise<void> {
    try {
      const newAggregateBalances: InternalAggregateBalances = {
        chainBalances: {} as Record<
          SupportedChainId,
          (typeof newAggregateBalances.chainBalances)[SupportedChainId]
        >,
        tokenBalances: {
          tokens: {
            ETH: "0",
            WETH: "0",
            USDC: "0",
          },
          usd: {
            ETH: 0,
            WETH: 0,
            USDC: 0,
          },
          percentages: {
            ETH: 0,
            WETH: 0,
            USDC: 0,
          },
        },
        totalBalance: 0,
        lastUpdated: Date.now(),
      };

      // Calculate balances for each chain
      for (const chainId of Object.keys(
        this.tokenBalanceService.getClients()
      )) {
        const numericChainId = Number(chainId) as SupportedChainId;
        const balances = this.tokenBalanceService.getBalances(numericChainId);

        // Skip if balances aren't available yet
        if (!balances) {
          continue;
        }

        // Try to get price, skip chain if not available yet
        let ethPrice: number;
        try {
          ethPrice = this.priceService.getPrice(numericChainId);
        } catch (error) {
          this.logger.debug(
            `Price not yet available for chain ${numericChainId}, skipping...`
          );
          continue;
        }

        // Store raw balances and calculate USD values
        const ethBalanceUsd = (Number(balances.ETH) * ethPrice) / 1e18;
        const wethBalanceUsd = (Number(balances.WETH) * ethPrice) / 1e18;
        const usdcBalanceUsd = Number(balances.USDC) / 1e6; // USDC has 6 decimals

        // Update chain-specific balances
        newAggregateBalances.chainBalances[numericChainId] = {
          tokens: {
            ETH: balances.ETH.toString(),
            WETH: balances.WETH.toString(),
            USDC: balances.USDC.toString(),
          },
          usd: {
            ETH: ethBalanceUsd,
            WETH: wethBalanceUsd,
            USDC: usdcBalanceUsd,
            total: ethBalanceUsd + wethBalanceUsd + usdcBalanceUsd,
          },
          percentageOfTotal: 0, // Will be calculated after total is known
        };

        // Update token totals (both raw and USD)
        newAggregateBalances.tokenBalances.tokens.ETH = (
          BigInt(newAggregateBalances.tokenBalances.tokens.ETH) +
          BigInt(balances.ETH)
        ).toString();
        newAggregateBalances.tokenBalances.tokens.WETH = (
          BigInt(newAggregateBalances.tokenBalances.tokens.WETH) +
          BigInt(balances.WETH)
        ).toString();
        newAggregateBalances.tokenBalances.tokens.USDC = (
          BigInt(newAggregateBalances.tokenBalances.tokens.USDC) +
          BigInt(balances.USDC)
        ).toString();

        newAggregateBalances.tokenBalances.usd.ETH += ethBalanceUsd;
        newAggregateBalances.tokenBalances.usd.WETH += wethBalanceUsd;
        newAggregateBalances.tokenBalances.usd.USDC += usdcBalanceUsd;
      }

      // Calculate total balance in USD
      newAggregateBalances.totalBalance =
        newAggregateBalances.tokenBalances.usd.ETH +
        newAggregateBalances.tokenBalances.usd.WETH +
        newAggregateBalances.tokenBalances.usd.USDC;

      // Calculate percentages for each chain and token
      if (newAggregateBalances.totalBalance > 0) {
        // Chain percentages
        for (const chainId of Object.keys(newAggregateBalances.chainBalances)) {
          const numericChainId = Number(chainId) as SupportedChainId;
          newAggregateBalances.chainBalances[numericChainId].percentageOfTotal =
            (newAggregateBalances.chainBalances[numericChainId].usd.total /
              newAggregateBalances.totalBalance) *
            100;
        }

        // Token percentages
        newAggregateBalances.tokenBalances.percentages = {
          ETH:
            (newAggregateBalances.tokenBalances.usd.ETH /
              newAggregateBalances.totalBalance) *
            100,
          WETH:
            (newAggregateBalances.tokenBalances.usd.WETH /
              newAggregateBalances.totalBalance) *
            100,
          USDC:
            (newAggregateBalances.tokenBalances.usd.USDC /
              newAggregateBalances.totalBalance) *
            100,
        };
      } else {
        // Zero out percentages when total is 0
        for (const chainId of Object.keys(newAggregateBalances.chainBalances)) {
          const numericChainId = Number(chainId) as SupportedChainId;
          newAggregateBalances.chainBalances[numericChainId].percentageOfTotal =
            0;
        }
        newAggregateBalances.tokenBalances.percentages = {
          ETH: 0,
          WETH: 0,
          USDC: 0,
        };
      }

      this.aggregateBalances = newAggregateBalances;

      // Emit the update event
      this.emit("aggregate_balance_update", newAggregateBalances);
    } catch (error) {
      this.logger.error("Error calculating aggregate balances:", error);
    }
  }
}

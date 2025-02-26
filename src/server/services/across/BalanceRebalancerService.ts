import { EventEmitter } from "node:events";
import type { Address, PublicClient, WalletClient } from "viem";
import { Logger } from "../../utils/logger.js";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalanceService } from "../balance/AggregateBalanceService.js";
import { RebalanceService } from "./RebalanceService.js";
import { RebalanceOperationStore } from "./RebalanceOperationStore.js";
import type {
  RebalanceConfig,
  ChainRebalanceConfig,
  RebalanceOperation,
} from "../../types/rebalance.js";
import type { AggregateBalance } from "../../types/balance.js";

/**
 * Service for automatically rebalancing funds across chains based on configured thresholds
 */
export class BalanceRebalancerService extends EventEmitter {
  private readonly logger: Logger;
  private readonly rebalanceService: RebalanceService;
  private readonly operationStore: RebalanceOperationStore;
  private config: RebalanceConfig;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 30000; // 30 seconds
  private readonly MAX_OPERATION_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days

  constructor(
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>,
    private readonly aggregateBalanceService: AggregateBalanceService,
    accountAddress: Address,
    config: RebalanceConfig,
    acrossUniqueIdentifier?: string
  ) {
    super();
    this.logger = new Logger("BalanceRebalancerService");
    this.rebalanceService = new RebalanceService(
      publicClients,
      walletClients,
      accountAddress,
      acrossUniqueIdentifier
    );
    this.operationStore = new RebalanceOperationStore();
    this.config = config;

    // Listen for balance updates
    this.aggregateBalanceService.on(
      "aggregate_balance_update",
      this.onBalanceUpdate.bind(this)
    );
  }

  /**
   * Start the rebalancing service
   */
  public start(): void {
    if (this.updateInterval) {
      this.logger.warn("BalanceRebalancerService already running");
      return;
    }

    // Process any pending operations immediately
    void this.processOperations();

    // Then process every 30 seconds
    this.updateInterval = setInterval(() => {
      void this.processOperations();
    }, this.UPDATE_INTERVAL);

    this.logger.info("Balance rebalancer service started");
  }

  /**
   * Stop the rebalancing service
   */
  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.logger.info("Balance rebalancer service stopped");
    }
  }

  /**
   * Update the rebalance configuration
   */
  public updateConfig(config: RebalanceConfig): void {
    this.config = config;
    this.logger.info("Updated rebalance configuration");
  }

  /**
   * Get the current rebalance configuration
   */
  public getConfig(): RebalanceConfig {
    return this.config;
  }

  /**
   * Get all rebalance operations
   */
  public getOperations(): RebalanceOperation[] {
    return this.operationStore.getAllOperations();
  }

  /**
   * Handle balance updates from the AggregateBalanceService
   */
  private onBalanceUpdate(balances: AggregateBalance): void {
    if (!this.config.global.enabled) {
      return;
    }

    // Only check for rebalancing needs if no operation is currently in progress
    if (!this.operationStore.isProcessingLocked()) {
      void this.checkRebalanceNeeded(balances);
    }
  }

  /**
   * Check if rebalancing is needed based on current balances
   */
  private async checkRebalanceNeeded(
    balances: AggregateBalance
  ): Promise<void> {
    try {
      // Skip if cooldown period hasn't elapsed
      if (
        !this.operationStore.hasCooldownElapsed(
          this.config.global.cooldownPeriodMs
        )
      ) {
        return;
      }

      // Skip if total balance is too low
      if (balances.totalBalance < this.config.global.minRebalanceUsdValue) {
        return;
      }

      // Find chains that are below their trigger thresholds
      const chainsNeedingFunds: Array<{
        chainId: SupportedChainId;
        currentPercentage: number;
        targetPercentage: number;
        deficit: number;
        deficitUsd: number;
      }> = [];

      // Find chains that have excess funds
      const chainsWithExcess: Array<{
        chainId: SupportedChainId;
        currentPercentage: number;
        targetPercentage: number;
        excess: number;
        excessUsd: number;
        sourcePriority: number;
      }> = [];

      // Analyze each chain's balance
      for (const [chainIdStr, chainConfig] of Object.entries(
        this.config.chains
      )) {
        const chainId = Number(chainIdStr) as SupportedChainId;

        // Skip if chain doesn't have balance data yet
        if (!balances.chainBalances[chainId]) {
          continue;
        }

        const currentPercentage =
          balances.chainBalances[chainId].percentageOfTotal;
        const targetPercentage = chainConfig.targetPercentage;
        const triggerThreshold = chainConfig.triggerThreshold;

        // Check if chain is below trigger threshold and can be a destination
        if (
          chainConfig.canBeDestination &&
          currentPercentage < targetPercentage - triggerThreshold
        ) {
          const deficit = targetPercentage - currentPercentage;
          const deficitUsd = (deficit / 100) * balances.totalBalance;

          chainsNeedingFunds.push({
            chainId,
            currentPercentage,
            targetPercentage,
            deficit,
            deficitUsd,
          });
        }
        // Check if chain has excess funds and can be a source (sourcePriority > 0)
        else if (
          chainConfig.sourcePriority > 0 &&
          currentPercentage > targetPercentage + triggerThreshold
        ) {
          const excess = currentPercentage - targetPercentage;
          const excessUsd = (excess / 100) * balances.totalBalance;

          chainsWithExcess.push({
            chainId,
            currentPercentage,
            targetPercentage,
            excess,
            excessUsd,
            sourcePriority: chainConfig.sourcePriority,
          });
        }
      }

      // If no chains need funds or no chains have excess, no rebalancing needed
      if (chainsNeedingFunds.length === 0 || chainsWithExcess.length === 0) {
        return;
      }

      // Sort chains needing funds by deficit (largest deficit first)
      chainsNeedingFunds.sort((a, b) => b.deficit - a.deficit);

      // Sort chains with excess by source priority (lowest number first) and then by excess (largest excess first)
      chainsWithExcess.sort((a, b) => {
        // First sort by priority (lower number = higher priority)
        if (a.sourcePriority !== b.sourcePriority) {
          return a.sourcePriority - b.sourcePriority;
        }
        // Then sort by excess amount (larger excess = higher priority)
        return b.excess - a.excess;
      });

      // Get the chain with the largest deficit
      const destinationChain = chainsNeedingFunds[0];

      // Get the highest priority source chain
      const sourceChain = chainsWithExcess[0];

      // Determine which token to rebalance
      const tokenToRebalance = this.selectTokenForRebalance(
        sourceChain.chainId,
        destinationChain.chainId,
        balances
      );

      if (!tokenToRebalance) {
        this.logger.debug("No suitable token found for rebalancing");
        return;
      }

      // Calculate the amount to rebalance
      const amountToRebalanceUsd = Math.min(
        destinationChain.deficitUsd,
        sourceChain.excessUsd,
        this.config.global.maxRebalanceUsdValue
      );

      // Convert USD amount to token amount
      const tokenPrice = this.getTokenPrice(
        tokenToRebalance,
        sourceChain.chainId,
        balances
      );
      const tokenDecimals = this.getTokenDecimals(tokenToRebalance);

      if (!tokenPrice) {
        this.logger.error(`Could not determine price for ${tokenToRebalance}`);
        return;
      }

      // Calculate token amount based on USD value and token price
      const tokenAmount = amountToRebalanceUsd / tokenPrice;

      // Create rebalance operation
      const operation = this.operationStore.createOperation(
        sourceChain.chainId,
        destinationChain.chainId,
        tokenToRebalance,
        tokenAmount,
        amountToRebalanceUsd
      );

      this.logger.info(
        `Created rebalance operation: ${tokenAmount} ${tokenToRebalance} (${amountToRebalanceUsd} USD) from chain ${sourceChain.chainId} to chain ${destinationChain.chainId}`,
        {
          operation,
          sourceChain: {
            chainId: sourceChain.chainId,
            currentPercentage: sourceChain.currentPercentage,
            targetPercentage: sourceChain.targetPercentage,
            excess: sourceChain.excess,
            sourcePriority: sourceChain.sourcePriority,
          },
          destinationChain: {
            chainId: destinationChain.chainId,
            currentPercentage: destinationChain.currentPercentage,
            targetPercentage: destinationChain.targetPercentage,
            deficit: destinationChain.deficit,
            canBeDestination:
              this.config.chains[destinationChain.chainId].canBeDestination,
          },
        }
      );

      // Emit event for the new operation
      this.emit("rebalance_operation_created", operation);
    } catch (error) {
      this.logger.error("Error checking if rebalance is needed:", error);
    }
  }

  /**
   * Process pending rebalance operations
   */
  private async processOperations(): Promise<void> {
    try {
      // Clear old operations
      this.operationStore.clearOldOperations(this.MAX_OPERATION_AGE);

      // Skip if global rebalancing is disabled
      if (!this.config.global.enabled) {
        return;
      }

      // Skip if already processing
      if (this.operationStore.isProcessingLocked()) {
        return;
      }

      // Get the next pending operation
      const operation = this.operationStore.getNextPendingOperation();
      if (!operation) {
        return;
      }

      // Try to acquire the processing lock
      if (!this.operationStore.tryAcquireProcessingLock()) {
        return;
      }

      try {
        // Update operation status
        this.operationStore.updateOperation(operation.id, {
          status: "Processing",
        });

        this.logger.info(
          `Processing rebalance operation ${operation.id}`,
          operation
        );

        // Execute the rebalance
        const txHash = await this.rebalanceService.rebalanceToken(
          operation.sourceChainId,
          operation.destinationChainId,
          operation.token,
          operation.amount
        );

        // Update operation with transaction hash
        this.operationStore.updateOperation(operation.id, {
          status: "Completed",
          txHash,
          completedAt: Date.now(),
        });

        // Update last rebalance time
        this.operationStore.updateLastRebalanceTime();

        this.logger.info(`Completed rebalance operation ${operation.id}`, {
          operationId: operation.id,
          txHash,
        });

        // Emit event for the completed operation
        this.emit("rebalance_operation_completed", {
          ...operation,
          status: "Completed",
          txHash,
          completedAt: Date.now(),
        });
      } catch (error) {
        this.logger.error(
          `Failed to process rebalance operation ${operation.id}:`,
          error
        );

        // Update operation as failed
        this.operationStore.updateOperation(operation.id, {
          status: "Failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });

        // Emit event for the failed operation
        this.emit("rebalance_operation_failed", {
          ...operation,
          status: "Failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });
      } finally {
        // Release the processing lock
        this.operationStore.releaseProcessingLock();
      }
    } catch (error) {
      this.logger.error("Error processing rebalance operations:", error);
      this.operationStore.releaseProcessingLock();
    }
  }

  /**
   * Select the best token to use for rebalancing based on configured priorities
   */
  private selectTokenForRebalance(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    balances: AggregateBalance
  ): string | null {
    const sourceChainConfig = this.config.chains[sourceChainId];
    const destinationChainConfig = this.config.chains[destinationChainId];

    if (!sourceChainConfig || !destinationChainConfig) {
      return null;
    }

    // Get available tokens on the source chain with sufficient balance
    const availableTokens = Object.entries(sourceChainConfig.tokens)
      .filter(([token, config]) => {
        // Check if token is enabled for rebalancing
        if (!config.enabled) {
          return false;
        }

        // Check if token has sufficient balance on source chain
        const tokenBalance = this.getTokenBalance(
          token,
          sourceChainId,
          balances
        );
        const tokenBalanceUsd = this.getTokenBalanceUsd(
          token,
          sourceChainId,
          balances
        );

        return (
          tokenBalance &&
          tokenBalanceUsd &&
          tokenBalanceUsd > this.config.global.minRebalanceUsdValue
        );
      })
      .map(([token, config]) => ({
        token,
        priority: config.priority,
      }));

    // Sort by priority (highest first)
    availableTokens.sort((a, b) => b.priority - a.priority);

    // Return the highest priority token, or null if none available
    return availableTokens.length > 0 ? availableTokens[0].token : null;
  }

  /**
   * Helper to get token balance safely with type checking
   */
  private getTokenBalance(
    token: string,
    chainId: SupportedChainId,
    balances: AggregateBalance
  ): string | undefined {
    if (token === "ETH" || token === "WETH" || token === "USDC") {
      return balances.chainBalances[chainId]?.tokens[token];
    }
    return undefined;
  }

  /**
   * Helper to get token balance USD value safely with type checking
   */
  private getTokenBalanceUsd(
    token: string,
    chainId: SupportedChainId,
    balances: AggregateBalance
  ): number | undefined {
    if (token === "ETH" || token === "WETH" || token === "USDC") {
      return balances.chainBalances[chainId]?.usd[token];
    }
    return undefined;
  }

  /**
   * Get the price of a token in USD
   */
  private getTokenPrice(
    token: string,
    chainId: SupportedChainId,
    balances: AggregateBalance
  ): number | null {
    try {
      if (token === "ETH" || token === "WETH") {
        // For ETH/WETH, we can calculate from the balance and USD value
        const ethBalance = balances.chainBalances[chainId]?.tokens.ETH;
        const ethUsd = balances.chainBalances[chainId]?.usd.ETH;

        if (ethBalance && ethUsd && BigInt(ethBalance) > 0n) {
          return (ethUsd * 1e18) / Number(ethBalance);
        }
      } else if (token === "USDC") {
        // USDC is approximately 1 USD
        return 1;
      }

      return null;
    } catch (error) {
      this.logger.error(`Error getting price for ${token}:`, error);
      return null;
    }
  }

  /**
   * Get the number of decimals for a token
   */
  private getTokenDecimals(token: string): number {
    switch (token) {
      case "ETH":
      case "WETH":
        return 18;
      case "USDC":
        return 6;
      default:
        return 18;
    }
  }
}

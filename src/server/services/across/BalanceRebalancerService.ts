import { EventEmitter } from "node:events";
import type { Address, PublicClient, WalletClient } from "viem";
import { Logger } from "../../utils/logger.js";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalanceService } from "../balance/AggregateBalanceService.js";
import type { RebalanceService } from "./RebalanceService.js";
import { RebalanceOperationStore } from "./RebalanceOperationStore.js";
import type {
  RebalanceConfig,
  ChainRebalanceConfig,
  RebalanceOperation,
} from "../../types/rebalance.js";
import type { AggregateBalance } from "../../types/balance.js";

/**
 * Tracks failed rebalance attempts to avoid continuous retries
 */
interface FailedRebalanceAttempt {
  sourceChainId: SupportedChainId;
  destinationChainId: SupportedChainId;
  token: string;
  amount: number;
  timestamp: number;
  reason: string;
  // Track the balances at the time of failure to detect significant changes
  sourceTokenBalance?: string;
  destinationTokenBalance?: string;
}

/**
 * Service for automatically rebalancing funds across chains based on configured thresholds
 */
export class BalanceRebalancerService extends EventEmitter {
  private readonly logger: Logger;
  private readonly rebalanceService: RebalanceService;
  private readonly operationStore: RebalanceOperationStore;
  private readonly aggregateBalanceService: AggregateBalanceService;
  private config: RebalanceConfig;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 30000; // 30 seconds
  private readonly MAX_OPERATION_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
  private readonly FAILED_ATTEMPT_EXPIRY = 30 * 60 * 1000; // 30 minutes
  private readonly BALANCE_CHANGE_THRESHOLD = 0.1; // 10% change in balance to retry
  private running = false;
  // Track failed rebalance attempts to avoid continuous retries
  private failedRebalanceAttempts: FailedRebalanceAttempt[] = [];

  constructor(
    accountAddress: Address,
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>,
    rebalanceService: RebalanceService,
    aggregateBalanceService: AggregateBalanceService,
    config: RebalanceConfig
  ) {
    super();
    this.logger = new Logger("BalanceRebalancerService");
    this.rebalanceService = rebalanceService;
    this.aggregateBalanceService = aggregateBalanceService;
    this.operationStore = new RebalanceOperationStore();
    this.config = config;

    // Listen for balance updates
    this.aggregateBalanceService.on(
      "aggregate_balance_update",
      this.onBalanceUpdate.bind(this)
    );
  }

  /**
   * Check if the service is currently running
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the rebalancing service
   */
  public start(): void {
    if (this.updateInterval) {
      this.logger.warn("BalanceRebalancerService already running");
      return;
    }

    this.logger.info("Starting BalanceRebalancerService");
    this.running = true;

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
      this.running = false;
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
   * Check if a rebalance attempt has failed recently
   */
  private hasRecentFailedAttempt(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    token: string,
    balances: AggregateBalance
  ): boolean {
    // Filter for recent failed attempts for this specific source, destination, and token
    const recentFailedAttempts = this.failedRebalanceAttempts.filter(
      (attempt) =>
        attempt.sourceChainId === sourceChainId &&
        attempt.destinationChainId === destinationChainId &&
        attempt.token === token &&
        Date.now() - attempt.timestamp < this.FAILED_ATTEMPT_EXPIRY &&
        attempt.reason.includes("AMOUNT_TOO_LOW") // Only track AMOUNT_TOO_LOW errors
    );

    if (recentFailedAttempts.length === 0) {
      return false; // No recent failures with AMOUNT_TOO_LOW
    }

    // Get the most recent failed attempt
    const lastFailedAttempt = recentFailedAttempts.sort(
      (a, b) => b.timestamp - a.timestamp
    )[0];

    // Get current balances
    const currentSourceTokenBalance = this.getTokenBalance(
      token,
      sourceChainId,
      balances
    );
    const currentDestinationTokenBalance = this.getTokenBalance(
      token,
      destinationChainId,
      balances
    );

    // If we don't have balance information, we can't make a good decision
    if (
      !currentSourceTokenBalance ||
      !currentDestinationTokenBalance ||
      !lastFailedAttempt.sourceTokenBalance ||
      !lastFailedAttempt.destinationTokenBalance
    ) {
      this.logger.debug(
        "Missing balance information to compare with failed attempt"
      );
      return true; // Be conservative and skip the rebalance
    }

    try {
      // Convert to BigInt for safe comparison
      const oldSourceBalance = BigInt(lastFailedAttempt.sourceTokenBalance);
      const newSourceBalance = BigInt(currentSourceTokenBalance);
      const oldDestBalance = BigInt(lastFailedAttempt.destinationTokenBalance);
      const newDestBalance = BigInt(currentDestinationTokenBalance);

      // Check if either balance is zero
      if (oldSourceBalance === 0n || oldDestBalance === 0n) {
        // If old balance was zero and new is not, that's a significant change
        if (
          (oldSourceBalance === 0n && newSourceBalance > 0n) ||
          (oldDestBalance === 0n && newDestBalance > 0n)
        ) {
          return false; // Allow rebalance
        }
      } else {
        // Calculate percentage changes
        const sourceChangeRatio = Math.abs(
          Number(newSourceBalance - oldSourceBalance) / Number(oldSourceBalance)
        );
        const destChangeRatio = Math.abs(
          Number(newDestBalance - oldDestBalance) / Number(oldDestBalance)
        );

        // If either balance has changed significantly, allow the rebalance
        if (
          sourceChangeRatio > this.BALANCE_CHANGE_THRESHOLD ||
          destChangeRatio > this.BALANCE_CHANGE_THRESHOLD
        ) {
          this.logger.debug(
            `Balance changed significantly (source: ${sourceChangeRatio.toFixed(2)}, dest: ${destChangeRatio.toFixed(2)}), allowing rebalance attempt`
          );
          return false;
        }
      }

      // If we get here, balances haven't changed enough to warrant retrying
      this.logger.debug(
        `Skipping rebalance due to recent AMOUNT_TOO_LOW error (${new Date(lastFailedAttempt.timestamp).toISOString()}) and no significant balance change`
      );
      return true;
    } catch (error) {
      this.logger.error("Error comparing balances:", error);
      return true; // Be conservative and skip the rebalance on error
    }
  }

  /**
   * Add a failed rebalance attempt to the tracking list
   */
  private addFailedAttempt(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    token: string,
    amount: number,
    reason: string,
    balances: AggregateBalance
  ): void {
    // Only track AMOUNT_TOO_LOW errors
    if (!reason.includes("AMOUNT_TOO_LOW")) {
      return;
    }

    const sourceTokenBalance = this.getTokenBalance(
      token,
      sourceChainId,
      balances
    );
    const destinationTokenBalance = this.getTokenBalance(
      token,
      destinationChainId,
      balances
    );

    const failedAttempt: FailedRebalanceAttempt = {
      sourceChainId,
      destinationChainId,
      token,
      amount,
      timestamp: Date.now(),
      reason,
      sourceTokenBalance,
      destinationTokenBalance,
    };

    this.failedRebalanceAttempts.push(failedAttempt);

    this.logger.info(
      `Tracked failed rebalance attempt for ${amount} ${token} from chain ${sourceChainId} to chain ${destinationChainId} due to: ${reason}`,
      {
        sourceTokenBalance,
        destinationTokenBalance,
        failedAttemptsCount: this.failedRebalanceAttempts.length,
      }
    );

    // Clean up expired failed attempts
    this.cleanupExpiredFailedAttempts();
  }

  /**
   * Clean up expired failed attempts
   */
  private cleanupExpiredFailedAttempts(): void {
    const now = Date.now();
    const expiredCutoff = now - this.FAILED_ATTEMPT_EXPIRY;

    const initialCount = this.failedRebalanceAttempts.length;
    this.failedRebalanceAttempts = this.failedRebalanceAttempts.filter(
      (attempt) => attempt.timestamp > expiredCutoff
    );

    const removedCount = initialCount - this.failedRebalanceAttempts.length;
    if (removedCount > 0) {
      this.logger.debug(
        `Cleaned up ${removedCount} expired failed rebalance attempts`
      );
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
        token?: string; // Optional token that needs rebalancing
        tokenCurrentPercentage?: number; // Current percentage of token on this chain
        tokenTargetPercentage?: number; // Target percentage for this token
      }> = [];

      // Find chains that have excess funds
      const chainsWithExcess: Array<{
        chainId: SupportedChainId;
        currentPercentage: number;
        targetPercentage: number;
        excess: number;
        excessUsd: number;
        sourcePriority: number;
        availableTokens: Array<{
          token: string;
          balanceUsd: number;
          rawBalance: string;
          priority: number;
          excessPercentage?: number; // Excess percentage for this specific token
        }>;
      }> = [];

      // Calculate token-specific percentages across chains
      const tokenPercentagesByChain: Record<
        string,
        Record<SupportedChainId, number>
      > = {
        ETH: {} as Record<SupportedChainId, number>,
        WETH: {} as Record<SupportedChainId, number>,
        USDC: {} as Record<SupportedChainId, number>,
      };

      // Calculate the total USD value for each token across all chains
      const tokenTotalUsd = {
        ETH: balances.tokenBalances.usd.ETH,
        WETH: balances.tokenBalances.usd.WETH,
        USDC: balances.tokenBalances.usd.USDC,
      };

      // Calculate the percentage of each token on each chain
      for (const [chainIdStr, chainConfig] of Object.entries(
        this.config.chains
      )) {
        const chainId = Number(chainIdStr) as SupportedChainId;

        // Skip if chain doesn't have balance data yet
        if (!balances.chainBalances[chainId]) {
          continue;
        }

        // Calculate token percentages for this chain
        for (const token of ["ETH", "WETH", "USDC"] as const) {
          const tokenUsdOnChain = balances.chainBalances[chainId].usd[token];
          const tokenTotalUsdAllChains = tokenTotalUsd[token];

          if (tokenTotalUsdAllChains > 0) {
            tokenPercentagesByChain[token][chainId] =
              (tokenUsdOnChain / tokenTotalUsdAllChains) * 100;
          } else {
            tokenPercentagesByChain[token][chainId] = 0;
          }
        }
      }

      this.logger.debug("Token percentages by chain:", tokenPercentagesByChain);

      // Analyze each chain's balance - both overall and token-specific
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
          currentPercentage < triggerThreshold
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

        // Check token-specific balances for this chain
        for (const [tokenSymbol, tokenConfig] of Object.entries(
          chainConfig.tokens
        )) {
          if (!tokenConfig.enabled) {
            continue;
          }

          // Skip if token doesn't have balance data
          if (
            !tokenPercentagesByChain[tokenSymbol] ||
            !tokenPercentagesByChain[tokenSymbol][chainId]
          ) {
            continue;
          }

          const tokenCurrentPercentage =
            tokenPercentagesByChain[tokenSymbol][chainId];
          const tokenTargetPercentage =
            tokenConfig.targetPercentage || chainConfig.targetPercentage;
          const tokenTriggerThreshold =
            tokenConfig.triggerThreshold || chainConfig.triggerThreshold;

          // Check if this specific token is below its threshold on this chain
          if (
            chainConfig.canBeDestination &&
            tokenCurrentPercentage < tokenTriggerThreshold
          ) {
            const tokenDeficit = tokenTargetPercentage - tokenCurrentPercentage;
            const tokenDeficitUsd =
              (tokenDeficit / 100) *
              tokenTotalUsd[tokenSymbol as keyof typeof tokenTotalUsd];

            // Add this chain to the list of chains needing funds, specifically for this token
            chainsNeedingFunds.push({
              chainId,
              currentPercentage, // Overall chain percentage
              targetPercentage, // Overall chain target
              deficit: tokenDeficit, // Token-specific deficit
              deficitUsd: tokenDeficitUsd, // Token-specific deficit in USD
              token: tokenSymbol, // Specify which token needs rebalancing
              tokenCurrentPercentage,
              tokenTargetPercentage,
            });
          }
        }

        // Check if chain has excess funds and can be a source (sourcePriority > 0)
        if (
          chainConfig.sourcePriority > 0 &&
          currentPercentage > targetPercentage
        ) {
          const excess = currentPercentage - targetPercentage;
          const excessUsd = (excess / 100) * balances.totalBalance;

          // Get available tokens on this chain that can be used for rebalancing
          const availableTokens = Object.entries(chainConfig.tokens)
            .filter(([token, config]) => {
              // Check if token is enabled for rebalancing
              if (!config.enabled) {
                return false;
              }

              // Check if token has sufficient balance on source chain
              const tokenBalance = this.getTokenBalance(
                token,
                chainId,
                balances
              );
              const tokenBalanceUsd = this.getTokenBalanceUsd(
                token,
                chainId,
                balances
              );

              return (
                tokenBalance &&
                tokenBalanceUsd &&
                tokenBalanceUsd > this.config.global.minRebalanceUsdValue
              );
            })
            .map(([token, config]) => {
              // Calculate token-specific excess if applicable
              const tokenCurrentPercentage =
                tokenPercentagesByChain[token]?.[chainId] || 0;
              const tokenTargetPercentage =
                config.targetPercentage || chainConfig.targetPercentage;
              const tokenExcessPercentage =
                tokenCurrentPercentage > tokenTargetPercentage
                  ? tokenCurrentPercentage - tokenTargetPercentage
                  : 0;

              return {
                token,
                balanceUsd:
                  this.getTokenBalanceUsd(token, chainId, balances) || 0,
                rawBalance:
                  this.getTokenBalance(token, chainId, balances) || "0",
                priority: config.priority,
                excessPercentage: tokenExcessPercentage,
              };
            });

          // Only consider this chain if it has at least one available token
          if (availableTokens.length > 0) {
            chainsWithExcess.push({
              chainId,
              currentPercentage,
              targetPercentage,
              excess,
              excessUsd,
              sourcePriority: chainConfig.sourcePriority,
              availableTokens,
            });
          }
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

      // If this is a token-specific deficit, prioritize that token
      const specificToken = destinationChain.token;

      // Get the highest priority source chain
      const sourceChain = chainsWithExcess[0];

      if (!sourceChain) {
        this.logger.debug("No source chains with available tokens found");
        return;
      }

      // If we have a specific token that needs rebalancing, prioritize that token
      let tokenToRebalance: string;
      let tokenInfo: (typeof sourceChain.availableTokens)[0];

      if (specificToken) {
        // Find this token in the available tokens on the source chain
        const specificTokenInfo = sourceChain.availableTokens.find(
          (t) =>
            t.token === specificToken &&
            t.excessPercentage &&
            t.excessPercentage > 0
        );

        if (specificTokenInfo) {
          tokenToRebalance = specificToken;
          tokenInfo = specificTokenInfo;
        } else {
          // If the specific token isn't available with excess, fall back to normal priority-based selection
          sourceChain.availableTokens.sort((a, b) => b.priority - a.priority);
          tokenInfo = sourceChain.availableTokens[0];
          tokenToRebalance = tokenInfo.token;
        }
      } else {
        // Sort available tokens by priority (highest first)
        sourceChain.availableTokens.sort((a, b) => b.priority - a.priority);
        tokenInfo = sourceChain.availableTokens[0];
        tokenToRebalance = tokenInfo.token;
      }

      // Check if there's a recent failed attempt for this rebalance
      if (
        this.hasRecentFailedAttempt(
          sourceChain.chainId,
          destinationChain.chainId,
          tokenToRebalance,
          balances
        )
      ) {
        this.logger.info(
          `Skipping rebalance from chain ${sourceChain.chainId} to chain ${destinationChain.chainId} due to recent failed attempt`
        );
        return;
      }

      // Calculate the amount to rebalance, considering the actual token balance
      const maxTokenUsd = tokenInfo.balanceUsd;
      const amountToRebalanceUsd = Math.min(
        destinationChain.deficitUsd,
        sourceChain.excessUsd,
        maxTokenUsd,
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

      // Check if the amount is sufficient for Across protocol
      try {
        // Get fee estimate to check minimum limits
        const feeEstimate = await this.rebalanceService.getRebalanceFeeEstimate(
          sourceChain.chainId,
          destinationChain.chainId,
          tokenToRebalance,
          tokenAmount
        );

        // Include minimum amount information in logs
        this.logger.info(
          `Rebalance fee estimate for ${tokenAmount} ${tokenToRebalance}: ${feeEstimate.fee} ${feeEstimate.feeToken}`,
          {
            estimatedFillTime: feeEstimate.estimatedFillTime,
            maxDepositInstant: feeEstimate.maxDepositInstant,
            maxDepositShortDelay: feeEstimate.maxDepositShortDelay,
            maxDeposit: feeEstimate.maxDeposit,
          }
        );

        // Create rebalance operation
        const operation = this.operationStore.createOperation(
          sourceChain.chainId,
          destinationChain.chainId,
          tokenToRebalance,
          tokenAmount,
          amountToRebalanceUsd
        );

        // Update last rebalance time to prevent creating multiple operations in rapid succession
        this.operationStore.updateLastRebalanceTime();

        // Include token-specific information in the log if this was a token-specific rebalance
        const logDetails: Record<string, unknown> = {
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
        };

        // Add token-specific details if applicable
        if (destinationChain.token) {
          logDetails.tokenSpecificRebalance = {
            token: destinationChain.token,
            currentPercentage: destinationChain.tokenCurrentPercentage,
            targetPercentage: destinationChain.tokenTargetPercentage,
          };
        }

        this.logger.info(
          `Created rebalance operation: ${tokenAmount} ${tokenToRebalance} (${amountToRebalanceUsd} USD) from chain ${sourceChain.chainId} to chain ${destinationChain.chainId}`,
          logDetails
        );

        // Emit event for the new operation
        this.emit("rebalance_operation_created", operation);
      } catch (error) {
        // If there's an error with the fee estimate (e.g., amount too low), log it and don't create the operation
        this.logger.warn(
          `Skipping rebalance operation due to fee estimation error: ${error instanceof Error ? error.message : String(error)}`
        );
        const currentBalances =
          this.aggregateBalanceService.getAggregateBalances();
        if (currentBalances) {
          this.addFailedAttempt(
            sourceChain.chainId,
            destinationChain.chainId,
            tokenToRebalance,
            tokenAmount,
            error instanceof Error ? error.message : String(error),
            currentBalances
          );
        } else {
          this.logger.warn(
            "Could not track failed attempt: no aggregate balances available"
          );
        }
      }
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

        // Add failed attempt to tracking list
        const currentBalances =
          this.aggregateBalanceService.getAggregateBalances();
        if (currentBalances) {
          this.addFailedAttempt(
            operation.sourceChainId,
            operation.destinationChainId,
            operation.token,
            operation.amount,
            error instanceof Error ? error.message : String(error),
            currentBalances
          );
        } else {
          this.logger.warn(
            "Could not track failed attempt: no aggregate balances available"
          );
        }
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

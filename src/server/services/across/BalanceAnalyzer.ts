import { Logger } from "../../utils/logger.js";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import type {
  RebalanceConfig,
  RebalanceOperation,
} from "../../types/rebalance.js";
import { RebalanceFailureTracker } from "./RebalanceFailureTracker.js";
import type { RebalanceOperationStore } from "./RebalanceOperationStore.js";
import type { RebalanceService } from "./RebalanceService.js";
import { BalanceCalculator } from "./BalanceCalculator.js";
import { RebalanceDecisionMaker } from "./RebalanceDecisionMaker.js";

/**
 * Service for analyzing balances and determining rebalance needs
 */
export class BalanceAnalyzer {
  private readonly logger: Logger;
  private readonly failureTracker: RebalanceFailureTracker;
  private readonly rebalanceService: RebalanceService;
  private readonly operationStore: RebalanceOperationStore;
  private readonly balanceCalculator: BalanceCalculator;
  private readonly decisionMaker: RebalanceDecisionMaker;
  private config: RebalanceConfig;

  constructor(
    rebalanceService: RebalanceService,
    operationStore: RebalanceOperationStore,
    config: RebalanceConfig
  ) {
    this.logger = new Logger("BalanceAnalyzer");
    this.failureTracker = new RebalanceFailureTracker();
    this.rebalanceService = rebalanceService;
    this.operationStore = operationStore;
    this.config = config;

    // Initialize the balance calculator and decision maker
    this.balanceCalculator = new BalanceCalculator(config);
    this.decisionMaker = new RebalanceDecisionMaker(
      config.global.minRebalanceUsdValue,
      config.global.maxRebalanceUsdValue
    );
  }

  /**
   * Update the rebalance configuration
   */
  public updateConfig(config: RebalanceConfig): void {
    this.config = config;
    this.balanceCalculator.updateConfig(config);
    this.decisionMaker.updateConfig(
      config.global.minRebalanceUsdValue,
      config.global.maxRebalanceUsdValue
    );
  }

  /**
   * Check if rebalancing is needed based on current balances
   */
  public async checkRebalanceNeeded(
    balances: AggregateBalance
  ): Promise<RebalanceOperation | undefined> {
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

      // Calculate token-specific percentages across chains
      const tokenPercentagesByChain =
        this.balanceCalculator.calculateTokenPercentagesByChain(balances);

      // Analyze each chain's balance - both overall and token-specific
      const { chainsNeedingFunds, chainsWithExcess } =
        this.balanceCalculator.analyzeChainBalances(
          balances,
          tokenPercentagesByChain
        );

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

      // Determine the token to rebalance
      const { tokenToRebalance, tokenInfo } =
        this.decisionMaker.selectTokenToRebalance(sourceChain, specificToken);

      // Check if there's a similar pending operation
      if (
        this.operationStore.hasSimilarPendingOperation(
          sourceChain.chainId,
          destinationChain.chainId,
          tokenToRebalance
        )
      ) {
        this.logger.info(
          `Skipping rebalance from chain ${sourceChain.chainId} to chain ${destinationChain.chainId} for token ${tokenToRebalance} due to similar pending operation`
        );
        return;
      }

      // Check if there's a recent failed attempt for this rebalance
      if (
        this.failureTracker.hasRecentFailedAttempt(
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

      // Calculate the amount to rebalance
      const { amountToRebalanceUsd, tokenAmount } =
        this.decisionMaker.calculateRebalanceAmount(
          destinationChain,
          sourceChain,
          tokenInfo,
          tokenToRebalance,
          balances
        );

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

        return operation;
      } catch (error) {
        // If there's an error with the fee estimate (e.g., amount too low), log it and don't create the operation
        this.logger.warn(
          `Skipping rebalance operation due to fee estimation error: ${error instanceof Error ? error.message : String(error)}`
        );
        this.failureTracker.addFailedAttempt(
          sourceChain.chainId,
          destinationChain.chainId,
          tokenToRebalance,
          tokenAmount,
          error instanceof Error ? error.message : String(error),
          balances
        );
        return;
      }
    } catch (error) {
      this.logger.error("Error checking if rebalance is needed:", error);
    }
  }

  /**
   * Get the failure tracker instance
   */
  public getFailureTracker(): RebalanceFailureTracker {
    return this.failureTracker;
  }
}

import type { SupportedChainId } from "../../config/constants.js";
import { DEFAULT_REBALANCE_CONFIG } from "../../config/rebalance.js";
import type { AggregateBalance } from "../../types/balance.js";
import type {
  RebalanceConfig,
  RebalanceOperation,
} from "../../types/rebalance.js";
import { Logger } from "../../utils/logger.js";
import { BalanceCalculator } from "./BalanceCalculator.js";
import { RebalanceDecisionMaker } from "./RebalanceDecisionMaker.js";
import { RebalanceFailureTracker } from "./RebalanceFailureTracker.js";
import type { RebalanceOperationStore } from "./RebalanceOperationStore.js";
import type { RebalanceService } from "./RebalanceService.js";
import { TokenUtils } from "./TokenUtils.js";

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
  private readonly tokenUtils: TokenUtils;
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
    this.tokenUtils = new TokenUtils();

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

      // Log detailed information about chains needing funds and chains with excess
      this.logger.debug(
        `Potential rebalance analysis: ${chainsNeedingFunds.length} chains need funds, ${chainsWithExcess.length} chains have excess`,
        {
          chainsNeedingFunds: chainsNeedingFunds.map((chain) => ({
            chainId: chain.chainId,
            deficit: chain.deficit,
            token: chain.token,
            currentPercentage: chain.currentPercentage,
            targetPercentage: chain.targetPercentage,
            tokenCurrentPercentage: chain.tokenCurrentPercentage,
            tokenTargetPercentage: chain.tokenTargetPercentage,
          })),
          chainsWithExcess: chainsWithExcess.map((chain) => ({
            chainId: chain.chainId,
            excess: Math.max(0, chain.excess), // Ensure excess is never negative in logs
            sourcePriority: chain.sourcePriority,
            currentPercentage: chain.currentPercentage,
            targetPercentage: chain.targetPercentage,
          })),
        }
      );

      // If no chains need funds or no chains have excess, no rebalancing needed
      if (chainsNeedingFunds.length === 0 || chainsWithExcess.length === 0) {
        return;
      }

      // Sort chains needing funds by destination priority first (if specified), then by relative deficit
      chainsNeedingFunds.sort((a, b) => {
        // First sort by destination priority if available (lower number = higher priority)
        if (
          a.destinationPriority !== undefined &&
          b.destinationPriority !== undefined
        ) {
          if (a.destinationPriority !== b.destinationPriority) {
            return a.destinationPriority - b.destinationPriority;
          }
        } else if (a.destinationPriority !== undefined) {
          return -1; // a has priority, b doesn't
        } else if (b.destinationPriority !== undefined) {
          return 1; // b has priority, a doesn't
        }

        // Then sort by relative deficit (larger relative deficit = higher priority)
        return b.relativeDeficit - a.relativeDeficit;
      });

      // Sort chains with excess by source priority (lowest number first) and then by excess (largest excess first)
      chainsWithExcess.sort((a, b) => {
        // First sort by priority (lower number = higher priority)
        if (a.sourcePriority !== b.sourcePriority) {
          return a.sourcePriority - b.sourcePriority;
        }
        // Then sort by excess amount (larger excess = higher priority)
        return b.excess - a.excess;
      });

      // Try each destination chain in order until we find one that works
      for (const destinationChain of chainsNeedingFunds) {
        // Try each source chain in order until we find one that works
        for (const sourceChain of chainsWithExcess) {
          // Skip if source and destination are the same chain
          if (sourceChain.chainId === destinationChain.chainId) {
            this.logger.debug(
              `Skipping rebalance from chain ${sourceChain.chainId} to itself`
            );
            continue;
          }

          // Double-check that destination chain can be a destination
          const destChainConfig =
            DEFAULT_REBALANCE_CONFIG.chains[
              destinationChain.chainId as keyof typeof DEFAULT_REBALANCE_CONFIG.chains
            ];
          if (!destChainConfig || !destChainConfig.canBeDestination) {
            this.logger.debug(
              `Skipping rebalance to chain ${destinationChain.chainId} as it cannot be a destination`
            );
            continue;
          }

          // Log the selected source and destination chains
          this.logger.debug(
            `Trying source chain ${sourceChain.chainId} and destination chain ${destinationChain.chainId} for potential rebalance`,
            {
              sourceChain: {
                chainId: sourceChain.chainId,
                excess: sourceChain.excess,
                sourcePriority: sourceChain.sourcePriority,
                currentPercentage: sourceChain.currentPercentage,
                targetPercentage: sourceChain.targetPercentage,
              },
              destinationChain: {
                chainId: destinationChain.chainId,
                deficit: destinationChain.deficit,
                token: destinationChain.token,
                currentPercentage: destinationChain.currentPercentage,
                targetPercentage: destinationChain.targetPercentage,
              },
              specificToken: destinationChain.token,
            }
          );

          // If this is a token-specific deficit, prioritize that token
          const specificToken = destinationChain.token;

          // Log token-specific deficits for debugging
          this.logger.debug(
            `Token-specific deficits for destination chain ${destinationChain.chainId}:`,
            {
              specificToken,
              relativeDeficit: destinationChain.relativeDeficit,
              tokenCurrentPercentage: destinationChain.tokenCurrentPercentage,
              tokenTargetPercentage: destinationChain.tokenTargetPercentage,
            }
          );

          // Filter available tokens to only those that would result in a non-zero rebalance amount
          const viableTokens = sourceChain.availableTokens.filter((tokenInfo) =>
            this.decisionMaker.preCheckRebalanceAmount(
              destinationChain,
              sourceChain,
              tokenInfo
            )
          );

          // If no viable tokens, skip this source chain
          if (viableTokens.length === 0) {
            this.logger.debug(
              `Skipping source chain ${sourceChain.chainId} as no tokens would result in a non-zero rebalance amount`
            );
            continue;
          }

          // Create a new sourceChain object with only viable tokens
          const filteredSourceChain = {
            ...sourceChain,
            availableTokens: viableTokens,
          };

          // Determine the token to rebalance
          const { tokenToRebalance, tokenInfo } =
            this.decisionMaker.selectTokenToRebalance(
              filteredSourceChain,
              specificToken
            );

          // Skip if the selected token is WETH - we never want to bridge WETH
          if (tokenToRebalance === "WETH") {
            this.logger.info(
              `Skipping rebalance from chain ${sourceChain.chainId} to chain ${destinationChain.chainId} because WETH was selected, and we never want to bridge WETH`
            );
            continue; // Try the next source chain
          }

          // Log the selected token
          this.logger.info(
            `Selected token ${tokenToRebalance} for rebalance from chain ${sourceChain.chainId} to chain ${destinationChain.chainId}`,
            {
              tokenToRebalance,
              tokenInfo,
              specificToken,
            }
          );

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
            continue; // Try the next source chain
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
            continue; // Try the next source chain
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

          // Log the calculated rebalance amount
          this.logger.info(
            `Calculated rebalance amount: ${tokenAmount} ${tokenToRebalance} (${amountToRebalanceUsd} USD) from chain ${sourceChain.chainId} to chain ${destinationChain.chainId}`,
            {
              tokenAmount,
              tokenToRebalance,
              amountToRebalanceUsd,
              sourceChainId: sourceChain.chainId,
              destinationChainId: destinationChain.chainId,
              sourceTokenBalance: this.tokenUtils.getTokenBalance(
                tokenToRebalance,
                sourceChain.chainId,
                balances
              ),
              destinationTokenBalance: this.tokenUtils.getTokenBalance(
                tokenToRebalance,
                destinationChain.chainId,
                balances
              ),
            }
          );

          // Skip if the amount to rebalance is negative or zero
          if (tokenAmount <= 0 || amountToRebalanceUsd <= 0) {
            this.logger.info(
              `Skipping rebalance from chain ${sourceChain.chainId} to chain ${destinationChain.chainId} due to negative or zero rebalance amount: ${tokenAmount} ${tokenToRebalance}`
            );
            continue;
          }

          // Check if the amount is sufficient for Across protocol
          try {
            // Get fee estimate to check minimum limits
            const feeEstimate =
              await this.rebalanceService.getRebalanceFeeEstimate(
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
                  DEFAULT_REBALANCE_CONFIG.chains[
                    destinationChain.chainId as keyof typeof DEFAULT_REBALANCE_CONFIG.chains
                  ].canBeDestination,
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
            // If there's an error with the fee estimate (e.g., amount too low), log it and try the next source chain
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
          }
        }
      }

      // If we get here, we tried all combinations and none worked
      this.logger.debug(
        "No viable rebalance operations found after trying all combinations"
      );
      return;
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

import { Logger } from "../../utils/logger.js";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import type {
  RebalanceConfig,
  RebalanceOperation,
} from "../../types/rebalance.js";
import { TokenUtils } from "./TokenUtils.js";
import { RebalanceFailureTracker } from "./RebalanceFailureTracker.js";
import type { RebalanceOperationStore } from "./RebalanceOperationStore.js";
import type { RebalanceService } from "./RebalanceService.js";

/**
 * Service for analyzing balances and determining rebalance needs
 */
export class BalanceAnalyzer {
  private readonly logger: Logger;
  private readonly tokenUtils: TokenUtils;
  private readonly failureTracker: RebalanceFailureTracker;
  private readonly rebalanceService: RebalanceService;
  private readonly operationStore: RebalanceOperationStore;
  private config: RebalanceConfig;

  constructor(
    rebalanceService: RebalanceService,
    operationStore: RebalanceOperationStore,
    config: RebalanceConfig
  ) {
    this.logger = new Logger("BalanceAnalyzer");
    this.tokenUtils = new TokenUtils();
    this.failureTracker = new RebalanceFailureTracker();
    this.rebalanceService = rebalanceService;
    this.operationStore = operationStore;
    this.config = config;
  }

  /**
   * Update the rebalance configuration
   */
  public updateConfig(config: RebalanceConfig): void {
    this.config = config;
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
      const tokenPercentagesByChain =
        this.calculateTokenPercentagesByChain(balances);

      // Analyze each chain's balance - both overall and token-specific
      this.analyzeChainBalances(
        balances,
        tokenPercentagesByChain,
        chainsNeedingFunds,
        chainsWithExcess
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
      const { tokenToRebalance, tokenInfo } = this.selectTokenToRebalance(
        sourceChain,
        specificToken
      );

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
        this.calculateRebalanceAmount(
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
   * Calculate token-specific percentages across chains
   */
  private calculateTokenPercentagesByChain(
    balances: AggregateBalance
  ): Record<string, Record<SupportedChainId, number>> {
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
    return tokenPercentagesByChain;
  }

  /**
   * Analyze each chain's balance - both overall and token-specific
   */
  private analyzeChainBalances(
    balances: AggregateBalance,
    tokenPercentagesByChain: Record<string, Record<SupportedChainId, number>>,
    chainsNeedingFunds: Array<{
      chainId: SupportedChainId;
      currentPercentage: number;
      targetPercentage: number;
      deficit: number;
      deficitUsd: number;
      token?: string;
      tokenCurrentPercentage?: number;
      tokenTargetPercentage?: number;
    }>,
    chainsWithExcess: Array<{
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
        excessPercentage?: number;
      }>;
    }>
  ): void {
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
            balances.tokenBalances.usd[
              tokenSymbol as keyof typeof balances.tokenBalances.usd
            ];

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
            const tokenBalance = this.tokenUtils.getTokenBalance(
              token,
              chainId,
              balances
            );
            const tokenBalanceUsd = this.tokenUtils.getTokenBalanceUsd(
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
                this.tokenUtils.getTokenBalanceUsd(token, chainId, balances) ||
                0,
              rawBalance:
                this.tokenUtils.getTokenBalance(token, chainId, balances) ||
                "0",
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
  }

  /**
   * Select the token to use for rebalancing
   */
  private selectTokenToRebalance(
    sourceChain: {
      availableTokens: Array<{
        token: string;
        balanceUsd: number;
        rawBalance: string;
        priority: number;
        excessPercentage?: number;
      }>;
    },
    specificToken?: string
  ): {
    tokenToRebalance: string;
    tokenInfo: {
      token: string;
      balanceUsd: number;
      rawBalance: string;
      priority: number;
      excessPercentage?: number;
    };
  } {
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

    return { tokenToRebalance, tokenInfo };
  }

  /**
   * Calculate the amount to rebalance
   */
  private calculateRebalanceAmount(
    destinationChain: {
      deficitUsd: number;
    },
    sourceChain: {
      chainId: SupportedChainId;
      excessUsd: number;
    },
    tokenInfo: {
      balanceUsd: number;
    },
    tokenToRebalance: string,
    balances: AggregateBalance
  ): {
    amountToRebalanceUsd: number;
    tokenAmount: number;
  } {
    // Calculate the amount to rebalance, considering the actual token balance
    const maxTokenUsd = tokenInfo.balanceUsd;
    const amountToRebalanceUsd = Math.min(
      destinationChain.deficitUsd,
      sourceChain.excessUsd,
      maxTokenUsd,
      this.config.global.maxRebalanceUsdValue
    );

    // Convert USD amount to token amount
    const tokenPrice = this.tokenUtils.getTokenPrice(
      tokenToRebalance,
      sourceChain.chainId,
      balances
    );

    if (!tokenPrice) {
      throw new Error(`Could not determine price for ${tokenToRebalance}`);
    }

    // Calculate token amount based on USD value and token price
    const tokenAmount = amountToRebalanceUsd / tokenPrice;

    return { amountToRebalanceUsd, tokenAmount };
  }

  /**
   * Get the failure tracker instance
   */
  public getFailureTracker(): RebalanceFailureTracker {
    return this.failureTracker;
  }
}

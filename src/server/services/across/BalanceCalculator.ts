import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import type { RebalanceConfig } from "../../types/rebalance.js";
import { Logger } from "../../utils/logger.js";
import { TokenUtils } from "./TokenUtils.js";

/**
 * Service for calculating and analyzing balances across chains
 */
export class BalanceCalculator {
  private readonly logger: Logger;
  private readonly tokenUtils: TokenUtils;
  private config: RebalanceConfig;

  constructor(config: RebalanceConfig) {
    this.logger = new Logger("BalanceCalculator");
    this.tokenUtils = new TokenUtils();
    this.config = config;
  }

  /**
   * Update the rebalance configuration
   */
  public updateConfig(config: RebalanceConfig): void {
    this.config = config;
  }

  /**
   * Calculate token-specific percentages across chains
   */
  public calculateTokenPercentagesByChain(
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

    // Log token totals for debugging
    this.logger.debug(
      `Token total USD values: ETH=${tokenTotalUsd.ETH}, WETH=${tokenTotalUsd.WETH}, USDC=${tokenTotalUsd.USDC}`
    );

    // For each chain, calculate the percentage of each token
    for (const chainId of Object.keys(balances.chainBalances).map(Number)) {
      for (const token of Object.keys(tokenTotalUsd)) {
        const tokenBalanceUsd =
          this.tokenUtils.getTokenBalanceUsd(
            token,
            chainId as SupportedChainId,
            balances
          ) || 0; // Default to 0 if undefined

        // Calculate percentage of total for this token on this chain
        if (tokenTotalUsd[token as keyof typeof tokenTotalUsd] > 0) {
          tokenPercentagesByChain[token][chainId as SupportedChainId] =
            (tokenBalanceUsd /
              tokenTotalUsd[token as keyof typeof tokenTotalUsd]) *
            100;
        } else {
          // If total is 0, set percentage to 0
          tokenPercentagesByChain[token][chainId as SupportedChainId] = 0;
        }
      }
    }

    // Log token percentages by chain for debugging
    for (const token of Object.keys(tokenPercentagesByChain)) {
      this.logger.debug(
        `Token ${token} percentages by chain:`,
        tokenPercentagesByChain[token]
      );
    }

    this.logger.debug("Token percentages by chain:", tokenPercentagesByChain);
    return tokenPercentagesByChain;
  }

  /**
   * Analyze each chain's balance - both overall and token-specific
   */
  public analyzeChainBalances(
    balances: AggregateBalance,
    tokenPercentagesByChain: Record<string, Record<SupportedChainId, number>>
  ): {
    chainsNeedingFunds: Array<{
      chainId: SupportedChainId;
      currentPercentage: number;
      targetPercentage: number;
      deficit: number;
      deficitUsd: number;
      relativeDeficit: number; // New property: how far below target as a percentage of target
      token?: string;
      tokenCurrentPercentage?: number;
      tokenTargetPercentage?: number;
      destinationPriority?: number; // New property: optional destination priority
    }>;
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
    }>;
  } {
    // Find chains that are below their trigger thresholds
    const chainsNeedingFunds: Array<{
      chainId: SupportedChainId;
      currentPercentage: number;
      targetPercentage: number;
      deficit: number;
      deficitUsd: number;
      relativeDeficit: number; // How far below target as a percentage of target
      token?: string; // Optional token that needs rebalancing
      tokenCurrentPercentage?: number; // Current percentage of token on this chain
      tokenTargetPercentage?: number; // Target percentage for this token
      destinationPriority?: number; // Optional destination priority
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

      // Log token-specific percentages for this chain
      this.logger.debug(
        `Chain ${chainId} balance analysis - Overall: ${currentPercentage.toFixed(2)}% (target: ${targetPercentage}%, threshold: ${triggerThreshold}%)`,
        {
          chainId,
          currentPercentage,
          targetPercentage,
          triggerThreshold,
          tokenPercentages: Object.entries(chainConfig.tokens)
            .filter(
              ([token]) =>
                tokenPercentagesByChain[token]?.[chainId] !== undefined
            )
            .map(([token, config]) => ({
              token,
              currentPercentage: tokenPercentagesByChain[token][chainId],
              targetPercentage:
                config.targetPercentage || chainConfig.targetPercentage,
              triggerThreshold:
                config.triggerThreshold || chainConfig.triggerThreshold,
            })),
        }
      );

      // Check if chain is below trigger threshold and can be a destination
      if (
        chainConfig.canBeDestination &&
        currentPercentage < triggerThreshold
      ) {
        const deficit = targetPercentage - currentPercentage;
        const deficitUsd = (deficit / 100) * balances.totalBalance;
        // Calculate relative deficit (how far below target as a percentage of target)
        const relativeDeficit =
          targetPercentage > 0 ? (deficit / targetPercentage) * 100 : 0;

        chainsNeedingFunds.push({
          chainId,
          currentPercentage,
          targetPercentage,
          deficit,
          deficitUsd,
          relativeDeficit,
          destinationPriority: chainConfig.destinationPriority,
        });
      }

      // Check token-specific balances for this chain
      for (const [tokenSymbol, tokenConfig] of Object.entries(
        chainConfig.tokens
      )) {
        if (!tokenConfig.enabled) {
          continue;
        }

        // Get token balance on this chain
        const tokenBalanceUsd = this.tokenUtils.getTokenBalanceUsd(
          tokenSymbol,
          chainId,
          balances
        );

        // Check if token has zero balance but is configured for this chain
        const hasZeroBalance =
          tokenBalanceUsd === 0 || tokenBalanceUsd === undefined;

        // Get token percentage if available
        let tokenCurrentPercentage = 0;
        if (
          tokenPercentagesByChain[tokenSymbol] &&
          tokenPercentagesByChain[tokenSymbol][chainId] !== undefined
        ) {
          tokenCurrentPercentage =
            tokenPercentagesByChain[tokenSymbol][chainId];
        }

        const tokenTargetPercentage =
          tokenConfig.targetPercentage || chainConfig.targetPercentage;
        const tokenTriggerThreshold =
          tokenConfig.triggerThreshold || chainConfig.triggerThreshold;

        // Log token-specific analysis
        this.logger.debug(
          `Token ${tokenSymbol} on chain ${chainId}: current=${tokenCurrentPercentage.toFixed(2)}%, target=${tokenTargetPercentage}%, threshold=${tokenTriggerThreshold}%, hasZeroBalance=${hasZeroBalance}`
        );

        // Check if this specific token is below its threshold on this chain
        // Also consider chains with zero balance of a token as needing funds
        // We need to be more aggressive about identifying token-specific deficits
        if (
          chainConfig.canBeDestination &&
          (tokenCurrentPercentage < tokenTriggerThreshold ||
            tokenCurrentPercentage < tokenTargetPercentage * 0.5 || // Also trigger if below 50% of target
            hasZeroBalance)
        ) {
          const tokenDeficit = tokenTargetPercentage - tokenCurrentPercentage;
          const tokenDeficitUsd =
            (tokenDeficit / 100) *
            balances.tokenBalances.usd[
              tokenSymbol as keyof typeof balances.tokenBalances.usd
            ];

          // Calculate relative deficit for token (how far below target as a percentage of target)
          const tokenRelativeDeficit =
            tokenTargetPercentage > 0
              ? (tokenDeficit / tokenTargetPercentage) * 100
              : 0;

          // Add this chain to the list of chains needing funds, specifically for this token
          chainsNeedingFunds.push({
            chainId,
            currentPercentage, // Overall chain percentage
            targetPercentage, // Overall chain target
            deficit: tokenDeficit, // Token-specific deficit
            deficitUsd: tokenDeficitUsd, // Token-specific deficit in USD
            relativeDeficit: tokenRelativeDeficit, // Token-specific relative deficit
            token: tokenSymbol, // Specify which token needs rebalancing
            tokenCurrentPercentage,
            tokenTargetPercentage,
            destinationPriority: chainConfig.destinationPriority,
          });
        }
      }

      // Check if chain has excess funds and can be a source (sourcePriority > 0)
      if (
        chainConfig.sourcePriority > 0 &&
        (currentPercentage > targetPercentage ||
          // Check if any token on this chain is significantly above its target percentage
          // or if any token has a very high percentage of the total token supply
          Array.from(Object.entries(chainConfig.tokens)).some(
            ([token, config]) => {
              if (!config.enabled) return false;

              const tokenCurrentPercentage =
                tokenPercentagesByChain[token]?.[chainId] || 0;
              const tokenTargetPercentage =
                config.targetPercentage || chainConfig.targetPercentage;

              // Consider this chain as having excess if:
              // 1. The token's current percentage is significantly above its target percentage, OR
              // 2. The token has a very high percentage of the total token supply (>70%)
              return (
                tokenCurrentPercentage > tokenTargetPercentage + 5 || // 5% buffer
                tokenCurrentPercentage > 70 // Consider extreme imbalance (>70% on one chain) as excess
              );
            }
          ))
      ) {
        // Calculate overall chain excess
        const excess = currentPercentage - targetPercentage;

        // Only proceed if there's an actual excess (greater than 0)
        if (excess > 0) {
          const excessUsd = (excess / 100) * balances.totalBalance;

          // Find the token with the highest excess percentage (if any)
          let highestExcessToken = {
            token: "",
            excessPercentage: 0,
            excessUsd: 0,
          };

          for (const [token, config] of Object.entries(chainConfig.tokens)) {
            if (!config.enabled) continue;

            const tokenCurrentPercentage =
              tokenPercentagesByChain[token]?.[chainId] || 0;
            const tokenTargetPercentage =
              config.targetPercentage || chainConfig.targetPercentage;
            const tokenExcessPercentage = Math.max(
              0,
              tokenCurrentPercentage - tokenTargetPercentage
            );

            if (tokenExcessPercentage > highestExcessToken.excessPercentage) {
              const tokenTotalUsd =
                balances.tokenBalances.usd[
                  token as keyof typeof balances.tokenBalances.usd
                ] || 0;
              const tokenExcessUsd =
                (tokenExcessPercentage / 100) * tokenTotalUsd;

              highestExcessToken = {
                token,
                excessPercentage: tokenExcessPercentage,
                excessUsd: tokenExcessUsd,
              };
            }
          }

          // If a token has higher excess than the overall chain, use that for logging
          if (highestExcessToken.excessPercentage > excess) {
            this.logger.debug(
              `Chain ${chainId} has token-specific excess: ${highestExcessToken.token} is ${highestExcessToken.excessPercentage.toFixed(2)}% above target (${highestExcessToken.excessUsd.toFixed(2)} USD)`
            );
          }

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
              // Calculate token-specific excess percentage
              // If the token's current percentage is above its target percentage, use that as excess
              // This ensures we consider token-specific imbalances even if the overall chain balance is fine
              const tokenExcessPercentage = Math.max(
                0,
                tokenCurrentPercentage - tokenTargetPercentage
              );

              return {
                token,
                balanceUsd:
                  this.tokenUtils.getTokenBalanceUsd(
                    token,
                    chainId,
                    balances
                  ) || 0,
                rawBalance:
                  this.tokenUtils.getTokenBalance(token, chainId, balances) ||
                  "0",
                priority: config.priority || chainConfig.sourcePriority,
                excessPercentage: tokenExcessPercentage,
              };
            })
            .filter((token) => token.balanceUsd > 0);

          // Only add chains with actual excess (greater than 0) to the chainsWithExcess array
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

    return { chainsNeedingFunds, chainsWithExcess };
  }
}

import { Logger } from "../../utils/logger.js";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import type { RebalanceConfig } from "../../types/rebalance.js";
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
      token?: string;
      tokenCurrentPercentage?: number;
      tokenTargetPercentage?: number;
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

    return { chainsNeedingFunds, chainsWithExcess };
  }
}

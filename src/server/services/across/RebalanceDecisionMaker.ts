import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import { Logger } from "../../utils/logger.js";
import { TokenUtils } from "./TokenUtils.js";

/**
 * Service for making rebalance decisions based on analyzed balances
 */
export class RebalanceDecisionMaker {
  private readonly logger: Logger;
  private readonly tokenUtils: TokenUtils;
  private minRebalanceUsdValue: number;
  private maxRebalanceUsdValue: number;

  constructor(minRebalanceUsdValue: number, maxRebalanceUsdValue: number) {
    this.logger = new Logger("RebalanceDecisionMaker");
    this.tokenUtils = new TokenUtils();
    this.minRebalanceUsdValue = minRebalanceUsdValue;
    this.maxRebalanceUsdValue = maxRebalanceUsdValue;
  }

  /**
   * Update the rebalance configuration values
   */
  public updateConfig(
    minRebalanceUsdValue: number,
    maxRebalanceUsdValue: number
  ): void {
    this.minRebalanceUsdValue = minRebalanceUsdValue;
    this.maxRebalanceUsdValue = maxRebalanceUsdValue;
  }

  /**
   * Select the token to use for rebalancing
   */
  public selectTokenToRebalance(
    sourceChain: {
      availableTokens: Array<{
        token: string;
        balanceUsd: number;
        rawBalance: string;
        priority: number;
        excessPercentage?: number;
      }>;
    },
    specificToken?: string,
    destinationTokenDeficits?: Record<string, number> // New parameter to pass token-specific relative deficits
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

    // Log available tokens for debugging
    this.logger.debug(
      "Available tokens for rebalance:",
      sourceChain.availableTokens.map((t) => ({
        token: t.token,
        balanceUsd: t.balanceUsd,
        priority: t.priority,
        excessPercentage: t.excessPercentage || 0,
      }))
    );

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
        this.logger.debug(
          `Selected specific token ${specificToken} with excess`
        );
      } else {
        // If the specific token isn't available with excess, try to find WETH if the specific token was ETH
        // or ETH if the specific token was WETH (they're interchangeable)
        if (specificToken === "ETH" || specificToken === "WETH") {
          const alternativeToken = specificToken === "ETH" ? "WETH" : "ETH";
          const alternativeTokenInfo = sourceChain.availableTokens.find(
            (t) =>
              t.token === alternativeToken &&
              t.excessPercentage &&
              t.excessPercentage > 0
          );

          if (alternativeTokenInfo) {
            tokenToRebalance = alternativeToken;
            tokenInfo = alternativeTokenInfo;
            this.logger.debug(
              `Selected alternative token ${alternativeToken} for ${specificToken}`
            );
            return { tokenToRebalance, tokenInfo };
          }
        }

        // If no specific token or alternative is available, try all tokens with excess
        // Filter to only tokens with excess
        const tokensWithExcess = sourceChain.availableTokens.filter(
          (t) => t.excessPercentage && t.excessPercentage > 0
        );

        if (tokensWithExcess.length > 0) {
          // Sort by excess percentage (highest first) to prioritize tokens that are most above target
          tokensWithExcess.sort(
            (a, b) => (b.excessPercentage || 0) - (a.excessPercentage || 0)
          );

          tokenInfo = tokensWithExcess[0];
          tokenToRebalance = tokenInfo.token;
          this.logger.debug(
            `Selected token with highest excess percentage: ${tokenToRebalance} (${tokenInfo.excessPercentage?.toFixed(2)}%)`
          );
        } else {
          // If no tokens with excess, fall back to highest balance
          sourceChain.availableTokens.sort(
            (a, b) => b.balanceUsd - a.balanceUsd
          );
          tokenInfo = sourceChain.availableTokens[0];
          tokenToRebalance = tokenInfo.token;
          this.logger.debug(
            `Falling back to token with highest balance: ${tokenToRebalance}`
          );
        }
      }
    } else {
      // When no specific token is requested, prioritize tokens with excess
      const tokensWithExcess = sourceChain.availableTokens.filter(
        (t) => t.excessPercentage && t.excessPercentage > 0
      );

      if (tokensWithExcess.length > 0) {
        // Sort by excess percentage (highest first) to prioritize tokens that are most above target
        tokensWithExcess.sort(
          (a, b) => (b.excessPercentage || 0) - (a.excessPercentage || 0)
        );

        tokenInfo = tokensWithExcess[0];
        tokenToRebalance = tokenInfo.token;
        this.logger.debug(
          `No specific token requested, selected token with highest excess: ${tokenToRebalance} (${tokenInfo.excessPercentage?.toFixed(2)}%)`
        );
      } else {
        // If no tokens with excess, fall back to highest balance
        sourceChain.availableTokens.sort((a, b) => b.balanceUsd - a.balanceUsd);
        tokenInfo = sourceChain.availableTokens[0];
        tokenToRebalance = tokenInfo.token;
        this.logger.debug(
          `No tokens with excess, selected ${tokenToRebalance} by balance`
        );
      }
    }

    return { tokenToRebalance, tokenInfo };
  }

  /**
   * Pre-check if a token would result in a non-zero rebalance amount
   * This helps filter out options that would be skipped anyway
   */
  public preCheckRebalanceAmount(
    destinationChain: {
      deficitUsd: number;
      relativeDeficit?: number;
    },
    sourceChain: {
      excessUsd: number;
    },
    tokenInfo: {
      balanceUsd: number;
    }
  ): boolean {
    // Calculate a minimum viable amount based on the deficit and relative deficit
    const relativeDeficit = destinationChain.relativeDeficit || 0;

    // Use a more aggressive correction factor for the pre-check
    const deficitCorrectionFactor = Math.min(0.7, relativeDeficit / 70);

    // Calculate a target amount
    const targetAmountUsd =
      destinationChain.deficitUsd *
      (relativeDeficit > 50 ? 0.8 : deficitCorrectionFactor);

    // Calculate a safe excess with minimal buffer
    const safeExcessUsd = Math.max(0, sourceChain.excessUsd * 0.99);

    // Calculate the potential amount
    const potentialAmountUsd = Math.min(
      targetAmountUsd,
      safeExcessUsd,
      tokenInfo.balanceUsd,
      this.maxRebalanceUsdValue
    );

    // Check if this would exceed the minimum threshold
    return potentialAmountUsd >= this.minRebalanceUsdValue;
  }

  /**
   * Calculate the amount to rebalance
   */
  public calculateRebalanceAmount(
    destinationChain: {
      deficitUsd: number;
      relativeDeficit?: number;
      targetPercentage?: number;
    },
    sourceChain: {
      chainId: SupportedChainId;
      excessUsd: number;
      targetPercentage?: number;
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
    // Calculate a safe percentage of the deficit to address in one operation
    // Higher relative deficits get a higher percentage (up to 80%)
    const relativeDeficit = destinationChain.relativeDeficit || 0;

    // More aggressive correction factor to ensure we're not too conservative
    // For higher relative deficits, use an even higher factor
    let deficitCorrectionFactor: number;
    if (relativeDeficit > 80) {
      deficitCorrectionFactor = 0.8; // Very high deficit, use 80%
    } else if (relativeDeficit > 60) {
      deficitCorrectionFactor = 0.7; // High deficit, use 70%
    } else if (relativeDeficit > 40) {
      deficitCorrectionFactor = 0.6; // Medium deficit, use 60%
    } else {
      deficitCorrectionFactor = Math.max(0.3, relativeDeficit / 100); // At least 30%
    }

    // Calculate a target amount based on the deficit and correction factor
    const targetAmountUsd =
      destinationChain.deficitUsd * deficitCorrectionFactor;

    // Calculate a safe amount that won't deplete the source chain below its target
    // Use a minimal buffer (0.5% of excess) to avoid being too conservative
    const safeExcessUsd = Math.max(
      0,
      sourceChain.excessUsd - 0.005 * sourceChain.excessUsd
    );

    // Calculate the amount to rebalance, considering all constraints
    const maxTokenUsd = tokenInfo.balanceUsd;

    let amountToRebalanceUsd = Math.min(
      targetAmountUsd,
      safeExcessUsd,
      maxTokenUsd,
      this.maxRebalanceUsdValue
    );

    // Log the calculation details
    this.logger.debug(
      `Rebalance amount calculation: targetAmount=${targetAmountUsd.toFixed(2)}, safeExcess=${safeExcessUsd.toFixed(2)}, maxToken=${maxTokenUsd.toFixed(2)}, maxRebalance=${this.maxRebalanceUsdValue}`,
      {
        relativeDeficit,
        deficitCorrectionFactor,
        destinationChainDeficit: destinationChain.deficitUsd,
        sourceChainExcess: sourceChain.excessUsd,
        finalAmount: amountToRebalanceUsd,
      }
    );

    // Check if the amount to rebalance is less than the minimum threshold
    if (amountToRebalanceUsd < this.minRebalanceUsdValue) {
      this.logger.debug(
        `Calculated rebalance amount ${amountToRebalanceUsd.toFixed(2)} USD is less than minimum threshold ${this.minRebalanceUsdValue} USD, skipping rebalance`
      );
      amountToRebalanceUsd = 0; // Set to zero to indicate no rebalance should occur
    }

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

    // Ensure we always return positive values
    return {
      amountToRebalanceUsd: Math.abs(amountToRebalanceUsd),
      tokenAmount: Math.abs(tokenAmount),
    };
  }
}

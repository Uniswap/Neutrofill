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
  public calculateRebalanceAmount(
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
    let amountToRebalanceUsd = Math.min(
      Math.abs(destinationChain.deficitUsd),
      Math.abs(sourceChain.excessUsd),
      maxTokenUsd,
      this.maxRebalanceUsdValue
    );

    // Check if the amount to rebalance is less than the minimum threshold
    if (amountToRebalanceUsd < this.minRebalanceUsdValue) {
      this.logger.debug(
        `Calculated rebalance amount ${amountToRebalanceUsd} USD is less than minimum threshold ${this.minRebalanceUsdValue} USD, skipping rebalance`
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

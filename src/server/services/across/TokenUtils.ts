import type { AggregateBalance } from "../../types/balance.js";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";

/**
 * Utility functions for token-related operations
 */
export class TokenUtils {
  private readonly logger: Logger;

  constructor() {
    this.logger = new Logger("TokenUtils");
  }

  /**
   * Helper to get token balance safely with type checking
   */
  public getTokenBalance(
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
  public getTokenBalanceUsd(
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
  public getTokenPrice(
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
  public getTokenDecimals(token: string): number {
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

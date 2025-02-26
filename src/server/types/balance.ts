/**
 * Types for balance data used by the balance services
 */

/**
 * Token balance data for a single token
 */
export interface TokenBalance {
  /**
   * Token balance in wei as a string
   */
  balance: string;

  /**
   * USD value of the token balance
   */
  usdValue: number;
}

/**
 * Balance data for a single chain
 */
export interface ChainBalance {
  /**
   * Token balances on this chain
   */
  tokens: {
    ETH: string;
    WETH: string;
    USDC: string;
  };

  /**
   * USD values of token balances
   */
  usd: {
    ETH: number;
    WETH: number;
    USDC: number;
    total: number;
  };

  /**
   * Percentage of total balance across all chains
   */
  percentageOfTotal: number;
}

/**
 * Aggregate balance data across all chains
 */
export interface AggregateBalance {
  /**
   * Total USD value across all chains
   */
  totalBalance: number;

  /**
   * Balance data per chain
   */
  chainBalances: Record<number, ChainBalance>;

  /**
   * Per-token balances across all chains
   */
  tokenBalances: {
    // Raw token amounts
    tokens: {
      ETH: string;
      WETH: string;
      USDC: string;
    };
    // USD values
    usd: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
    // Percentage of total value
    percentages: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
  };

  /**
   * Timestamp when this balance data was last updated
   */
  lastUpdated: number;
}

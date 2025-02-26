import type { SupportedChainId } from "../config/constants.js";

/**
 * Configuration for token rebalancing across chains
 */
export interface RebalanceConfig {
  /**
   * Token rebalancing settings per chain
   */
  chains: Record<SupportedChainId, ChainRebalanceConfig>;

  /**
   * Global settings for rebalancing
   */
  global: {
    /**
     * Whether rebalancing is enabled
     */
    enabled: boolean;

    /**
     * Minimum USD value to trigger a rebalance
     */
    minRebalanceUsdValue: number;

    /**
     * Maximum USD value to rebalance in a single transaction
     */
    maxRebalanceUsdValue: number;

    /**
     * Minimum time between rebalance operations in milliseconds
     */
    cooldownPeriodMs: number;
  };
}

/**
 * Rebalancing configuration for a specific chain
 */
export interface ChainRebalanceConfig {
  /**
   * Target percentage of total assets to maintain on this chain
   * This is the ideal percentage we want to maintain
   */
  targetPercentage: number;

  /**
   * Trigger percentage threshold
   * If the actual percentage falls below this value, a rebalance
   * will be triggered to bring it back to targetPercentage
   * Set to 0 to disable triggering rebalances for this chain
   */
  triggerThreshold: number;

  /**
   * Priority for selecting this chain as a source for rebalancing
   * Lower number = higher priority (1 is highest priority)
   * Used to prefer certain chains as sources for bridging
   * Set to 0 to never use this chain as a source
   */
  sourcePriority: number;

  /**
   * Whether this chain can be a destination for rebalancing
   * If false, funds will never be bridged to this chain
   */
  canBeDestination: boolean;

  /**
   * Token-specific rebalance settings
   */
  tokens: {
    ETH: TokenRebalanceConfig;
    WETH: TokenRebalanceConfig;
    USDC: TokenRebalanceConfig;
  };
}

/**
 * Rebalancing configuration for a specific token
 */
export interface TokenRebalanceConfig {
  /**
   * Whether rebalancing is enabled for this token
   */
  enabled: boolean;

  /**
   * Priority for rebalancing (higher number = higher priority)
   * Used to determine which token to rebalance first if multiple are below threshold
   */
  priority: number;
}

/**
 * Status of a rebalance operation
 */
export type RebalanceStatus =
  | "Pending" // Waiting to be processed
  | "Processing" // Currently being processed
  | "Completed" // Successfully completed
  | "Failed" // Failed to complete
  | "Cancelled"; // Cancelled by user or system

/**
 * Rebalance operation details
 */
export interface RebalanceOperation {
  /**
   * Unique identifier for the rebalance operation
   */
  id: string;

  /**
   * Source chain ID
   */
  sourceChainId: SupportedChainId;

  /**
   * Destination chain ID
   */
  destinationChainId: SupportedChainId;

  /**
   * Token symbol being rebalanced
   */
  token: string;

  /**
   * Amount being rebalanced in native token units
   */
  amount: number;

  /**
   * USD value of the amount being rebalanced
   */
  usdValue: number;

  /**
   * Current status of the rebalance operation
   */
  status: RebalanceStatus;

  /**
   * Transaction hash of the bridge transaction
   */
  txHash?: string;

  /**
   * Deposit ID from Across
   */
  depositId?: string;

  /**
   * Error message if the rebalance failed
   */
  error?: string;

  /**
   * Timestamp when the rebalance was created
   */
  createdAt: number;

  /**
   * Timestamp when the rebalance was last updated
   */
  updatedAt: number;

  /**
   * Timestamp when the rebalance was completed or failed
   */
  completedAt?: number;
}

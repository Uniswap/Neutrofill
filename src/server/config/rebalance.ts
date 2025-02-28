import type { RebalanceConfig } from "../types/rebalance.js";
import { SUPPORTED_CHAINS } from "./constants.js";

/**
 * Default rebalance configuration
 * This can be overridden at runtime
 */
export const DEFAULT_REBALANCE_CONFIG: RebalanceConfig = {
  chains: {
    // Ethereum Mainnet
    1: {
      targetPercentage: 10, // 10% of funds on Ethereum
      triggerThreshold: 0, // Never trigger rebalance to Ethereum
      sourcePriority: 4, // Lowest priority as source
      canBeDestination: false, // Never bridge to Ethereum, only from it
      tokens: {
        ETH: {
          enabled: true,
          priority: 2,
          targetPercentage: 10, // 10% of all ETH on Ethereum
          triggerThreshold: 0, // Never trigger ETH rebalance to Ethereum
        },
        WETH: {
          enabled: true,
          priority: 1,
          targetPercentage: 10, // 10% of all WETH on Ethereum
          triggerThreshold: 0, // Never trigger WETH rebalance to Ethereum
        },
        USDC: {
          enabled: true,
          priority: 3, // Highest priority - prefer USDC for rebalancing
          targetPercentage: 10, // 10% of all USDC on Ethereum
          triggerThreshold: 0, // Never trigger USDC rebalance to Ethereum
        },
      },
    },
    // Optimism
    10: {
      targetPercentage: 20, // 20% of funds on Optimism
      triggerThreshold: 10, // Trigger rebalance if below 10%
      sourcePriority: 1, // Highest priority as source
      canBeDestination: true, // Can be a destination for bridging
      tokens: {
        ETH: {
          enabled: true,
          priority: 2,
          targetPercentage: 20, // 20% of all ETH on Optimism
          triggerThreshold: 10, // Trigger ETH rebalance if below 10%
        },
        WETH: {
          enabled: true,
          priority: 1,
          targetPercentage: 20, // 20% of all WETH on Optimism
          triggerThreshold: 10, // Trigger WETH rebalance if below 10%
        },
        USDC: {
          enabled: true,
          priority: 3, // Highest priority - prefer USDC for rebalancing
          targetPercentage: 20, // 20% of all USDC on Optimism
          triggerThreshold: 10, // Trigger USDC rebalance if below 10%
        },
      },
    },
    // Unichain
    130: {
      targetPercentage: 50, // 50% of funds on Unichain
      triggerThreshold: 20, // Trigger rebalance if below 20%
      sourcePriority: 3, // Third priority as source
      canBeDestination: true, // Can be a destination for bridging
      tokens: {
        ETH: {
          enabled: true,
          priority: 2,
          targetPercentage: 50, // 50% of all ETH on Unichain
          triggerThreshold: 30, // Trigger ETH rebalance if below 30%
        },
        WETH: {
          enabled: true,
          priority: 1,
          targetPercentage: 50, // 50% of all WETH on Unichain
          triggerThreshold: 30, // Trigger WETH rebalance if below 30%
        },
        USDC: {
          enabled: true,
          priority: 3, // Highest priority - prefer USDC for rebalancing
          targetPercentage: 50, // 50% of all USDC on Unichain
          triggerThreshold: 30, // Trigger USDC rebalance if below 30%
        },
      },
    },
    // Base
    8453: {
      targetPercentage: 30, // 30% of funds on Base
      triggerThreshold: 10, // Trigger rebalance if below 10%
      sourcePriority: 2, // Second priority as source
      canBeDestination: true, // Can be a destination for bridging
      tokens: {
        ETH: {
          enabled: true,
          priority: 2,
          targetPercentage: 30, // 30% of all ETH on Base
          triggerThreshold: 10, // Trigger ETH rebalance if below 10%
        },
        WETH: {
          enabled: true,
          priority: 1,
          targetPercentage: 30, // 30% of all WETH on Base
          triggerThreshold: 10, // Trigger WETH rebalance if below 10%
        },
        USDC: {
          enabled: true,
          priority: 3, // Highest priority - prefer USDC for rebalancing
          targetPercentage: 30, // 30% of all USDC on Base
          triggerThreshold: 10, // Trigger USDC rebalance if below 10%
        },
      },
    },
  },
  global: {
    enabled: true, // Enable rebalancing by default
    minRebalanceUsdValue: 10, // Minimum USD value to trigger a rebalance
    maxRebalanceUsdValue: 5000, // Maximum USD value to rebalance in a single transaction
    cooldownPeriodMs: 30000, // 30 second cooldown between rebalances
  },
};

/**
 * Validate that the rebalance configuration is valid
 * @param config Rebalance configuration to validate
 * @returns true if valid, throws an error if invalid
 */
export function validateRebalanceConfig(config: RebalanceConfig): boolean {
  // Check that all supported chains are configured
  for (const chainId of SUPPORTED_CHAINS) {
    if (!config.chains[chainId]) {
      throw new Error(`Missing configuration for chain ${chainId}`);
    }
  }

  // Check that target percentages sum to 100%
  const totalPercentage = Object.values(config.chains).reduce(
    (sum, chainConfig) => sum + chainConfig.targetPercentage,
    0
  );

  if (Math.abs(totalPercentage - 100) > 0.1) {
    throw new Error(
      `Total target percentage must be 100%, got ${totalPercentage}%`
    );
  }

  // Check that all chains have all required tokens configured
  for (const [chainId, chainConfig] of Object.entries(config.chains)) {
    const requiredTokens = ["ETH", "WETH", "USDC"];
    for (const token of requiredTokens) {
      if (!chainConfig.tokens[token as keyof typeof chainConfig.tokens]) {
        throw new Error(
          `Missing token ${token} configuration for chain ${chainId}`
        );
      }
    }
  }

  // Check that at least one chain can be a destination
  const hasDestination = Object.values(config.chains).some(
    (chainConfig) => chainConfig.canBeDestination
  );

  if (!hasDestination) {
    throw new Error("At least one chain must be configured as a destination");
  }

  return true;
}

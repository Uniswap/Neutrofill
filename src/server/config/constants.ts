import type { Address } from 'viem';

export const SUPPORTED_CHAINS = [1, 10, 130, 8453] as const; // Mainnet, Optimism, Unichain, & Base
export type SupportedChainId = (typeof SUPPORTED_CHAINS)[number];

interface TokenConfig {
  address: Address;
  decimals: number;
  symbol: string;
  coingeckoId: string;
}

interface ChainConfig {
  name: string;
  nativeToken: string;
  coingeckoId: string;
  blockExplorer: string;
  rpcEnvKey: string;
  tokens: Record<string, TokenConfig>;
}

export const CHAIN_CONFIG: Record<SupportedChainId, ChainConfig> = {
  1: {
    name: 'Mainnet',
    nativeToken: 'ETH',
    coingeckoId: 'ethereum',
    blockExplorer: 'https://etherscan.io',
    rpcEnvKey: 'RPC_URL_MAINNET',
    tokens: {
      ETH: {
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        symbol: 'ETH',
        coingeckoId: 'ethereum',
      },
      WETH: {
        address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        decimals: 18,
        symbol: 'WETH',
        coingeckoId: 'weth',
      },
      USDC: {
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        decimals: 6,
        symbol: 'USDC',
        coingeckoId: 'usd-coin',
      },
    },
  },
  10: {
    name: 'Optimism',
    nativeToken: 'ETH',
    coingeckoId: 'ethereum',
    blockExplorer: 'https://optimistic.etherscan.io',
    rpcEnvKey: 'RPC_URL_OPTIMISM',
    tokens: {
      ETH: {
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        symbol: 'ETH',
        coingeckoId: 'ethereum',
      },
      WETH: {
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WETH',
        coingeckoId: 'weth',
      },
      USDC: {
        address: '0x7F5c764cBc14f9669B88837ca1490cCa17c31607',
        decimals: 6,
        symbol: 'USDC',
        coingeckoId: 'usd-coin',
      },
    },
  },
  130: {
    name: 'Unichain',
    nativeToken: 'ETH',
    coingeckoId: 'unichain',
    blockExplorer: 'https://uniscan.xyz',
    rpcEnvKey: 'RPC_URL_UNICHAIN',
    tokens: {
      ETH: {
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        symbol: 'ETH',
        coingeckoId: 'ethereum',
      },
      WETH: {
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WETH',
        coingeckoId: 'weth',
      },
      USDC: {
        address: '0x078d782b760474a361dda0af3839290b0ef57ad6',
        decimals: 6,
        symbol: 'USDC',
        coingeckoId: 'usd-coin',
      },
    },
  },
  8453: {
    name: 'Base',
    nativeToken: 'ETH',
    coingeckoId: 'ethereum',
    blockExplorer: 'https://basescan.org',
    rpcEnvKey: 'RPC_URL_BASE',
    tokens: {
      ETH: {
        address: '0x0000000000000000000000000000000000000000',
        decimals: 18,
        symbol: 'ETH',
        coingeckoId: 'ethereum',
      },
      WETH: {
        address: '0x4200000000000000000000000000000000000006',
        decimals: 18,
        symbol: 'WETH',
        coingeckoId: 'weth',
      },
      USDC: {
        address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        decimals: 6,
        symbol: 'USDC',
        coingeckoId: 'usd-coin',
      },
    },
  },
} as const;

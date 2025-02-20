import { Logger } from '../../utils/logger.js';
import { CHAIN_CONFIG, type SupportedChainId } from '../../config/constants.js';

const ETH_ADDRESS = '0x0000000000000000000000000000000000000000';

interface PriceData {
  price: number;
  timestamp: number;
  source: string;
}

class CoinGeckoError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CoinGeckoError';
  }
}

export class CoinGeckoProvider {
  private cache: Map<SupportedChainId, { data: PriceData; timestamp: number }>;
  private logger: Logger;
  private baseUrl: string;
  private headers: Record<string, string>;
  private readonly CACHE_TTL = 30000; // 30 seconds

  constructor(apiKey?: string) {
    this.cache = new Map();
    this.logger = new Logger('CoinGeckoProvider');
    this.baseUrl = apiKey
      ? 'https://pro-api.coingecko.com/api/v3'
      : 'https://api.coingecko.com/api/v3';
    this.headers = {
      accept: 'application/json',
      ...(apiKey && { 'x-cg-pro-api-key': apiKey })
    };
  }

  private async makeRequest<T>(url: string, errorContext: string): Promise<T> {
    try {
      const response = await fetch(url, { headers: this.headers });

      if (!response.ok) {
        let errorMessage: string;
        try {
          const errorData = await response.json();
          errorMessage = errorData?.error || response.statusText;
        } catch {
          errorMessage = response.statusText;
        }
        throw new CoinGeckoError(`${errorContext}: ${errorMessage}`);
      }

      const data = await response.json();
      if (!data) {
        throw new CoinGeckoError(`${errorContext}: Empty response`);
      }

      return data as T;
    } catch (error) {
      if (error instanceof CoinGeckoError) throw error;
      throw new CoinGeckoError(
        `${errorContext}: ${error instanceof Error ? error.message : 'Unknown error'}`,
        error
      );
    }
  }

  private getCacheKey(chainId: SupportedChainId): string {
    return `eth_price_${chainId}`;
  }

  async getEthPrice(chainId: SupportedChainId): Promise<PriceData> {
    const config = CHAIN_CONFIG[chainId];
    if (!config) {
      throw new CoinGeckoError(`Unsupported chain ID: ${chainId}`);
    }

    const cacheKey = this.getCacheKey(chainId);
    const cached = this.cache.get(chainId);
    
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      const url = `${this.baseUrl}/simple/price?ids=${config.coingeckoId}&vs_currencies=usd`;
      const data = await this.makeRequest<Record<string, { usd: number }>>(
        url,
        'Failed to fetch ETH price'
      );

      if (!data[config.coingeckoId]?.usd) {
        throw new CoinGeckoError('Invalid price data format');
      }

      const priceData: PriceData = {
        price: data[config.coingeckoId].usd,
        timestamp: Date.now(),
        source: 'coingecko'
      };

      this.cache.set(chainId, { data: priceData, timestamp: Date.now() });
      return priceData;
    } catch (error) {
      this.logger.error('Failed to fetch ETH price:', error);
      throw error;
    }
  }
}

import express from 'express';
import { config } from 'dotenv';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, type PublicClient, type WalletClient, type Chain } from 'viem';
import { mainnet, optimism, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { PriceService } from './services/price/PriceService.js';
import { Logger } from './utils/logger.js';
import { BroadcastRequest } from './types/broadcast.js';
import { SUPPORTED_CHAINS, CHAIN_CONFIG, type SupportedChainId } from './config/constants.js';

config();

const app = express();
const logger = new Logger('Server');
const priceService = new PriceService(process.env.COINGECKO_API_KEY);

// Start price updates
priceService.start();

// Ensure price service is stopped when the process exits
process.on('SIGTERM', () => {
  priceService.stop();
  process.exit(0);
});

process.on('SIGINT', () => {
  priceService.stop();
  process.exit(0);
});

// Custom chain configuration for UniChain
const unichain = {
  id: 130,
  name: CHAIN_CONFIG[130].name,
  network: 'unichain',
  nativeCurrency: {
    decimals: 18,
    name: 'Ether',
    symbol: CHAIN_CONFIG[130].nativeToken,
  },
  rpcUrls: {
    default: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ''] },
    public: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ''] },
  },
  blockExplorers: {
    default: { name: 'UniScan', url: CHAIN_CONFIG[130].blockExplorer }
  }
} as const;

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY environment variable is required');
}

// Initialize the account from private key
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// Initialize public clients for different chains
const publicClients: Record<SupportedChainId, PublicClient> = {
  1: createPublicClient({
    chain: mainnet,
    transport: http(process.env[CHAIN_CONFIG[1].rpcEnvKey])
  }),
  10: createPublicClient({
    chain: optimism,
    transport: http(process.env[CHAIN_CONFIG[10].rpcEnvKey])
  }),
  130: createPublicClient({
    chain: unichain,
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey])
  }),
  8453: createPublicClient({
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey])
  })
};

// Initialize wallet clients for different chains
const walletClients: Record<SupportedChainId, WalletClient> = {
  1: createWalletClient({
    account,
    chain: mainnet,
    transport: http(process.env[CHAIN_CONFIG[1].rpcEnvKey])
  }),
  10: createWalletClient({
    account,
    chain: optimism,
    transport: http(process.env[CHAIN_CONFIG[10].rpcEnvKey])
  }),
  130: createWalletClient({
    account,
    chain: unichain,
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey])
  }),
  8453: createWalletClient({
    account,
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey])
  })
};

app.use(express.json());

app.post('/broadcast', async (req, res) => {
  try {
    const request = req.body as BroadcastRequest;
    const chainId = parseInt(request.chainId) as SupportedChainId;

    if (!SUPPORTED_CHAINS.includes(chainId)) {
      return res.status(400).json({ error: `Unsupported chain ID: ${chainId}` });
    }

    // Get current ETH price for the chain from memory
    const ethPrice = priceService.getPrice(chainId);
    logger.info(`Current ETH price on chain ${chainId}: $${ethPrice}`);

    // Extract the dispensation amount in USD from the request
    const dispensationUSD = parseFloat(request.context.dispensationUSD.replace('$', ''));
    
    // Calculate gas cost
    const baselinePriorityFee = BigInt(request.compact.mandate.baselinePriorityFee);
    const scalingFactor = BigInt(request.compact.mandate.scalingFactor);
    
    // TODO: Calculate actual gas limit based on the transaction
    const estimatedGasLimit = 300000n; // This should be properly estimated
    
    // Calculate priority fee using the mandate's formula
    const priorityFee = baselinePriorityFee + (scalingFactor * estimatedGasLimit);
    
    // Get current base fee
    const block = await publicClients[chainId].getBlock();
    const baseFee = block.baseFeePerGas ?? parseEther('0.00000005'); // 50 gwei default
    
    // Calculate total gas cost
    const totalGasCost = (baseFee + priorityFee) * estimatedGasLimit;
    const gasCostEth = Number(formatEther(totalGasCost));
    const gasCostUSD = gasCostEth * ethPrice;

    // Calculate net profit
    const netProfitUSD = dispensationUSD - gasCostUSD;
    const minProfitUSD = 0.5; // Minimum profit threshold in USD

    const isProfitable = netProfitUSD > minProfitUSD;
    
    if (!isProfitable) {
      return res.status(200).json({
        success: false,
        reason: 'Transaction not profitable',
        details: {
          dispensationUSD,
          gasCostUSD,
          netProfitUSD,
          minProfitUSD
        }
      });
    }

    // TODO: Add transaction simulation here
    
    // Submit the transaction
    // TODO: Build the actual transaction data based on the compact format
    const tx = {
      to: request.compact.mandate.tribunal as `0x${string}`,
      value: BigInt(request.compact.amount),
      maxFeePerGas: baseFee + priorityFee,
      maxPriorityFeePerGas: priorityFee,
      gas: estimatedGasLimit,
      // data: will be constructed based on the compact format
    };

    const hash = await walletClients[chainId].sendTransaction(tx);

    logger.info(`Transaction submitted: ${hash}`);
    return res.status(200).json({
      success: true,
      transactionHash: hash,
      details: {
        dispensationUSD,
        gasCostUSD,
        netProfitUSD
      }
    });

  } catch (error) {
    logger.error('Error processing broadcast request:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});

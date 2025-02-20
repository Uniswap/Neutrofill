import express from 'express';
import { config } from 'dotenv';
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  formatEther,
  type PublicClient,
  type WalletClient,
  type Chain as ViemChain,
  type Transport,
  defineChain,
  encodeFunctionData,
} from 'viem';
import { mainnet, optimism, base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { PriceService } from './services/price/PriceService.js';
import { Logger } from './utils/logger.js';
import { BroadcastRequest } from './types/broadcast.js';
import { SUPPORTED_CHAINS, CHAIN_CONFIG, type SupportedChainId } from './config/constants.js';
import { validateBroadcastRequest } from './validation/broadcast.js';

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
const unichain = defineChain({
  id: 130,
  name: CHAIN_CONFIG[130].name,
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
    default: { name: 'UniScan', url: CHAIN_CONFIG[130].blockExplorer },
  },
});

if (!process.env.PRIVATE_KEY) {
  throw new Error('PRIVATE_KEY environment variable is required');
}

// Initialize the account from private key
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

// Configure clients with specific settings
const commonConfig = {
  pollingInterval: 4_000,
  batch: {
    multicall: true,
  },
  cacheTime: 4_000,
} as const;

// Initialize public clients for different chains
const publicClients: Record<SupportedChainId, PublicClient> = {
  1: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: mainnet,
    transport: http(process.env[CHAIN_CONFIG[1].rpcEnvKey] || ''),
  }) as PublicClient,
  10: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: optimism,
    transport: http(process.env[CHAIN_CONFIG[10].rpcEnvKey] || ''),
  }) as PublicClient,
  130: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: unichain,
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey] || ''),
  }) as PublicClient,
  8453: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey] || ''),
  }) as PublicClient,
};

// Initialize wallet clients for different chains
const walletClients: Record<SupportedChainId, WalletClient<Transport, ViemChain>> = {
  1: createWalletClient({
    account,
    chain: mainnet,
    transport: http(process.env[CHAIN_CONFIG[1].rpcEnvKey]),
  }),
  10: createWalletClient({
    account,
    chain: optimism,
    transport: http(process.env[CHAIN_CONFIG[10].rpcEnvKey]),
  }),
  130: createWalletClient({
    account,
    chain: unichain,
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey]),
  }),
  8453: createWalletClient({
    account,
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey]),
  }),
};

app.use(express.json());

// Add validation middleware to broadcast endpoint
app.post('/broadcast', validateBroadcastRequest, async (req, res) => {
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

    // Add 25% buffer to dispensation for cross-chain message fee
    const bufferedDispensation = (BigInt(request.context.dispensation) * 125n) / 100n;

    // Calculate total value to send (settlement + buffered dispensation for native token, just buffered dispensation for ERC20)
    const value =
      request.compact.mandate.token === '0x0000000000000000000000000000000000000000'
        ? BigInt(request.context.spotOutputAmount) + bufferedDispensation
        : bufferedDispensation;

    // Encode function data with proper ABI
    const data = encodeFunctionData({
      abi: [
        {
          name: 'fill',
          type: 'function',
          stateMutability: 'payable',
          inputs: [
            {
              name: 'claim',
              type: 'tuple',
              components: [
                { name: 'chainId', type: 'uint256' },
                {
                  name: 'compact',
                  type: 'tuple',
                  components: [
                    { name: 'arbiter', type: 'address' },
                    { name: 'sponsor', type: 'address' },
                    { name: 'nonce', type: 'uint256' },
                    { name: 'expires', type: 'uint256' },
                    { name: 'id', type: 'uint256' },
                    { name: 'amount', type: 'uint256' },
                  ],
                },
                { name: 'sponsorSignature', type: 'bytes' },
                { name: 'allocatorSignature', type: 'bytes' },
              ],
            },
            {
              name: 'mandate',
              type: 'tuple',
              components: [
                { name: 'recipient', type: 'address' },
                { name: 'expires', type: 'uint256' },
                { name: 'token', type: 'address' },
                { name: 'minimumAmount', type: 'uint256' },
                { name: 'baselinePriorityFee', type: 'uint256' },
                { name: 'scalingFactor', type: 'uint256' },
                { name: 'salt', type: 'bytes32' },
              ],
            },
            { name: 'claimant', type: 'address' },
          ],
          outputs: [
            { name: 'mandateHash', type: 'bytes32' },
            { name: 'settlementAmount', type: 'uint256' },
            { name: 'claimAmount', type: 'uint256' },
          ],
        },
      ],
      functionName: 'fill',
      args: [
        {
          chainId: BigInt(request.chainId),
          compact: {
            arbiter: request.compact.arbiter as `0x${string}`,
            sponsor: request.compact.sponsor as `0x${string}`,
            nonce: BigInt(request.compact.nonce),
            expires: BigInt(request.compact.expires),
            id: BigInt(request.compact.id),
            amount: BigInt(request.compact.amount),
          },
          sponsorSignature: (request.sponsorSignature || '0x' + '0'.repeat(128)) as `0x${string}`,
          allocatorSignature: request.allocatorSignature as `0x${string}`,
        },
        {
          recipient: request.compact.mandate.recipient as `0x${string}`,
          expires: BigInt(request.compact.mandate.expires),
          token: request.compact.mandate.token as `0x${string}`,
          minimumAmount: BigInt(request.compact.mandate.minimumAmount),
          baselinePriorityFee: BigInt(request.compact.mandate.baselinePriorityFee),
          scalingFactor: BigInt(request.compact.mandate.scalingFactor),
          salt: request.compact.mandate.salt as `0x${string}`,
        },
        account.address,
      ],
    });

    // Estimate gas and add 25% buffer
    const estimatedGas = await publicClients[chainId].estimateGas({
      to: request.compact.mandate.tribunal as `0x${string}`,
      value,
      data,
      maxFeePerGas: baselinePriorityFee + scalingFactor * BigInt(300000),
      maxPriorityFeePerGas: baselinePriorityFee,
      account,
    });

    const gasWithBuffer = (estimatedGas * 125n) / 100n;

    // Calculate priority fee using the mandate's formula
    const priorityFee = baselinePriorityFee + scalingFactor * gasWithBuffer;

    // Get current base fee from latest block
    const block = await publicClients[chainId].getBlock();
    const baseFee = block.baseFeePerGas ?? parseEther('0.00000005'); // 50 gwei default if baseFeePerGas is null

    // Calculate total gas cost
    const totalGasCost = (baseFee + priorityFee) * gasWithBuffer;
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
          minProfitUSD,
        },
      });
    }

    // Submit the transaction
    const tx = {
      to: request.compact.mandate.tribunal as `0x${string}`,
      value,
      maxFeePerGas: baseFee + priorityFee,
      maxPriorityFeePerGas: priorityFee,
      gas: gasWithBuffer,
      account,
      data: data as `0x${string}`,
    };

    const hash = await walletClients[chainId].sendTransaction(tx);

    logger.info(`Transaction submitted: ${hash}`);
    return res.status(200).json({
      success: true,
      transactionHash: hash,
      details: {
        dispensationUSD,
        gasCostUSD,
        netProfitUSD,
      },
    });
  } catch (error) {
    logger.error('Error processing broadcast request:', error);
    return res.status(500).json({
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
});

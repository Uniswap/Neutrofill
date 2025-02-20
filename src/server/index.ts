import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import { config } from "dotenv";
import express from "express";
import {
  type PublicClient,
  type Transport,
  type Chain as ViemChain,
  type WalletClient,
  defineChain,
  encodeFunctionData,
} from "viem";
import {
  http,
  createPublicClient,
  createWalletClient,
  formatEther,
  parseEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet, optimism } from "viem/chains";
import {
  CHAIN_CONFIG,
  SUPPORTED_CHAINS,
  type SupportedChainId,
} from "./config/constants.js";
import { TheCompactService } from "./services/TheCompactService.js";
import { PriceService } from "./services/price/PriceService.js";
import { WebSocketManager } from "./services/websocket/WebSocketManager";
import type { BroadcastRequest } from "./types/broadcast.js";
import { deriveClaimHash, derivePriorityFee } from "./utils.js";
import { Logger } from "./utils/logger.js";
import { validateBroadcastRequest } from "./validation/broadcast.js";
import { verifyBroadcastRequest } from "./validation/signature.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config();

const app = express();
const server = createServer(app);
const logger = new Logger("Server");
const priceService = new PriceService(process.env.COINGECKO_API_KEY);
// Initialize TheCompactService with chain-specific public clients for nonce validation
const theCompactService = new TheCompactService({
  1: createPublicClient<Transport, ViemChain>({
    pollingInterval: 4_000,
    batch: {
      multicall: true,
    },
    cacheTime: 4_000,
    chain: mainnet,
    transport: http(process.env[CHAIN_CONFIG[1].rpcEnvKey] || ""),
  }) as PublicClient,
  10: createPublicClient<Transport, ViemChain>({
    pollingInterval: 4_000,
    batch: {
      multicall: true,
    },
    cacheTime: 4_000,
    chain: optimism,
    transport: http(process.env[CHAIN_CONFIG[10].rpcEnvKey] || ""),
  }) as PublicClient,
  130: createPublicClient<Transport, ViemChain>({
    pollingInterval: 4_000,
    batch: {
      multicall: true,
    },
    cacheTime: 4_000,
    chain: defineChain({
      id: 130,
      name: CHAIN_CONFIG[130].name,
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: CHAIN_CONFIG[130].nativeToken,
      },
      rpcUrls: {
        default: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""] },
        public: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""] },
      },
      blockExplorers: {
        default: { name: "UniScan", url: CHAIN_CONFIG[130].blockExplorer },
      },
    }),
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""),
  }) as PublicClient,
  8453: createPublicClient<Transport, ViemChain>({
    pollingInterval: 4_000,
    batch: {
      multicall: true,
    },
    cacheTime: 4_000,
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey] || ""),
  }) as PublicClient,
});

const wsManager = new WebSocketManager(server);

// Enable CORS for API endpoints
app.use("/api", cors());
app.use("/health", cors());
app.use("/broadcast", cors());

// Serve static files from dist/client
app.use(express.static(join(__dirname, "../../dist/client")));

// Handle API routes
app.use(express.json());

// Prefix existing endpoints with /api
app.post("/api/broadcast", validateBroadcastRequest, async (req, res) => {
  try {
    const request = req.body as BroadcastRequest;
    const chainId = Number.parseInt(request.chainId) as SupportedChainId;

    // Derive and log claim hash
    const claimHash = deriveClaimHash(chainId, request.compact);
    logger.info(
      `Processing fill request for chainId ${chainId}, claimHash: ${claimHash}`
    );

    // Verify signatures and check registration status
    request.claimHash = claimHash;
    const { isValid, isOnchainRegistration } = await verifyBroadcastRequest(
      request,
      theCompactService
    );
    if (!isValid) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Invalid signature"
      );
      return res.status(401).json({
        error: "Invalid signatures",
        message: "Failed to verify sponsor and/or allocator signatures",
      });
    }

    // Log registration status
    logger.info(
      `Signature verification successful, registration status: ${isOnchainRegistration ? "onchain" : "offchain"}`
    );

    if (!SUPPORTED_CHAINS.includes(chainId)) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Unsupported chain"
      );
      return res
        .status(400)
        .json({ error: `Unsupported chain ID: ${chainId}` });
    }

    // Check if either compact or mandate has expired or is close to expiring
    const currentTimestamp = BigInt(Math.floor(Date.now() / 1000));
    const COMPACT_EXPIRATION_BUFFER = 60n; // 60 seconds buffer for compact
    const MANDATE_EXPIRATION_BUFFER = 10n; // 10 seconds buffer for mandate

    if (
      BigInt(request.compact.expires) <=
      currentTimestamp + COMPACT_EXPIRATION_BUFFER
    ) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Compact is expired or expires too soon"
      );
      return res.status(400).json({
        error: "Compact is expired or expires too soon",
        details: `Compact must have at least ${COMPACT_EXPIRATION_BUFFER} seconds until expiration`,
      });
    }

    if (
      BigInt(request.compact.mandate.expires) <=
      currentTimestamp + MANDATE_EXPIRATION_BUFFER
    ) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Mandate is expired or expires too soon"
      );
      return res.status(400).json({
        error: "Mandate is expired or expires too soon",
        details: `Mandate must have at least ${MANDATE_EXPIRATION_BUFFER} seconds until expiration`,
      });
    }

    // Check if nonce has already been consumed
    const nonceConsumed = await theCompactService.hasConsumedAllocatorNonce(
      chainId,
      BigInt(request.compact.nonce),
      request.compact.arbiter as `0x${string}`
    );

    if (nonceConsumed) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Nonce has already been consumed"
      );
      return res.status(400).json({ error: "Nonce has already been consumed" });
    }

    // Get current ETH price for the chain from memory
    const ethPrice = priceService.getPrice(chainId);
    logger.info(`Current ETH price on chain ${chainId}: $${ethPrice}`);

    // Extract the dispensation amount in USD from the request
    const dispensationUSD = Number.parseFloat(
      request.context.dispensationUSD.replace("$", "")
    );

    // Calculate gas cost
    const baselinePriorityFee = BigInt(
      request.compact.mandate.baselinePriorityFee
    );
    const scalingFactor = BigInt(request.compact.mandate.scalingFactor);
    const minimumAmount = BigInt(request.compact.mandate.minimumAmount);
    const desiredSettlement = BigInt(request.context.spotOutputAmount);

    // Calculate priority fee based on desired settlement
    const priorityFee = derivePriorityFee(
      desiredSettlement,
      minimumAmount,
      baselinePriorityFee,
      scalingFactor
    );

    // Add 25% buffer to dispensation for cross-chain message fee
    const bufferedDispensation =
      (BigInt(request.context.dispensation) * 125n) / 100n;

    // Calculate total value to send (settlement + buffered dispensation for native token, just buffered dispensation for ERC20)
    const value =
      request.compact.mandate.token ===
      "0x0000000000000000000000000000000000000000"
        ? BigInt(request.context.spotOutputAmount) + bufferedDispensation
        : bufferedDispensation;

    // Encode function data with proper ABI
    const data = encodeFunctionData({
      abi: [
        {
          name: "fill",
          type: "function",
          stateMutability: "payable",
          inputs: [
            {
              name: "claim",
              type: "tuple",
              components: [
                { name: "chainId", type: "uint256" },
                {
                  name: "compact",
                  type: "tuple",
                  components: [
                    { name: "arbiter", type: "address" },
                    { name: "sponsor", type: "address" },
                    { name: "nonce", type: "uint256" },
                    { name: "expires", type: "uint256" },
                    { name: "id", type: "uint256" },
                    { name: "amount", type: "uint256" },
                  ],
                },
                { name: "sponsorSignature", type: "bytes" },
                { name: "allocatorSignature", type: "bytes" },
              ],
            },
            {
              name: "mandate",
              type: "tuple",
              components: [
                { name: "recipient", type: "address" },
                { name: "expires", type: "uint256" },
                { name: "token", type: "address" },
                { name: "minimumAmount", type: "uint256" },
                { name: "baselinePriorityFee", type: "uint256" },
                { name: "scalingFactor", type: "uint256" },
                { name: "salt", type: "bytes32" },
              ],
            },
            { name: "claimant", type: "address" },
          ],
          outputs: [
            { name: "mandateHash", type: "bytes32" },
            { name: "settlementAmount", type: "uint256" },
            { name: "claimAmount", type: "uint256" },
          ],
        },
      ],
      functionName: "fill",
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
          sponsorSignature: (request.sponsorSignature ||
            `0x${"0".repeat(128)}`) as `0x${string}`,
          allocatorSignature: request.allocatorSignature as `0x${string}`,
        },
        {
          recipient: request.compact.mandate.recipient as `0x${string}`,
          expires: BigInt(request.compact.mandate.expires),
          token: request.compact.mandate.token as `0x${string}`,
          minimumAmount: BigInt(request.compact.mandate.minimumAmount),
          baselinePriorityFee: BigInt(
            request.compact.mandate.baselinePriorityFee
          ),
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
      maxFeePerGas: priorityFee + BigInt(300000),
      maxPriorityFeePerGas: priorityFee,
      account,
    });

    const gasWithBuffer = (estimatedGas * 125n) / 100n;

    // Get current base fee from latest block and calculate max fee
    const block = await publicClients[chainId].getBlock();
    const baseFee = block.baseFeePerGas ?? parseEther("0.00000005"); // 50 gwei default if baseFeePerGas is null
    const maxFeePerGas = priorityFee + (baseFee * 120n) / 100n; // Base fee + 20% buffer

    // Calculate total gas cost
    const totalGasCost = maxFeePerGas * gasWithBuffer;
    const gasCostEth = Number(formatEther(totalGasCost));
    const gasCostUSD = gasCostEth * ethPrice;

    // Calculate net profit
    const netProfitUSD = dispensationUSD - gasCostUSD;
    const minProfitUSD = 0.5; // Minimum profit threshold in USD

    const isProfitable = netProfitUSD > minProfitUSD;

    if (!isProfitable) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Transaction not profitable"
      );
      return res.status(200).json({
        success: false,
        reason: "Transaction not profitable",
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
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      gas: gasWithBuffer,
      account,
      data: data as `0x${string}`,
    };

    const hash = await walletClients[chainId].sendTransaction(tx);

    logger.info(`Transaction submitted: ${hash}`);
    wsManager.broadcastFillRequest(JSON.stringify(request), true);
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
    logger.error("Error processing broadcast request:", error);
    wsManager.broadcastFillRequest(
      JSON.stringify(req.body),
      false,
      error instanceof Error ? error.message : "Unknown error"
    );
    return res.status(500).json({
      error: "Internal server error",
      message: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Health check endpoint
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
  });
});

// Serve index.html for all other routes to support client-side routing
app.get("*", (req, res) => {
  // Don't serve index.html for /ws or /api routes
  if (req.path.startsWith("/ws") || req.path.startsWith("/api")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(join(__dirname, "../../dist/client/index.html"));
});

// Start price updates
priceService.start();

// Ensure price service is stopped when the process exits
process.on("SIGTERM", () => {
  priceService.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  priceService.stop();
  process.exit(0);
});

if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY environment variable is required");
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
    transport: http(process.env[CHAIN_CONFIG[1].rpcEnvKey] || ""),
  }) as PublicClient,
  10: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: optimism,
    transport: http(process.env[CHAIN_CONFIG[10].rpcEnvKey] || ""),
  }) as PublicClient,
  130: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: defineChain({
      id: 130,
      name: CHAIN_CONFIG[130].name,
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: CHAIN_CONFIG[130].nativeToken,
      },
      rpcUrls: {
        default: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""] },
        public: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""] },
      },
      blockExplorers: {
        default: { name: "UniScan", url: CHAIN_CONFIG[130].blockExplorer },
      },
    }),
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""),
  }) as PublicClient,
  8453: createPublicClient<Transport, ViemChain>({
    ...commonConfig,
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey] || ""),
  }) as PublicClient,
};

// Initialize wallet clients for different chains
const walletClients: Record<
  SupportedChainId,
  WalletClient<Transport, ViemChain>
> = {
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
    chain: defineChain({
      id: 130,
      name: CHAIN_CONFIG[130].name,
      nativeCurrency: {
        decimals: 18,
        name: "Ether",
        symbol: CHAIN_CONFIG[130].nativeToken,
      },
      rpcUrls: {
        default: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""] },
        public: { http: [process.env[CHAIN_CONFIG[130].rpcEnvKey] || ""] },
      },
      blockExplorers: {
        default: { name: "UniScan", url: CHAIN_CONFIG[130].blockExplorer },
      },
    }),
    transport: http(process.env[CHAIN_CONFIG[130].rpcEnvKey]),
  }),
  8453: createWalletClient({
    account,
    chain: base,
    transport: http(process.env[CHAIN_CONFIG[8453].rpcEnvKey]),
  }),
};

// Broadcast account info on startup
wsManager.broadcastAccountUpdate(account.address);

// Update price service to broadcast prices
priceService.on("price_update", (chainId: number, price: number) => {
  wsManager.broadcastEthPrice(chainId, price.toString());
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Server wallet address: ${account.address}`);
});

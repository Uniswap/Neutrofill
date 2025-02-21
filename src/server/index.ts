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
} from "viem";
import { http, createPublicClient, createWalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base, mainnet, optimism } from "viem/chains";
import {
  CHAIN_CONFIG,
  SUPPORTED_CHAINS,
  type SupportedChainId,
} from "./config/constants.js";
import { TheCompactService } from "./services/TheCompactService.js";
import { PriceService } from "./services/price/PriceService.js";
import { TokenBalanceService } from "./services/balance/TokenBalanceService.js";
import { IndexerService } from "./services/indexer/IndexerService.js";
import { WebSocketManager } from "./services/websocket/WebSocketManager.js";
import type { BroadcastRequest } from "./types/broadcast.js";
import { deriveClaimHash } from "./utils.js";
import { Logger } from "./utils/logger.js";
import { validateBroadcastRequestMiddleware } from "./validation/broadcast.js";
import { verifyBroadcastRequest } from "./validation/signature.js";
import { processBroadcastTransaction } from "./helpers/broadcast.js";
import { checkAndSetTokenApprovals } from "./helpers/approvals.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config();

const app = express();
const server = createServer(app);

// Initialize services
const logger = new Logger("Server");
const priceService = new PriceService(process.env.COINGECKO_API_KEY);

// Initialize the account from private key
if (!process.env.PRIVATE_KEY) {
  throw new Error("PRIVATE_KEY environment variable is required");
}
const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

const indexerService = new IndexerService(
  process.env.COMPACT_INDEXER ||
    "https://the-compact-indexer-2.ponder-dev.com/",
  account.address
);
const wsManager = new WebSocketManager(server);

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

// Initialize token balance service
const tokenBalanceService = new TokenBalanceService(
  account.address,
  publicClients
);

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

// Initialize TheCompactService with chain-specific public clients for nonce validation
const theCompactService = new TheCompactService({
  1: publicClients[1],
  10: publicClients[10],
  130: publicClients[130],
  8453: publicClients[8453],
});

// Supported addresses for arbiters and tribunals per chain
const SUPPORTED_ARBITER_ADDRESSES: Record<SupportedChainId, string> = {
  1: "0xDfd41e6E2e08e752f464084F5C11619A3c950237", // Ethereum
  10: "0x2602D9f66ec17F2dc770063F7B91821DD741F626", // Optimism
  130: "0x81fC1d90C5fae0f15FC91B5592177B594011C576", // Unichain
  8453: "0xfaBE453252ca8337b091ba01BB168030E2FE6c1F", // Base
} as const;

const SUPPORTED_TRIBUNAL_ADDRESSES = SUPPORTED_ARBITER_ADDRESSES;

// Start services
priceService.start();
tokenBalanceService.start();
indexerService.start();

// Check and set token approvals for supported chains
const chainsToApprove = [10, 130, 8453] as const; // Optimism, Unichain, Base
for (const chainId of chainsToApprove) {
  await checkAndSetTokenApprovals(
    chainId,
    SUPPORTED_TRIBUNAL_ADDRESSES[chainId] as `0x${string}`,
    publicClients[chainId],
    walletClients[chainId]
  );
}

// Set up service event handlers
priceService.on("price_update", (chainId: number, price: number) => {
  wsManager.broadcastEthPrice(chainId, price.toString());
});

tokenBalanceService.on("balance_update", (chainId, account, balances) => {
  wsManager.broadcastTokenBalances(chainId, account, balances);
});

// Broadcast initial account info
wsManager.broadcastAccountUpdate(account.address);

// Ensure services are stopped when the process exits
process.on("SIGTERM", () => {
  priceService.stop();
  tokenBalanceService.stop();
  indexerService.stop();
  process.exit(0);
});

process.on("SIGINT", () => {
  priceService.stop();
  tokenBalanceService.stop();
  indexerService.stop();
  process.exit(0);
});

// Enable CORS for specific endpoints
app.use("/health", cors());
app.use("/broadcast", cors());

// Define interface for extended request type
interface ExtendedRequest extends express.Request {
  rawBody?: Buffer;
}

// Parse JSON bodies (must be before routes)
app.use(
  express.json({
    limit: "1mb",
    strict: true,
    verify: (req: ExtendedRequest, _res, buf) => {
      try {
        // Store raw body for later use if needed
        req.rawBody = buf;
        JSON.parse(buf.toString());
      } catch (e) {
        throw new Error("Invalid JSON");
      }
    },
  })
);

// Broadcast endpoint
app.post("/broadcast", validateBroadcastRequestMiddleware, async (req, res) => {
  try {
    const request = req.body as BroadcastRequest;
    const chainId = Number.parseInt(
      request.chainId.toString()
    ) as SupportedChainId;

    // Log request info after validation
    logger.info("Received valid broadcast request:", {
      contentType: req.headers["content-type"],
      chainId: request.chainId,
      mandateChainId: request.compact.mandate.chainId,
    });

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

    // Process the broadcast transaction
    const mandateChainId = Number(
      request.compact.mandate.chainId
    ) as SupportedChainId;

    // Validate arbiter and tribunal addresses
    const arbiterAddress = request.compact.arbiter.toLowerCase();
    const tribunalAddress = request.compact.mandate.tribunal.toLowerCase();

    if (
      arbiterAddress !==
      SUPPORTED_ARBITER_ADDRESSES[
        Number(request.chainId) as SupportedChainId
      ].toLowerCase()
    ) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Unsupported arbiter address"
      );
      return res.status(400).json({ error: "Unsupported arbiter address" });
    }

    if (
      tribunalAddress !==
      SUPPORTED_TRIBUNAL_ADDRESSES[mandateChainId].toLowerCase()
    ) {
      wsManager.broadcastFillRequest(
        JSON.stringify(request),
        false,
        "Unsupported tribunal address"
      );
      return res.status(400).json({ error: "Unsupported tribunal address" });
    }

    const result = await processBroadcastTransaction(
      { ...request, chainId: Number(request.chainId) },
      mandateChainId,
      priceService,
      publicClients[mandateChainId],
      walletClients[mandateChainId],
      account.address
    );

    // Handle the result
    wsManager.broadcastFillRequest(
      JSON.stringify(request),
      result.success,
      result.success ? undefined : result.reason
    );

    return res.status(result.success ? 200 : 400).json({
      success: result.success,
      ...(result.success
        ? { transactionHash: result.hash }
        : { reason: result.reason }),
      details: result.details,
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
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: Math.floor(Date.now() / 1000),
  });
});

// Handle GET requests to /broadcast with 405 Method Not Allowed
app.get("/broadcast", (_req, res) => {
  res.status(405).json({
    error: "Method not allowed",
    message: "Only POST requests are allowed for this endpoint",
  });
});

// Serve static files from dist/client
app.use(express.static(join(__dirname, "../../dist/client")));

// Serve index.html for all other routes to support client-side routing
app.get("*", (req, res) => {
  // Don't serve index.html for /ws routes
  if (req.path.startsWith("/ws")) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(join(__dirname, "../../dist/client/index.html"));
});

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  logger.info(`Server is running on port ${PORT}`);
  logger.info(`Server wallet address: ${account.address}`);
});

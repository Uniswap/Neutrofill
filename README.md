# Neutrofill

Neutrofill is an automated filler bot that processes inbound transaction requests from CompactX and executes them if deemed profitable. It maintains a server-side wallet and automatically submits transactions that meet profitability criteria.

## Features

- Accepts inbound POST requests for transaction execution
- Real-time ETH price monitoring across multiple chains via CoinGecko
- Profitability analysis before transaction submission
- Support for multiple chains (Ethereum, Optimism, Base, Unichain)
- WebSocket support for real-time transaction status updates
- Automated cross-chain token rebalancing via bridging using the Across Protocol
- Automated single-chain token rebalancing via swaps using the Uniswap API

## Getting Started

### Prerequisites

- Node.js 18+
- npm 9+

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Uniswap/Neutrofill.git
   cd Neutrofill
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up Git hooks:
   ```bash
   npx husky init
   ```

4. Copy `.env.example` to `.env` and configure your environment:
   ```bash
   cp .env.example .env
   ```

### Development

- Start the development server with hot reload:
  ```bash
  npm run dev
  ```

- Run type checking:
  ```bash
  npm run typecheck
  ```

- Run the test suite:
  ```bash
  npm test
  ```

- Format and lint code:
  ```bash
  npm run fix
  ```

### Building

Build both server and client:
```bash
npm run build
```

This will:
- Compile TypeScript server code to `dist/server/`
- Build React client to `dist/client/`

### Production

Start the production server in production mode:
```bash
npm start
```

Or start the production server with debug logs enabled:
```bash
npm run start:debug
```

## Cross-Chain Token Rebalancing

Neutrofill includes an automated cross-chain token rebalancing mechanism that helps maintain target token percentages across multiple blockchain networks. This maintatins sufficient funds on each supported chain to operate efficiently.

### Rebalancing Features

- Configurable target percentages for each chain
- Token-specific rebalancing priorities
- Automatic detection of chains that need funds
- Cooldown periods between rebalancing operations
- Minimum and maximum rebalance amounts
- Transaction tracking and status monitoring
- Event-based notifications for rebalance operations

### How It Works

For cross-chain bridging:
1. The system monitors token balances across all supported chains
2. When a chain's balance falls below its configured threshold, a rebalance operation is triggered
3. The system identifies a source chain with excess funds
4. Funds are transferred from the source chain to the destination chain using the Across Protocol
5. The operation is tracked until completion

For single-chain swapping, neutrofill uses the Uniswap API. Note that all swaps are performed on Unichain to allow for best execution with lowg gas costs.

### Configuration

Rebalancing is configured in `src/server/config/rebalance.ts`. You can customize:

- Target percentage for each chain / token
- Trigger thresholds for rebalancing
- Token priorities for rebalancing
- Global settings like minimum/maximum amounts and cooldown periods

## Configuration

The following environment variables are required:

- `PORT`: Server port (default: 3000)
- `PRIVATE_KEY`: Private key for the wallet that will execute transactions
- `RPC_URL_MAINNET`: Ethereum mainnet RPC URL
- `RPC_URL_OPTIMISM`: Optimism RPC URL
- `RPC_URL_BASE`: Base RPC URL
- `RPC_URL_UNICHAIN`: Unichain RPC URL
- `COINGECKO_API_KEY`: CoinGecko API key
- `UNISWAP_API_KEY`: Uniswap API key
- `COMPACT_INDEXER`: Graphql indexing service (e.g. Ponder node) for The Compact

## Supported Networks

- Mainnet (Chain ID: 1)
- Optimism (Chain ID: 10)
- Base (Chain ID: 8453)
- Unichain (Chain ID: 130)

## API Endpoints

### POST /broadcast

Submit a transaction for potential execution. Generally, this will be relayed from a service like [disseminator](https://github.com/Uniswap/disseminator) — reach out to be added as a webhook.

Request body must conform to the `BroadcastRequest` schema which includes:
- `chainId`: Chain ID where the resource lock resides (numeric string or hex)
- `compact`: Compact message object
  - `arbiter`: Ethereum address
  - `sponsor`: Ethereum address
  - `nonce`: 32-byte hex string
  - `expires`: Numeric string or hex
  - `id`: Numeric string or hex
  - `amount`: Numeric string or hex
  - `mandate`: Mandate object
- `sponsorSignature`: 64-byte hex string, '0x', or null (no signature indicates an onchain registration)
- `allocatorSignature`: 64-byte hex string
- `context`: Context object
  - `dispensation`: Numeric string or hex
  - `dispensationUSD`: String (can include $ prefix)
  - `spotOutputAmount`: Numeric string or hex
  - `quoteOutputAmountDirect`: Numeric string or hex
  - `quoteOutputAmountNet`: Numeric string or hex
  - `deltaAmount`: (optional) Numeric string or hex (can be negative)
  - `slippageBips`: (optional) Number between 0-10000
  - `witnessTypeString`: String
  - `witnessHash`: 32-byte hex string
  - `claimHash`: (optional) 32-byte hex string
- `claimHash`: (optional) 32-byte hex string

The `mandate` object represents parameters related to the fill chain and contains:
- `chainId`: Chain ID where the resource lock resides (positive number)
- `tribunal`: Ethereum address
- `recipient`: Ethereum address
- `expires`: Numeric string or hex
- `token`: Ethereum address
- `minimumAmount`: Numeric string or hex
- `baselinePriorityFee`: Numeric string or hex
- `scalingFactor`: Numeric string or hex
- `salt`: 32-byte hex string

Be sure that any ECDSA signatures are encoded in their "compact" representation using EIP-2098.

### GET /health

Check server health status.

Response:
```typescript
{
  status: "ok",
  timestamp: number  // Unix timestamp in seconds
}
```

### WebSocket Connection

Connect to `/ws` for real-time transaction status updates. Note: WebSocket endpoint does not support CORS - connections must originate from the same origin.

Message Types:

1. Connection Status (Server -> Client):
```typescript
{
  type: "connection",
  status: "connected" | "disconnected",
  timestamp: string  // ISO timestamp
}
```

2. Heartbeat (Bidirectional):
```typescript
{
  type: "ping" | "pong",
  timestamp: string  // ISO timestamp
}
```

3. Fill Request Status (Server -> Client):
```typescript
{
  type: "fillRequest",
  success: boolean,
  request: {
    chainId: string,
    compact: {
      arbiter: string,
      sponsor: string,
      nonce: string,
      expires: string,
      id: string,
      amount: string,
      mandate: {
        chainId: number,
        tribunal: string,
        recipient: string,
        expires: string,
        token: string,
        minimumAmount: string,
        baselinePriorityFee: string,
        scalingFactor: string,
        salt: string
      }
    },
    sponsorSignature: string | null,
    allocatorSignature: string,
    context: {
      dispensation: string,
      dispensationUSD: string,
      spotOutputAmount: string,
      quoteOutputAmountDirect: string,
      quoteOutputAmountNet: string,
      deltaAmount?: string,
      slippageBips?: number,
      witnessTypeString: string,
      witnessHash: string,
      claimHash?: string
    }
  },
  error?: string,  // Present only if success is false
  transactionHash?: string,  // Present only if success is true
  details?: {  // Present only if success is true
    dispensationUSD: number,
    gasCostUSD: number,
    netProfitUSD: number,
    minProfitUSD: number
  }
}
```

4. Price Update (Server -> Client):
```typescript
{
  type: "price_update",
  chainId: number,
  price: string,  // Price in USD
  timestamp: string  // ISO timestamp
}
```

5. Account Update (Server -> Client):
```typescript
{
  type: "account_update",
  account: string,
  chainId: number,
  balances: Record<string, string>,  // Token balances in wei
  timestamp: string  // ISO timestamp
}
```

6. Error (Server -> Client):
```typescript
{
  type: "error",
  code: string,
  message: string,
  timestamp: string  // ISO timestamp
}
```

## Code Quality

- TypeScript for type safety
- Biome for linting and formatting
- Jest for testing
- Husky for Git hooks
- lint-staged for pre-commit checks

## Deployment

The project includes a setup script for deploying to a cloud server with automatic HTTPS configuration using Let's Encrypt.

### Prerequisites

- A domain name pointing to your server (A record)
- Ubuntu-based cloud server
- SSH access to the server

### Deployment Steps

1. SSH into your server:
```bash
ssh user@your-server
```

2. Clone the repository:
```bash
git clone https://github.com/Uniswap/neutrofill.git
cd neutrofill
```

3. Run the setup script with your domain and IP:
```bash
./scripts/setup-server.sh your-domain.com your-server-ip
```

For example:
```bash
./scripts/setup-server.sh neutrofill.com 167.172.1.91
```

The script will:
- Install required dependencies (Node.js, nginx, certbot)
- Set up the project in /opt/neutrofill
- Configure nginx with WebSocket support
- Set up SSL certificates with Let's Encrypt
- Create and enable a systemd service
- Start the server

### Monitoring

Monitor the server status:
```bash
sudo systemctl status neutrofill
```

View server logs:
```bash
sudo journalctl -u neutrofill -f
```

### Testing Deployed Server

Test WebSocket connection:
```bash
wscat -c wss://your-domain.com/ws
```

Test broadcast endpoint:
```bash
curl -X POST https://your-domain.com/broadcast \
-H "Content-Type: application/json" \
-d '{ ... your payload ... }'
```

Test health endpoint:
```bash
curl https://your-domain.com/health
```

## License

MIT

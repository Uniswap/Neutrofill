# Neutrofill

Neutrofill is an automated filler bot that processes inbound transaction requests and executes them if deemed profitable. It maintains a server-side wallet and automatically submits transactions that meet profitability criteria.

## Features

- Accepts inbound POST requests for transaction execution
- Real-time ETH price monitoring across multiple chains via CoinGecko
- Profitability analysis before transaction submission
- Support for multiple chains (Ethereum, Optimism, Base)
- Configurable gas price multiplier for profitability calculations
- WebSocket support for real-time transaction status updates

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
npm start:debug
```

## Configuration

The following environment variables are required:

- `PORT`: Server port (default: 3000)
- `PRIVATE_KEY`: Private key for the wallet that will execute transactions
- `RPC_URL_MAINNET`: Ethereum mainnet RPC URL
- `RPC_URL_OPTIMISM`: Optimism RPC URL
- `RPC_URL_BASE`: Base RPC URL
- `RPC_URL_UNICHAIN`: Unichain RPC URL
- `COINGECKO_API_KEY`: CoinGecko API key
- `GAS_PRICE_MULTIPLIER`: Multiplier for gas price calculations (default: 1.1)

## Supported Networks

- Mainnet (Chain ID: 1)
- Optimism (Chain ID: 10)
- Base (Chain ID: 8453)
- Unichain (Chain ID: 130)

## API Endpoints

### POST /broadcast

Submit a transaction for potential execution.

Request body:
```typescript
{
  chainId: string;          // Chain ID where the transaction should be executed
  compact: {
    to: string;            // Target contract address
    amount: string;        // Amount in wei
    data: string;         // Transaction data
  };
  sponsorSignature?: string;    // Optional sponsor signature
  allocatorSignature?: string;  // Optional allocator signature
}
```

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

## License

MIT

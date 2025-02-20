# Neutrofill

Neutrofill is an automated filler bot that processes inbound transaction requests and executes them if deemed profitable. It maintains a server-side wallet and automatically submits transactions that meet profitability criteria.

## Features

- Accepts inbound POST requests for transaction execution
- Real-time ETH price monitoring across multiple chains via CoinGecko
- Profitability analysis before transaction submission
- Support for multiple chains (Ethereum, Optimism, Base)
- Configurable gas price multiplier for profitability calculations

## Setup

1. Clone the repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your configuration:
   ```bash
   cp .env.example .env
   ```
4. Build the TypeScript code:
   ```bash
   npm run build
   ```
5. Start the server:
   ```bash
   npm start
   ```

## Configuration

The following environment variables are required:

- `PORT`: Server port (default: 3000)
- `PRIVATE_KEY`: Private key for the wallet that will execute transactions
- `RPC_URL_MAINNET`: Ethereum mainnet RPC URL
- `RPC_URL_OPTIMISM`: Optimism RPC URL
- `RPC_URL_BASE`: Base RPC URL
- `COINGECKO_API_KEY`: CoinGecko API key (optional, uses free tier if not provided)
- `GAS_PRICE_MULTIPLIER`: Multiplier for gas price calculations (default: 1.1)

## API Endpoints

### POST /broadcast

Submit a transaction for potential execution.

Request body:
```json
{
  "chainId": 1,
  "to": "0x...",
  "data": "0x...",
  "value": "0",
  "gasLimit": "21000",
  "maxFeePerGas": "1000000000",
  "maxPriorityFeePerGas": "100000000"
}
```

Response:
```json
{
  "success": true,
  "transactionHash": "0x...",
  "gasCostUsd": 1.23
}
```

## Development

For local development:
```bash
npm run dev
```

## License

MIT

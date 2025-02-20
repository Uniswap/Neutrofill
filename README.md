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
    "chainId": "1",
    "compact": {
        "arbiter": "0x1234567890123456789012345678901234567890",
        "sponsor": "0x1234567890123456789012345678901234567890",
        "nonce": "0x1234567890123456789012345678901234567890123456789012345678901234",
        "expires": "1000000",
        "id": "23499701752147396106288076033874150844871292959348239827687418423535067463557",
        "amount": "1000000000000000000",
        "mandate": {
            "chainId": 1,
            "tribunal": "0x1234567890123456789012345678901234567890",
            "recipient": "0x1234567890123456789012345678901234567890",
            "expires": "1000000",
            "token": "0x1234567890123456789012345678901234567890",
            "minimumAmount": "1000000000000000000",
            "baselinePriorityFee": "1000000000",
            "scalingFactor": "1000000000",
            "salt": "0x1234567890123456789012345678901234567890123456789012345678901234"
        }
    },
    "sponsorSignature": null,
    "allocatorSignature": "0x1234567890123456789012345678901234567890123456789012345678901234123456789012345678901234567890123456789012345678901234567890123456",
    "context": {
        "dispensation": "1000000000000000000",
        "dispensationUSD": "$1000.00",
        "spotOutputAmount": "1000000000000000000",
        "quoteOutputAmountDirect": "1000000000000000000",
        "quoteOutputAmountNet": "1000000000000000000",
        "witnessTypeString": "witness",
        "witnessHash": "0x1234567890123456789012345678901234567890123456789012345678901234"
    }
}
```

Response:
```json
{
    "success": true,
    "transactionHash": "0x...",
    "details": {
        "dispensationUSD": 1000.00,
        "gasCostUSD": 1.23,
        "netProfitUSD": 998.77,
        "minProfitUSD": 0.5
    }
}
```

## Development

For local development:
```bash
npm run dev
```

## License

MIT

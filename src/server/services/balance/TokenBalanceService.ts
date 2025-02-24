import { EventEmitter } from "node:events";
import type { PublicClient } from "viem";
import { CHAIN_CONFIG, type SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";

// Standard ERC20 ABI for balanceOf
const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
    stateMutability: "view",
  } as const,
];

interface TokenBalance {
  ETH: bigint;
  WETH: bigint;
  USDC: bigint;
  lastUpdated: number;
}

export class TokenBalanceService extends EventEmitter {
  private balances: Map<SupportedChainId, TokenBalance>;
  private logger: Logger;
  private readonly clients: { [chainId: number]: PublicClient };
  private updateInterval: NodeJS.Timeout | null;
  private readonly UPDATE_INTERVAL = 2000; // 2 seconds
  private readonly accountAddress: `0x${string}`;

  constructor(
    accountAddress: `0x${string}`,
    chainClients: { [chainId: number]: PublicClient }
  ) {
    super();
    this.balances = new Map();
    this.logger = new Logger("TokenBalanceService");
    this.clients = chainClients;
    this.updateInterval = null;
    this.accountAddress = accountAddress;
  }

  public start(): void {
    if (this.updateInterval) {
      return;
    }

    // Initial balance fetch
    this.updateBalances().catch((error) => {
      this.logger.error("Failed to fetch initial balances:", error);
    });

    // Set up periodic updates
    this.updateInterval = setInterval(() => {
      this.updateBalances().catch((error) => {
        this.logger.error("Failed to update balances:", error);
      });
    }, this.UPDATE_INTERVAL);

    this.logger.info("Balance monitoring started");
  }

  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.logger.info("Balance monitoring stopped");
    }
  }

  public getBalances(chainId: SupportedChainId): TokenBalance | undefined {
    return this.balances.get(chainId);
  }

  public getClients(): { [chainId: number]: PublicClient } {
    return this.clients;
  }

  private async updateBalances(): Promise<void> {
    try {
      await Promise.all(
        Object.entries(this.clients).map(async ([chainId, client]) => {
          const numericChainId = Number(chainId) as SupportedChainId;
          const config = CHAIN_CONFIG[numericChainId];
          const balances: TokenBalance = {
            ETH: 0n,
            WETH: 0n,
            USDC: 0n,
            lastUpdated: Date.now(),
          };

          // Get native ETH balance
          balances.ETH = await client.getBalance({
            address: this.accountAddress,
          });

          // Get ERC20 token balances using readContract like TheCompactService
          const [wethBalance, usdcBalance] = await Promise.all([
            client.readContract({
              address: config.tokens.WETH.address,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [this.accountAddress],
            }),
            client.readContract({
              address: config.tokens.USDC.address,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [this.accountAddress],
            }),
          ]);

          balances.WETH = wethBalance;
          balances.USDC = usdcBalance;

          this.balances.set(numericChainId, balances);
          this.logger.debug(
            `Updated balances for chain ${chainId}: ETH=${balances.ETH}, WETH=${balances.WETH}, USDC=${balances.USDC}`
          );

          // Emit balance update event
          this.emit("balance_update", numericChainId, this.accountAddress, {
            ETH: balances.ETH.toString(),
            WETH: balances.WETH.toString(),
            USDC: balances.USDC.toString(),
          });
        })
      );

      this.logger.debug("Balances updated successfully");
    } catch (error) {
      this.logger.error("Failed to update balances:", error);
    }
  }
}

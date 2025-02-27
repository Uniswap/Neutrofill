import { EventEmitter } from "node:events";
import type { Address, PublicClient, WalletClient } from "viem";
import { Logger } from "../../utils/logger.js";
import { UniswapRebalanceService } from "./UniswapRebalanceService.js";
import type { AggregateBalanceService } from "../balance/AggregateBalanceService.js";
import type { TokenBalanceService } from "../balance/TokenBalanceService.js";
import type {
  AggregateBalance,
  TokenBalance as ChainTokenBalance,
} from "../../types/balance.js";

interface UniswapTokenRebalanceTarget {
  symbol: string;
  targetPercentage: number;
  triggerThreshold: number;
}

/**
 * Service for automatically rebalancing token balances on Unichain using Uniswap
 * based on the aggregate balance percentages across all chains
 */
export class UniswapBalanceRebalancerService extends EventEmitter {
  private readonly logger: Logger;
  private readonly uniswapRebalanceService: UniswapRebalanceService;
  private readonly aggregateBalanceService: AggregateBalanceService;
  private readonly tokenBalanceService: TokenBalanceService;
  private readonly accountAddress: Address;
  private readonly UNICHAIN_ID = 130;
  private readonly MIN_ETH_BALANCE = 0.01; // Minimum ETH to keep on Unichain
  private readonly tokenTargets: UniswapTokenRebalanceTarget[];
  private isRebalancing = false;
  private lastRebalanceTime = 0;
  private readonly REBALANCE_COOLDOWN = 60000; // 1 minute cooldown between rebalances

  constructor(
    publicClients: Record<number, PublicClient>,
    walletClients: Record<number, WalletClient>,
    accountAddress: Address,
    aggregateBalanceService: AggregateBalanceService,
    tokenBalanceService: TokenBalanceService
  ) {
    super();
    this.logger = new Logger("UniswapBalanceRebalancerService");
    this.uniswapRebalanceService = new UniswapRebalanceService(
      publicClients,
      walletClients,
      accountAddress
    );
    this.aggregateBalanceService = aggregateBalanceService;
    this.tokenBalanceService = tokenBalanceService;
    this.accountAddress = accountAddress;

    // Define token targets and thresholds
    this.tokenTargets = [
      { symbol: "ETH", targetPercentage: 40, triggerThreshold: 30 },
      { symbol: "WETH", targetPercentage: 20, triggerThreshold: 10 },
      { symbol: "USDC", targetPercentage: 40, triggerThreshold: 30 },
    ];

    this.logger.info("UniswapBalanceRebalancerService initialized");
  }

  /**
   * Start monitoring aggregate balances and trigger rebalancing when needed
   */
  public start(): void {
    this.logger.info("Starting Uniswap balance rebalancer");

    // Listen for aggregate balance updates
    this.aggregateBalanceService.on(
      "aggregate_balance_update",
      this.handleBalanceUpdate.bind(this)
    );

    this.logger.info("Uniswap balance rebalancer started");
  }

  /**
   * Stop monitoring aggregate balances
   */
  public stop(): void {
    this.logger.info("Stopping Uniswap balance rebalancer");

    // Remove event listener
    this.aggregateBalanceService.off(
      "aggregate_balance_update",
      this.handleBalanceUpdate.bind(this)
    );

    this.logger.info("Uniswap balance rebalancer stopped");
  }

  /**
   * Handle aggregate balance updates and trigger rebalancing if needed
   */
  private async handleBalanceUpdate(balances: AggregateBalance): Promise<void> {
    try {
      // Skip if already rebalancing
      if (this.isRebalancing) {
        this.logger.debug(
          "Skipping balance check - rebalance already in progress"
        );
        return;
      }

      // Check cooldown period
      const now = Date.now();
      if (now - this.lastRebalanceTime < this.REBALANCE_COOLDOWN) {
        this.logger.debug("Skipping balance check - in cooldown period");
        return;
      }

      this.logger.debug(
        "Checking if rebalance is needed based on token percentages"
      );

      // Check if any token is below its threshold
      const tokensBelowThreshold = this.tokenTargets.filter(
        (target) =>
          balances.tokenBalances.percentages[
            target.symbol as keyof typeof balances.tokenBalances.percentages
          ] < target.triggerThreshold
      );

      if (tokensBelowThreshold.length === 0) {
        this.logger.debug("No tokens below threshold, no rebalance needed");
        return;
      }

      // Find the token that's furthest below its target (as a percentage of the target)
      const deficitToken = tokensBelowThreshold.reduce((prev, current) => {
        const prevDeficit =
          (prev.targetPercentage -
            balances.tokenBalances.percentages[
              prev.symbol as keyof typeof balances.tokenBalances.percentages
            ]) /
          prev.targetPercentage;

        const currentDeficit =
          (current.targetPercentage -
            balances.tokenBalances.percentages[
              current.symbol as keyof typeof balances.tokenBalances.percentages
            ]) /
          current.targetPercentage;

        return currentDeficit > prevDeficit ? current : prev;
      });

      // Find the token that's furthest above its target (as a percentage of the target)
      const excessToken = this.tokenTargets.reduce((prev, current) => {
        // Skip the deficit token
        if (current.symbol === deficitToken.symbol) return prev;

        const prevExcess =
          (balances.tokenBalances.percentages[
            prev.symbol as keyof typeof balances.tokenBalances.percentages
          ] -
            prev.targetPercentage) /
          prev.targetPercentage;

        const currentExcess =
          (balances.tokenBalances.percentages[
            current.symbol as keyof typeof balances.tokenBalances.percentages
          ] -
            current.targetPercentage) /
          current.targetPercentage;

        return currentExcess > prevExcess ? current : prev;
      });

      // Check if we have a valid excess token
      if (
        balances.tokenBalances.percentages[
          excessToken.symbol as keyof typeof balances.tokenBalances.percentages
        ] <= excessToken.targetPercentage
      ) {
        this.logger.debug("No tokens above target, cannot rebalance");
        return;
      }

      this.logger.info(
        `Rebalance needed: ${deficitToken.symbol} is below threshold at ${balances.tokenBalances.percentages[
          deficitToken.symbol as keyof typeof balances.tokenBalances.percentages
        ].toFixed(2)}% (target: ${deficitToken.targetPercentage}%, threshold: ${
          deficitToken.triggerThreshold
        }%)`
      );

      this.logger.info(
        `Will swap from ${excessToken.symbol} at ${balances.tokenBalances.percentages[
          excessToken.symbol as keyof typeof balances.tokenBalances.percentages
        ].toFixed(2)}% (target: ${excessToken.targetPercentage}%)`
      );

      // Calculate the amount to swap
      await this.executeRebalance(
        excessToken.symbol,
        deficitToken.symbol,
        balances
      );
    } catch (error) {
      this.logger.error("Error handling balance update:", error);
    }
  }

  /**
   * Execute a rebalance by swapping from one token to another
   */
  private async executeRebalance(
    fromToken: string,
    toToken: string,
    balances: AggregateBalance
  ): Promise<void> {
    try {
      this.isRebalancing = true;
      this.lastRebalanceTime = Date.now();

      // Get Unichain balances
      const unichainBalances = this.tokenBalanceService.getBalances(
        this.UNICHAIN_ID
      );
      if (!unichainBalances) {
        this.logger.error("Cannot rebalance - Unichain balances not available");
        this.isRebalancing = false;
        return;
      }

      // Calculate the amount to swap
      // We want to move enough to bring the deficit token up to its target
      // and the excess token down to its target
      const totalUsdValue = balances.totalBalance;
      const deficitTokenTarget = this.tokenTargets.find(
        (t) => t.symbol === toToken
      );
      if (!deficitTokenTarget) {
        this.logger.error(
          `Cannot find target configuration for token ${toToken}`
        );
        this.isRebalancing = false;
        return;
      }

      const excessTokenTarget = this.tokenTargets.find(
        (t) => t.symbol === fromToken
      );
      if (!excessTokenTarget) {
        this.logger.error(
          `Cannot find target configuration for token ${fromToken}`
        );
        this.isRebalancing = false;
        return;
      }

      // Calculate the USD value we need to move
      const deficitTokenCurrentUsd =
        balances.tokenBalances.usd[
          toToken as keyof typeof balances.tokenBalances.usd
        ];
      const deficitTokenTargetUsd =
        (deficitTokenTarget.targetPercentage / 100) * totalUsdValue;
      const usdToMove = deficitTokenTargetUsd - deficitTokenCurrentUsd;

      // Calculate how much of the excess token this represents
      const excessTokenCurrentUsd =
        balances.tokenBalances.usd[
          fromToken as keyof typeof balances.tokenBalances.usd
        ];
      const excessTokenPrice =
        excessTokenCurrentUsd /
        (Number(
          balances.tokenBalances.tokens[
            fromToken as keyof typeof balances.tokenBalances.tokens
          ]
        ) /
          (fromToken === "USDC" ? 1e6 : 1e18));

      // Calculate the amount to swap in token units
      let amountToSwap = usdToMove / excessTokenPrice;

      // Ensure we don't swap more than available on Unichain
      const unichainTokenBalance =
        Number(unichainBalances[fromToken as keyof typeof unichainBalances]) /
        (fromToken === "USDC" ? 1e6 : 1e18);

      if (amountToSwap > unichainTokenBalance) {
        this.logger.info(
          `Limiting swap amount to available balance on Unichain: ${unichainTokenBalance} ${fromToken}`
        );
        amountToSwap = unichainTokenBalance;
      }

      // If swapping from ETH, ensure we leave the minimum balance
      if (
        fromToken === "ETH" &&
        unichainTokenBalance - amountToSwap < this.MIN_ETH_BALANCE
      ) {
        const newAmount = unichainTokenBalance - this.MIN_ETH_BALANCE;
        if (newAmount <= 0) {
          this.logger.info(
            `Cannot swap ETH - would leave less than minimum balance of ${this.MIN_ETH_BALANCE} ETH`
          );
          this.isRebalancing = false;
          return;
        }

        this.logger.info(
          `Limiting ETH swap to ${newAmount} to maintain minimum balance of ${this.MIN_ETH_BALANCE} ETH`
        );
        amountToSwap = newAmount;
      }

      // Ensure the amount is reasonable (not too small)
      if (amountToSwap < 0.001 && fromToken !== "USDC") {
        this.logger.info(
          `Swap amount too small (${amountToSwap} ${fromToken}), skipping rebalance`
        );
        this.isRebalancing = false;
        return;
      }

      if (fromToken === "USDC" && amountToSwap < 1) {
        this.logger.info(
          `Swap amount too small (${amountToSwap} ${fromToken}), skipping rebalance`
        );
        this.isRebalancing = false;
        return;
      }

      // Round to a reasonable number of decimal places
      amountToSwap =
        fromToken === "USDC"
          ? Math.floor(amountToSwap * 100) / 100 // 2 decimal places for USDC
          : Math.floor(amountToSwap * 1000) / 1000; // 3 decimal places for ETH/WETH

      this.logger.info(
        `Executing rebalance: Swapping ${amountToSwap} ${fromToken} to ${toToken} on Unichain`
      );

      // Get a quote first to estimate the output
      const quote = await this.uniswapRebalanceService.getSwapQuote(
        fromToken,
        toToken,
        amountToSwap
      );

      this.logger.info(
        `Swap quote: ${amountToSwap} ${fromToken} → ${quote.outputAmount} ${toToken} (Price impact: ${quote.priceImpact.toFixed(2)}%)`
      );

      // Execute the swap
      const txHash = await this.uniswapRebalanceService.rebalanceBySwap(
        fromToken,
        toToken,
        amountToSwap
      );

      this.logger.info(`Rebalance swap transaction sent: ${txHash}`);

      // Emit rebalance event
      this.emit("uniswap_rebalance", {
        fromToken,
        toToken,
        amount: amountToSwap,
        txHash,
        timestamp: Date.now(),
      });
    } catch (error) {
      this.logger.error("Error executing rebalance:", error);
    } finally {
      this.isRebalancing = false;
    }
  }
}

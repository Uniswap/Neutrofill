import type { Address, PublicClient, WalletClient } from "viem";
import { CHAIN_CONFIG } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import { UniswapService } from "./UniswapService.js";

/**
 * Service for rebalancing funds on Unichain using Uniswap
 */
export class UniswapRebalanceService {
  private readonly logger: Logger;
  private readonly uniswapService: UniswapService;
  private readonly publicClient: PublicClient;
  private readonly walletClient: WalletClient;
  private readonly accountAddress: Address;
  private readonly UNICHAIN_ID = 130;

  constructor(
    publicClients: Record<number, PublicClient>,
    walletClients: Record<number, WalletClient>,
    accountAddress: Address
  ) {
    this.logger = new Logger("UniswapRebalanceService");
    this.publicClient = publicClients[this.UNICHAIN_ID];
    this.walletClient = walletClients[this.UNICHAIN_ID];
    this.accountAddress = accountAddress;
    this.uniswapService = new UniswapService(this.walletClient);

    if (!this.publicClient || !this.walletClient) {
      throw new Error(
        `Missing client for Unichain (chainId: ${this.UNICHAIN_ID})`
      );
    }
  }

  /**
   * Rebalance by swapping one token for another on Unichain
   * @param tokenInSymbol - Input token symbol (e.g., "USDC", "ETH", "WETH")
   * @param tokenOutSymbol - Output token symbol (e.g., "USDC", "ETH", "WETH")
   * @param amount - Amount to swap in native token units (e.g., 1.5 for 1.5 USDC)
   * @param slippageTolerance - Slippage tolerance percentage (default: 0.5%)
   * @returns Transaction hash of the swap transaction
   */
  public async rebalanceBySwap(
    tokenInSymbol: string,
    tokenOutSymbol: string,
    amount: number,
    slippageTolerance = 0.5
  ): Promise<string> {
    try {
      this.logger.info(
        `Rebalancing by swapping ${amount} ${tokenInSymbol} to ${tokenOutSymbol} on Unichain`
      );

      // Get token configs
      const chainConfig = CHAIN_CONFIG[this.UNICHAIN_ID];
      if (!chainConfig) {
        throw new Error(`Unsupported chain ID: ${this.UNICHAIN_ID}`);
      }

      const tokenInConfig = chainConfig.tokens[tokenInSymbol];
      if (!tokenInConfig) {
        throw new Error(
          `Unsupported token ${tokenInSymbol} on chain ${this.UNICHAIN_ID}`
        );
      }

      const tokenOutConfig = chainConfig.tokens[tokenOutSymbol];
      if (!tokenOutConfig) {
        throw new Error(
          `Unsupported token ${tokenOutSymbol} on chain ${this.UNICHAIN_ID}`
        );
      }

      // Convert amount to raw amount with proper decimal handling
      const rawAmount = BigInt(
        Math.round(amount * 10 ** tokenInConfig.decimals)
      ).toString();

      this.logger.debug(
        `Converting ${amount} ${tokenInSymbol} to raw amount ${rawAmount} (${tokenInConfig.decimals} decimals)`
      );

      // Execute the swap flow
      const swapResult = await this.uniswapService.executeSwap(
        tokenInConfig.address,
        tokenOutConfig.address,
        rawAmount,
        this.accountAddress,
        slippageTolerance
      );

      // If approval is required, execute the approval transaction first
      if (swapResult.requiresApproval && swapResult.approvalTransaction) {
        this.logger.info(`Executing approval transaction for ${tokenInSymbol}`);

        const approvalTx = {
          ...swapResult.approvalTransaction,
          chainId: this.UNICHAIN_ID,
        };

        // Get the account and chain from the wallet client
        const account = this.walletClient.account;
        if (!account) {
          throw new Error("No account found in wallet client");
        }

        const chain = this.walletClient.chain;

        const approvalHash = await this.walletClient.sendTransaction({
          account,
          chain,
          to: approvalTx.to as Address,
          data: approvalTx.data as `0x${string}`,
          value: BigInt(approvalTx.value || "0"),
        });

        this.logger.info(`Approval transaction sent: ${approvalHash}`);

        // Wait for approval transaction to be confirmed
        this.logger.info("Waiting for approval transaction to be confirmed...");
        await this.publicClient.waitForTransactionReceipt({
          hash: approvalHash,
        });

        this.logger.info("Approval transaction confirmed");
      }

      // Execute the swap transaction
      if (!swapResult.swapTransaction) {
        throw new Error("No swap transaction returned from Uniswap API");
      }

      const swapTx = {
        ...swapResult.swapTransaction,
        chainId: this.UNICHAIN_ID,
      };

      this.logger.info("Executing swap transaction");
      // Get the account and chain from the wallet client
      const account = this.walletClient.account;
      if (!account) {
        throw new Error("No account found in wallet client");
      }

      const chain = this.walletClient.chain;

      const swapHash = await this.walletClient.sendTransaction({
        account,
        chain,
        to: swapTx.to as Address,
        data: swapTx.data as `0x${string}`,
        value: BigInt(swapTx.value || "0"),
      });

      this.logger.info(`Swap transaction sent: ${swapHash}`);

      return swapHash;
    } catch (error) {
      this.logger.error("Error rebalancing by swap:", error);
      throw error;
    }
  }

  /**
   * Get a quote for swapping one token for another on Unichain
   * @param tokenInSymbol - Input token symbol (e.g., "USDC", "ETH", "WETH")
   * @param tokenOutSymbol - Output token symbol (e.g., "USDC", "ETH", "WETH")
   * @param amount - Amount to swap in native token units (e.g., 1.5 for 1.5 USDC)
   * @param slippageTolerance - Slippage tolerance percentage (default: 0.5%)
   * @returns Quote information including expected output amount
   */
  public async getSwapQuote(
    tokenInSymbol: string,
    tokenOutSymbol: string,
    amount: number,
    slippageTolerance = 0.5
  ) {
    try {
      // Get token configs
      const chainConfig = CHAIN_CONFIG[this.UNICHAIN_ID];
      if (!chainConfig) {
        throw new Error(`Unsupported chain ID: ${this.UNICHAIN_ID}`);
      }

      const tokenInConfig = chainConfig.tokens[tokenInSymbol];
      if (!tokenInConfig) {
        throw new Error(
          `Unsupported token ${tokenInSymbol} on chain ${this.UNICHAIN_ID}`
        );
      }

      const tokenOutConfig = chainConfig.tokens[tokenOutSymbol];
      if (!tokenOutConfig) {
        throw new Error(
          `Unsupported token ${tokenOutSymbol} on chain ${this.UNICHAIN_ID}`
        );
      }

      // Convert amount to raw amount with proper decimal handling
      const rawAmount = BigInt(
        Math.round(amount * 10 ** tokenInConfig.decimals)
      ).toString();

      // Get quote from Uniswap
      const quoteResponse = await this.uniswapService.getQuote({
        type: "EXACT_INPUT",
        amount: rawAmount,
        tokenInChainId: this.UNICHAIN_ID,
        tokenOutChainId: this.UNICHAIN_ID,
        tokenIn: tokenInConfig.address,
        tokenOut: tokenOutConfig.address,
        swapper: this.accountAddress,
        slippageTolerance,
        routingPreference: "BEST_PRICE",
      });

      // Extract and format the output amount
      const outputAmount = quoteResponse.quote?.output?.amount || "0";
      const formattedOutputAmount =
        Number(outputAmount) / 10 ** tokenOutConfig.decimals;

      return {
        inputToken: tokenInSymbol,
        outputToken: tokenOutSymbol,
        inputAmount: amount,
        outputAmount: formattedOutputAmount,
        priceImpact: quoteResponse.quote?.priceImpact || 0,
        gasFeeUSD: quoteResponse.quote?.gasFeeUSD || "0",
        routing: quoteResponse.routing,
        quoteId: quoteResponse.requestId,
      };
    } catch (error) {
      this.logger.error("Error getting swap quote:", error);
      throw error;
    }
  }
}

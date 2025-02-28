import type { Address, PublicClient, WalletClient } from "viem";
import { AcrossService } from "./AcrossService.js";
import { Logger } from "../../utils/logger.js";
import { CHAIN_CONFIG, type SupportedChainId } from "../../config/constants.js";

/**
 * Service for rebalancing funds between chains using Across Protocol
 */
export class RebalanceService {
  private readonly logger: Logger;
  private readonly acrossService: AcrossService;
  private readonly publicClients: Record<number, PublicClient>;
  private readonly walletClients: Record<number, WalletClient>;
  private readonly accountAddress: Address;

  constructor(
    publicClients: Record<number, PublicClient>,
    walletClients: Record<number, WalletClient>,
    accountAddress: Address,
    acrossUniqueIdentifier?: string
  ) {
    this.logger = new Logger("RebalanceService");
    this.publicClients = publicClients;
    this.walletClients = walletClients;
    this.accountAddress = accountAddress;
    this.acrossService = new AcrossService(
      publicClients,
      walletClients,
      acrossUniqueIdentifier
    );
  }

  /**
   * Rebalance a specific token from one chain to another
   * @param fromChainId - Source chain ID
   * @param toChainId - Destination chain ID
   * @param tokenSymbol - Token symbol (e.g., "USDC", "ETH", "WETH")
   * @param amount - Amount to rebalance in native token units (e.g., 1.5 for 1.5 USDC)
   * @returns Transaction hash of the bridge transaction
   */
  public async rebalanceToken(
    fromChainId: SupportedChainId,
    toChainId: SupportedChainId,
    tokenSymbol: string,
    amount: number
  ): Promise<string> {
    try {
      this.logger.info(
        `Rebalancing ${amount} ${tokenSymbol} from chain ${fromChainId} to chain ${toChainId}`
      );

      // Get token config from source chain
      const sourceChainConfig = CHAIN_CONFIG[fromChainId];
      if (!sourceChainConfig) {
        throw new Error(`Unsupported source chain ID: ${fromChainId}`);
      }

      const tokenConfig = sourceChainConfig.tokens[tokenSymbol];
      if (!tokenConfig) {
        throw new Error(
          `Unsupported token ${tokenSymbol} on chain ${fromChainId}`
        );
      }

      // Convert amount to raw amount with proper decimal handling
      // Use Math.round instead of Math.floor to handle potential floating point precision issues
      const rawAmount = BigInt(
        Math.round(amount * 10 ** tokenConfig.decimals)
      ).toString();

      this.logger.debug(
        `Converting ${amount} ${tokenSymbol} to raw amount ${rawAmount} (${tokenConfig.decimals} decimals)`
      );

      // For ETH transfers, we need to use WETH address for the API call
      // but we'll still use the null address (ETH) for the actual deposit params
      let apiTokenAddress = tokenConfig.address;
      const isEthTransfer =
        tokenConfig.address === "0x0000000000000000000000000000000000000000";

      if (isEthTransfer) {
        // Get the WETH address from the source chain configuration
        if (sourceChainConfig.tokens.WETH) {
          apiTokenAddress = sourceChainConfig.tokens.WETH.address;
          this.logger.info(
            `Using WETH address ${apiTokenAddress} for API call on chain ${fromChainId}`
          );
        } else {
          throw new Error(`WETH token not found on chain ${fromChainId}`);
        }
      }

      // Get suggested fees from Across
      const feeResponse = await this.acrossService.getSuggestedFees({
        originChainId: fromChainId,
        destinationChainId: toChainId,
        token: apiTokenAddress,
        amount: rawAmount,
      });

      // Check if the amount is within limits
      if (BigInt(rawAmount) < BigInt(feeResponse.limits.minDeposit)) {
        throw new Error(
          `Amount ${amount} ${tokenSymbol} is below minimum deposit limit of ${
            BigInt(feeResponse.limits.minDeposit) /
            BigInt(10 ** tokenConfig.decimals)
          } ${tokenSymbol}`
        );
      }

      if (BigInt(rawAmount) > BigInt(feeResponse.limits.maxDeposit)) {
        throw new Error(
          `Amount ${amount} ${tokenSymbol} exceeds maximum deposit limit of ${
            BigInt(feeResponse.limits.maxDeposit) /
            BigInt(10 ** tokenConfig.decimals)
          } ${tokenSymbol}`
        );
      }

      // Prepare deposit parameters - we use the original token address here
      // The AcrossService.executeDeposit method will handle the conversion for ETH transfers
      const depositParams = this.acrossService.prepareDepositParams(
        feeResponse,
        this.accountAddress,
        tokenConfig.address, // Original token address (ETH or other token)
        BigInt(rawAmount),
        toChainId,
        undefined,
        "0x0000000000000000000000000000000000000000"
      );

      // Execute the deposit
      const txHash = await this.acrossService.executeDeposit(
        fromChainId,
        depositParams
      );

      this.logger.info(
        `Rebalance transaction sent: ${txHash}. Expected fill time: ${
          feeResponse.estimatedFillTimeSec / 60
        } minutes`
      );

      return txHash;
    } catch (error) {
      this.logger.error("Error rebalancing token:", error);
      throw error;
    }
  }

  /**
   * Check the status of a rebalance transaction
   * @param originChainId - Source chain ID
   * @param depositId - Deposit ID from the transaction
   * @returns Status of the deposit
   */
  public async checkRebalanceStatus(
    originChainId: SupportedChainId,
    depositId: string
  ) {
    try {
      return await this.acrossService.getDepositStatus({
        originChainId,
        depositId,
      });
    } catch (error) {
      this.logger.error("Error checking rebalance status:", error);
      throw error;
    }
  }

  /**
   * Get the estimated fees for a rebalance operation
   * @param fromChainId - Source chain ID
   * @param toChainId - Destination chain ID
   * @param tokenSymbol - Token symbol (e.g., "USDC", "ETH", "WETH")
   * @param amount - Amount to rebalance in native token units (e.g., 1.5 for 1.5 USDC)
   * @returns Fee information and estimated fill time
   */
  public async getRebalanceFeeEstimate(
    fromChainId: SupportedChainId,
    toChainId: SupportedChainId,
    tokenSymbol: string,
    amount: number
  ) {
    try {
      // Get token config from source chain
      const sourceChainConfig = CHAIN_CONFIG[fromChainId];
      if (!sourceChainConfig) {
        throw new Error(`Unsupported source chain ID: ${fromChainId}`);
      }

      const tokenConfig = sourceChainConfig.tokens[tokenSymbol];
      if (!tokenConfig) {
        throw new Error(
          `Unsupported token ${tokenSymbol} on chain ${fromChainId}`
        );
      }

      // Convert amount to raw amount (e.g., 1 USDC = 1e6)
      const rawAmount = BigInt(
        Math.floor(amount * 10 ** tokenConfig.decimals)
      ).toString();

      // For ETH transfers, we need to use WETH address for the API call
      let apiTokenAddress = tokenConfig.address;
      const isEthTransfer =
        tokenConfig.address === "0x0000000000000000000000000000000000000000";

      if (isEthTransfer) {
        // Get the WETH address from the source chain configuration
        if (sourceChainConfig.tokens.WETH) {
          apiTokenAddress = sourceChainConfig.tokens.WETH.address;
          this.logger.info(
            `Using WETH address ${apiTokenAddress} for fee estimation on chain ${fromChainId}`
          );
        } else {
          throw new Error(`WETH token not found on chain ${fromChainId}`);
        }
      }

      // Get suggested fees from Across
      const feeResponse = await this.acrossService.getSuggestedFees({
        originChainId: fromChainId,
        destinationChainId: toChainId,
        token: apiTokenAddress,
        amount: rawAmount,
      });

      // Convert raw fee to native token units
      const totalFee =
        Number(feeResponse.totalRelayFee.total) / 10 ** tokenConfig.decimals;

      return {
        fee: totalFee,
        feeToken: tokenSymbol,
        estimatedFillTime: feeResponse.estimatedFillTimeSec,
        maxDepositInstant: Number(
          BigInt(feeResponse.limits.maxDepositInstant) /
            BigInt(10 ** tokenConfig.decimals)
        ),
        maxDepositShortDelay: Number(
          BigInt(feeResponse.limits.maxDepositShortDelay) /
            BigInt(10 ** tokenConfig.decimals)
        ),
        maxDeposit: Number(
          BigInt(feeResponse.limits.maxDeposit) /
            BigInt(10 ** tokenConfig.decimals)
        ),
      };
    } catch (error) {
      this.logger.error("Error getting rebalance fee estimate:", error);
      throw error;
    }
  }
}

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

      // Convert amount to raw amount (e.g., 1 USDC = 1e6)
      const rawAmount = BigInt(
        Math.floor(amount * 10 ** tokenConfig.decimals)
      ).toString();

      // Get suggested fees from Across
      const feeResponse = await this.acrossService.getSuggestedFees({
        originChainId: fromChainId,
        destinationChainId: toChainId,
        token: tokenConfig.address,
        amount: rawAmount,
      });

      // Check if the amount is within limits
      if (BigInt(rawAmount) > BigInt(feeResponse.maxDeposit)) {
        throw new Error(
          `Amount ${amount} ${tokenSymbol} exceeds maximum deposit limit of ${
            BigInt(feeResponse.maxDeposit) / BigInt(10 ** tokenConfig.decimals)
          } ${tokenSymbol}`
        );
      }

      // Prepare deposit parameters
      const depositParams = this.acrossService.prepareDepositParams(
        feeResponse,
        this.accountAddress,
        tokenConfig.address,
        BigInt(rawAmount)
      );

      // Execute the deposit
      const txHash = await this.acrossService.executeDeposit(
        fromChainId,
        depositParams
      );

      this.logger.info(
        `Rebalance transaction sent: ${txHash}. Expected fill time: ${
          feeResponse.estimateFillTimeSec / 60
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

      // Get suggested fees from Across
      const feeResponse = await this.acrossService.getSuggestedFees({
        originChainId: fromChainId,
        destinationChainId: toChainId,
        token: tokenConfig.address,
        amount: rawAmount,
      });

      // Convert raw fee to native token units
      const totalFee =
        Number(feeResponse.totalRelayFee.total) / 10 ** tokenConfig.decimals;

      return {
        fee: totalFee,
        feeToken: tokenSymbol,
        estimatedFillTime: feeResponse.estimateFillTimeSec,
        fillSpeedType: feeResponse.fillSpeedType,
        maxDepositInstant:
          BigInt(feeResponse.maxDepositInstant) /
          BigInt(10 ** tokenConfig.decimals),
        maxDepositShortDelay:
          BigInt(feeResponse.maxDepositShortDelay) /
          BigInt(10 ** tokenConfig.decimals),
        maxDeposit:
          BigInt(feeResponse.maxDeposit) / BigInt(10 ** tokenConfig.decimals),
      };
    } catch (error) {
      this.logger.error("Error getting rebalance fee estimate:", error);
      throw error;
    }
  }
}

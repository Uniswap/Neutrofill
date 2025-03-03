import type { Address, PublicClient, WalletClient } from "viem";
import {
  CHAIN_CONFIG,
  SUPPORTED_CHAINS,
  type SupportedChainId,
} from "../../config/constants.js";
import { DEFAULT_REBALANCE_CONFIG } from "../../config/rebalance.js";
import { Logger } from "../../utils/logger.js";
import { AcrossService } from "./AcrossService.js";

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
      // Prevent rebalancing to and from the same chain
      if (fromChainId === toChainId) {
        throw new Error(`Cannot rebalance from chain ${fromChainId} to itself`);
      }

      // Get destination chain config
      const destChainConfig =
        DEFAULT_REBALANCE_CONFIG.chains[
          toChainId as keyof typeof DEFAULT_REBALANCE_CONFIG.chains
        ];
      if (!destChainConfig) {
        throw new Error(`Unsupported destination chain: ${toChainId}`);
      }

      // Check if destination chain can be a destination
      if (!destChainConfig.canBeDestination) {
        throw new Error(
          `Chain ${toChainId} cannot be a destination for rebalancing`
        );
      }

      // Ensure amount is positive
      if (amount <= 0) {
        throw new Error(`Rebalance amount must be positive, got: ${amount}`);
      }

      this.logger.info(
        `Rebalancing ${amount} ${tokenSymbol} from chain ${fromChainId} to chain ${toChainId}`
      );

      // Get token config from source chain
      const sourceChainConfig =
        DEFAULT_REBALANCE_CONFIG.chains[
          fromChainId as keyof typeof DEFAULT_REBALANCE_CONFIG.chains
        ];
      if (!sourceChainConfig) {
        throw new Error(`Unsupported source chain ID: ${fromChainId}`);
      }

      // Check if token is supported on source chain
      const tokenConfig =
        sourceChainConfig.tokens[
          tokenSymbol as keyof typeof sourceChainConfig.tokens
        ];
      if (!tokenConfig || !tokenConfig.enabled) {
        throw new Error(
          `Token ${tokenSymbol} not enabled on chain ${fromChainId}`
        );
      }

      // Get token address from constants
      const constantsChainConfig = CHAIN_CONFIG[fromChainId];
      if (!constantsChainConfig) {
        throw new Error(`Chain ${fromChainId} not found in CHAIN_CONFIG`);
      }

      const constantsTokenConfig = constantsChainConfig.tokens[tokenSymbol];
      if (!constantsTokenConfig) {
        throw new Error(
          `Token ${tokenSymbol} not found in CHAIN_CONFIG for chain ${fromChainId}`
        );
      }

      // Use the token address from constants
      let apiTokenAddress = constantsTokenConfig.address;

      // Special handling for ETH: use WETH address for API calls
      if (tokenSymbol === "ETH") {
        this.logger.info(
          `Using WETH address ${constantsChainConfig.tokens.WETH.address} for API call on chain ${fromChainId}`
        );
        apiTokenAddress = constantsChainConfig.tokens.WETH.address;
      }

      // Convert amount to raw amount with proper decimal handling
      const rawAmount = BigInt(
        Math.round(amount * 10 ** constantsTokenConfig.decimals)
      ).toString();

      this.logger.debug(
        `Converting ${amount} ${tokenSymbol} to raw amount ${rawAmount} (${constantsTokenConfig.decimals} decimals)`
      );

      // Get suggested fees from Across
      const feeResponse = await this.acrossService.getSuggestedFees({
        originChainId: fromChainId,
        destinationChainId: toChainId,
        token: apiTokenAddress,
        amount: rawAmount,
      });

      // Check if amount is within limits
      if (BigInt(rawAmount) < BigInt(feeResponse.limits.minDeposit)) {
        throw new Error(
          `Amount ${amount} ${tokenSymbol} is below minimum deposit limit of ${
            BigInt(feeResponse.limits.minDeposit) /
            BigInt(10 ** constantsTokenConfig.decimals)
          } ${tokenSymbol}`
        );
      }
      if (BigInt(rawAmount) > BigInt(feeResponse.limits.maxDeposit)) {
        throw new Error(
          `Amount ${amount} ${tokenSymbol} exceeds maximum deposit limit of ${
            BigInt(feeResponse.limits.maxDeposit) /
            BigInt(10 ** constantsTokenConfig.decimals)
          } ${tokenSymbol}`
        );
      }

      // Prepare deposit parameters using the AcrossService method
      const depositParams = this.acrossService.prepareDepositParams(
        feeResponse,
        this.accountAddress,
        constantsTokenConfig.address,
        BigInt(rawAmount),
        toChainId,
        undefined,
        "0x0000000000000000000000000000000000000000" as Address
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
      // Prevent rebalancing to and from the same chain
      if (fromChainId === toChainId) {
        throw new Error(`Cannot rebalance from chain ${fromChainId} to itself`);
      }

      // Get destination chain config
      const destChainConfig =
        DEFAULT_REBALANCE_CONFIG.chains[
          toChainId as keyof typeof DEFAULT_REBALANCE_CONFIG.chains
        ];
      if (!destChainConfig) {
        throw new Error(`Unsupported destination chain: ${toChainId}`);
      }

      // Check if destination chain can be a destination
      if (!destChainConfig.canBeDestination) {
        throw new Error(
          `Chain ${toChainId} cannot be a destination for rebalancing`
        );
      }

      // Ensure amount is positive
      if (amount <= 0) {
        throw new Error(`Rebalance amount must be positive, got: ${amount}`);
      }

      // Get token config from source chain
      const sourceChainConfig =
        DEFAULT_REBALANCE_CONFIG.chains[
          fromChainId as keyof typeof DEFAULT_REBALANCE_CONFIG.chains
        ];
      if (!sourceChainConfig) {
        throw new Error(`Unsupported source chain ID: ${fromChainId}`);
      }

      // Check if token is supported on source chain
      const tokenConfig =
        sourceChainConfig.tokens[
          tokenSymbol as keyof typeof sourceChainConfig.tokens
        ];
      if (!tokenConfig || !tokenConfig.enabled) {
        throw new Error(
          `Token ${tokenSymbol} not enabled on chain ${fromChainId}`
        );
      }

      // Get token address from constants
      const constantsChainConfig = CHAIN_CONFIG[fromChainId];
      if (!constantsChainConfig) {
        throw new Error(`Chain ${fromChainId} not found in CHAIN_CONFIG`);
      }

      const constantsTokenConfig = constantsChainConfig.tokens[tokenSymbol];
      if (!constantsTokenConfig) {
        throw new Error(
          `Token ${tokenSymbol} not found in CHAIN_CONFIG for chain ${fromChainId}`
        );
      }

      // Use the token address from constants
      let apiTokenAddress = constantsTokenConfig.address;

      // Special handling for ETH: use WETH address for API calls
      if (tokenSymbol === "ETH") {
        this.logger.info(
          `Using WETH address ${constantsChainConfig.tokens.WETH.address} for fee estimation on chain ${fromChainId}`
        );
        apiTokenAddress = constantsChainConfig.tokens.WETH.address;
      }

      // Convert amount to raw amount (e.g., 1 USDC = 1e6)
      const rawAmount = BigInt(
        Math.floor(amount * 10 ** constantsTokenConfig.decimals)
      ).toString();

      // Get suggested fees from Across
      const feeResponse = await this.acrossService.getSuggestedFees({
        originChainId: fromChainId,
        destinationChainId: toChainId,
        token: apiTokenAddress,
        amount: rawAmount,
      });

      // Convert raw fee to native token units
      const totalFee =
        Number(feeResponse.totalRelayFee.total) /
        10 ** constantsTokenConfig.decimals;

      return {
        fee: totalFee,
        feeToken: tokenSymbol,
        estimatedFillTime: feeResponse.estimatedFillTimeSec,
        maxDepositInstant: Number(
          BigInt(feeResponse.limits.maxDepositInstant) /
            BigInt(10 ** constantsTokenConfig.decimals)
        ),
        maxDepositShortDelay: Number(
          BigInt(feeResponse.limits.maxDepositShortDelay) /
            BigInt(10 ** constantsTokenConfig.decimals)
        ),
        maxDeposit: Number(
          BigInt(feeResponse.limits.maxDeposit) /
            BigInt(10 ** constantsTokenConfig.decimals)
        ),
      };
    } catch (error) {
      this.logger.error("Error getting rebalance fee estimate:", error);
      throw error;
    }
  }
}

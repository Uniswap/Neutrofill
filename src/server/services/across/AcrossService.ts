import {
  encodeFunctionData,
  type Address,
  type PublicClient,
  type WalletClient,
  type Chain,
} from "viem";
import fetch from "node-fetch";
import type {
  AcrossFeeRequest,
  AcrossFeeResponse,
  AcrossDepositParams,
  AcrossDepositStatusRequest,
  AcrossDepositStatusResponse,
} from "../../types/across.js";
import { Logger } from "../../utils/logger.js";

/**
 * Service for interacting with the Across Protocol for cross-chain bridging
 */
export class AcrossService {
  private readonly logger: Logger;
  private readonly apiBaseUrl: string = "https://app.across.to/api";
  private readonly uniqueIdentifier: string; // Provided by Across team
  private readonly publicClients: Record<number, PublicClient>;
  private readonly walletClients: Record<number, WalletClient>;

  constructor(
    publicClients: Record<number, PublicClient>,
    walletClients: Record<number, WalletClient>,
    uniqueIdentifier = "6e657574726f66696c6c" // "neutrofill"
  ) {
    this.logger = new Logger("AcrossService");
    this.publicClients = publicClients;
    this.walletClients = walletClients;
    this.uniqueIdentifier = uniqueIdentifier;
  }

  /**
   * Get suggested fees for a bridge transaction
   * @param params - Fee request parameters
   * @returns Fee response with relay fees and other information
   */
  public async getSuggestedFees(
    params: AcrossFeeRequest
  ): Promise<AcrossFeeResponse> {
    try {
      const { originChainId, destinationChainId, token, amount } = params;

      const queryParams = new URLSearchParams({
        originChainId: originChainId.toString(),
        destinationChainId: destinationChainId.toString(),
        token,
        amount,
      });

      const url = `${this.apiBaseUrl}/suggested-fees?${queryParams.toString()}`;

      this.logger.info(`Requesting suggested fees from Across: ${url}`);

      const response = await fetch(url);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to get suggested fees: ${response.status} ${errorText}`
        );
      }

      const data = (await response.json()) as AcrossFeeResponse;

      this.logger.info(
        `Received suggested fees response: ${JSON.stringify(data, null, 2)}`
      );

      return data;
    } catch (error) {
      this.logger.error("Error getting suggested fees:", error);
      throw error;
    }
  }

  /**
   * Prepare deposit parameters for a bridge transaction
   * @param feeResponse - Response from the suggested-fees API
   * @param depositor - Address of the depositor
   * @param inputToken - Address of the token to deposit
   * @param inputAmount - Amount to deposit (in raw format)
   * @param recipient - Optional recipient address (defaults to depositor)
   * @param outputToken - Optional output token (defaults to address(0) for auto-resolve)
   * @returns Parameters for the depositV3 function
   */
  public prepareDepositParams(
    feeResponse: AcrossFeeResponse,
    depositor: Address,
    inputToken: Address,
    inputAmount: bigint,
    recipient?: Address,
    outputToken: Address = "0x0000000000000000000000000000000000000000"
  ): AcrossDepositParams {
    // Calculate output amount by subtracting the relay fee from the input amount
    const outputAmount = inputAmount - BigInt(feeResponse.totalRelayFee.total);

    // Set fill deadline to current time + 5 hours (18000 seconds)
    const fillDeadline = Math.round(Date.now() / 1000) + 18000;

    return {
      depositor,
      recipient: recipient || depositor,
      inputToken,
      outputToken,
      inputAmount: inputAmount.toString(),
      outputAmount: outputAmount.toString(),
      destinationChainId: Number(feeResponse.spokePoolAddress),
      exclusiveRelayer: feeResponse.exclusiveRelayer,
      quoteTimestamp: feeResponse.timestamp,
      fillDeadline,
      exclusivityDeadline: feeResponse.exclusivityDeadline,
      message: "0x", // No message for basic bridging
    };
  }

  /**
   * Execute a bridge deposit transaction
   * @param originChainId - Chain ID where the deposit originates
   * @param depositParams - Parameters for the depositV3 function
   * @returns Transaction hash
   */
  public async executeDeposit(
    originChainId: number,
    depositParams: AcrossDepositParams
  ): Promise<string> {
    try {
      const walletClient = this.walletClients[originChainId];

      if (!walletClient) {
        throw new Error(
          `No wallet client available for chain ID ${originChainId}`
        );
      }

      // Get the SpokePool contract address for the origin chain
      const spokePoolAddress = await this.getSpokePoolAddress(originChainId);

      // Check if token approval is needed
      if (
        depositParams.inputToken !==
        "0x0000000000000000000000000000000000000000"
      ) {
        await this.checkAndApproveToken(
          originChainId,
          depositParams.inputToken,
          spokePoolAddress,
          BigInt(depositParams.inputAmount)
        );
      }

      // Encode function call with the unique identifier appended
      const callData = await this.encodeDepositV3WithIdentifier(depositParams);

      // Get the account address
      const account = walletClient.account;
      if (!account) {
        throw new Error("No account found in wallet client");
      }

      const chain = walletClient.chain;

      // Execute the transaction
      this.logger.info(`Executing deposit on chain ${originChainId}`);

      const hash = await walletClient.sendTransaction({
        account,
        chain,
        to: spokePoolAddress,
        data: callData,
        value:
          depositParams.inputToken ===
          "0x0000000000000000000000000000000000000000"
            ? BigInt(depositParams.inputAmount)
            : 0n,
      });

      this.logger.info(`Deposit transaction sent: ${hash}`);

      return hash;
    } catch (error) {
      this.logger.error("Error executing deposit:", error);
      throw error;
    }
  }

  /**
   * Get the status of a deposit
   * @param params - Deposit status request parameters
   * @returns Deposit status response
   */
  public async getDepositStatus(
    params: AcrossDepositStatusRequest
  ): Promise<AcrossDepositStatusResponse> {
    try {
      const { originChainId, depositId } = params;

      const queryParams = new URLSearchParams({
        originChainId: originChainId.toString(),
        depositId,
      });

      const url = `${this.apiBaseUrl}/deposit/status?${queryParams.toString()}`;

      this.logger.info(`Checking deposit status: ${url}`);

      const response = await fetch(url);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to get deposit status: ${response.status} ${errorText}`
        );
      }

      const data = (await response.json()) as AcrossDepositStatusResponse;

      this.logger.info(`Deposit status: ${data.status}`);

      return data;
    } catch (error) {
      this.logger.error("Error getting deposit status:", error);
      throw error;
    }
  }

  /**
   * Get the SpokePool address for a specific chain
   * @param chainId - Chain ID
   * @returns SpokePool contract address
   */
  private async getSpokePoolAddress(chainId: number): Promise<Address> {
    // This could be fetched from the API or hardcoded for security
    // For now, let's fetch it from the API
    try {
      // Use a dummy request to get the SpokePool address
      const dummyRequest: AcrossFeeRequest = {
        originChainId: chainId,
        destinationChainId: chainId === 1 ? 10 : 1, // If mainnet, use Optimism, otherwise use mainnet
        token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
        amount: "1000000", // 1 USDC
      };

      const feeResponse = await this.getSuggestedFees(dummyRequest);

      return feeResponse.spokePoolAddress;
    } catch (error) {
      this.logger.error(
        `Error getting SpokePool address for chain ${chainId}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Check if token approval is needed and approve if necessary
   * @param chainId - Chain ID
   * @param tokenAddress - Token address
   * @param spenderAddress - Address to approve (SpokePool)
   * @param amount - Amount to approve
   */
  private async checkAndApproveToken(
    chainId: number,
    tokenAddress: Address,
    spenderAddress: Address,
    amount: bigint
  ): Promise<void> {
    try {
      const publicClient = this.publicClients[chainId];
      const walletClient = this.walletClients[chainId];

      if (!publicClient || !walletClient) {
        throw new Error(`No clients available for chain ID ${chainId}`);
      }

      // Get the account address
      const account = walletClient.account;
      if (!account) {
        throw new Error("No account found in wallet client");
      }

      // Check current allowance
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: [
          {
            inputs: [
              { name: "owner", type: "address" },
              { name: "spender", type: "address" },
            ],
            name: "allowance",
            outputs: [{ name: "", type: "uint256" }],
            stateMutability: "view",
            type: "function",
          },
        ],
        functionName: "allowance",
        args: [account.address, spenderAddress],
      });

      // If allowance is less than amount, approve
      if (allowance < amount) {
        this.logger.info(
          `Approving token ${tokenAddress} for ${spenderAddress}`
        );

        const chain = walletClient.chain;

        const MAX_UINT256 = BigInt(
          "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"
        );

        const hash = await walletClient.writeContract({
          account,
          chain,
          address: tokenAddress,
          abi: [
            {
              inputs: [
                { name: "spender", type: "address" },
                { name: "amount", type: "uint256" },
              ],
              name: "approve",
              outputs: [{ name: "", type: "bool" }],
              stateMutability: "nonpayable",
              type: "function",
            },
          ],
          functionName: "approve",
          args: [spenderAddress, MAX_UINT256],
        });

        this.logger.info(`Approval transaction sent: ${hash}`);

        // Wait for the transaction to be mined
        await publicClient.waitForTransactionReceipt({ hash });

        this.logger.info("Approval transaction confirmed");
      } else {
        this.logger.debug(
          `Token ${tokenAddress} already has sufficient allowance`
        );
      }
    } catch (error) {
      this.logger.error("Error checking and approving token:", error);
      throw error;
    }
  }

  /**
   * Encode the depositV3 function call with the unique identifier appended
   * @param params - Deposit parameters
   * @returns Encoded function call with identifier
   */
  private async encodeDepositV3WithIdentifier(
    params: AcrossDepositParams
  ): Promise<`0x${string}`> {
    try {
      const publicClient =
        this.publicClients[Number(params.destinationChainId)];

      if (!publicClient) {
        throw new Error(
          `No public client available for chain ID ${params.destinationChainId}`
        );
      }

      // Encode the function call
      const encodedCall = encodeFunctionData({
        abi: [
          {
            inputs: [
              { name: "depositor", type: "address" },
              { name: "recipient", type: "address" },
              { name: "inputToken", type: "address" },
              { name: "outputToken", type: "address" },
              { name: "inputAmount", type: "uint256" },
              { name: "outputAmount", type: "uint256" },
              { name: "destinationChainId", type: "uint256" },
              { name: "exclusiveRelayer", type: "address" },
              { name: "quoteTimestamp", type: "uint32" },
              { name: "fillDeadline", type: "uint32" },
              { name: "exclusivityDeadline", type: "uint32" },
              { name: "message", type: "bytes" },
            ],
            name: "depositV3",
            outputs: [],
            stateMutability: "payable",
            type: "function",
          },
        ],
        functionName: "depositV3",
        args: [
          params.depositor,
          params.recipient,
          params.inputToken,
          params.outputToken,
          BigInt(params.inputAmount),
          BigInt(params.outputAmount),
          BigInt(params.destinationChainId),
          params.exclusiveRelayer,
          params.quoteTimestamp,
          params.fillDeadline,
          params.exclusivityDeadline,
          params.message as `0x${string}`,
        ],
      });

      // Append the delimiter and unique identifier
      // 1dc0de is the delimiter, followed by the unique identifier
      const callDataWithIdentifier =
        `${encodedCall}1dc0de${this.uniqueIdentifier}` as `0x${string}`;

      return callDataWithIdentifier;
    } catch (error) {
      this.logger.error("Error encoding depositV3 function call:", error);
      throw error;
    }
  }
}

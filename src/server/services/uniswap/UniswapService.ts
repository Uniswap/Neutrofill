import type { WalletClient } from "viem";
import { signTypedData } from "viem/actions";
import { Logger } from "../../utils/logger.js";

// Types based on the Uniswap API swagger
export interface RequestId {
  requestId: string;
}

// Define more specific types for the quote response
export interface ClassicOutput {
  token: string;
  amount: string;
  recipient?: string;
}

export interface ClassicInput {
  token: string;
  amount: string;
}

export interface Quote {
  input: ClassicInput;
  output: ClassicOutput;
  gasFee?: string;
  gasFeeUSD?: string;
  priceImpact?: number;
  routeString?: string;
  [key: string]: unknown;
}

export interface QuoteResponse extends RequestId {
  quote: Quote;
  routing: string;
  permitData?: {
    domain?: Record<string, unknown>;
    values?: Record<string, unknown>;
    types?: Record<string, unknown>;
  };
}

export interface ApprovalResponse extends RequestId {
  approval?: TransactionRequest;
  cancel?: TransactionRequest;
  gasFee?: string;
  cancelGasFee?: string;
}

export interface SwapResponse extends RequestId {
  swap: TransactionRequest;
  gasFee?: string;
}
export interface QuoteRequest {
  type: "EXACT_INPUT" | "EXACT_OUTPUT";
  amount: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  tokenIn: string;
  tokenOut: string;
  swapper: string;
  slippageTolerance?: number;
  routingPreference?:
    | "CLASSIC"
    | "UNISWAPX"
    | "BEST_PRICE"
    | "BEST_PRICE_V2"
    | "UNISWAPX_V2"
    | "V3_ONLY"
    | "V2_ONLY"
    | "FASTEST";
}

export interface SwapRequest {
  quote: Quote; // Will be the quote response from the quote endpoint
  signature?: string;
  refreshGasPrice?: boolean;
  simulateTransaction?: boolean;
  permitData?: {
    domain?: Record<string, unknown>;
    values?: Record<string, unknown>;
    types?: Record<string, unknown>;
  };
  safetyMode?: "SAFE";
  deadline?: number;
  urgency?: "normal" | "fast" | "urgent";
}

export interface ApprovalRequest {
  walletAddress: string;
  token: string;
  amount: string;
  chainId: number;
  urgency?: "normal" | "fast" | "urgent";
}

export interface TransactionRequest {
  to: string;
  from: string;
  data: string;
  value: string;
  gasLimit?: string;
  chainId: number;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

/**
 * Service for interacting with the Uniswap API to perform swaps
 */
class UniswapApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UniswapApiError";
  }
}

export class UniswapService {
  private readonly baseUrl = "https://trade-api.gateway.uniswap.org/v1";
  private readonly UNICHAIN_ID = 130;
  private readonly headers: Record<string, string>;
  private logger: Logger;
  private readonly walletClient?: WalletClient;

  constructor(walletClient?: WalletClient) {
    this.walletClient = walletClient;
    const apiKey = process.env.UNISWAP_API_KEY;
    if (!apiKey) {
      throw new Error("UNISWAP_API_KEY environment variable is required");
    }

    this.headers = {
      "x-api-key": apiKey,
      "Content-Type": "application/json",
    };

    this.logger = new Logger("UniswapService");
    this.logger.info("UniswapService initialized");
  }

  private async makeRequest<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: unknown,
    errorContext = "Uniswap API request failed"
  ): Promise<T> {
    try {
      const url = `${this.baseUrl}${endpoint}`;

      const response = await globalThis.fetch(url, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        let errorMessage: string;
        try {
          const errorData = (await response.json()) as {
            detail?: string;
            errorCode?: string;
          };
          errorMessage =
            errorData?.detail || errorData?.errorCode || response.statusText;
        } catch {
          errorMessage = response.statusText;
        }
        throw new UniswapApiError(`${errorContext}: ${errorMessage}`);
      }

      const data = await response.json();
      if (!data) {
        throw new UniswapApiError(`${errorContext}: Empty response`);
      }

      return data as T;
    } catch (error) {
      if (error instanceof UniswapApiError) throw error;
      throw new UniswapApiError(
        `${errorContext}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }

  /**
   * Get a quote for a swap
   * @param request Quote request parameters
   * @returns Quote response
   */
  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    try {
      // Ensure we're using Unichain
      const requestWithChainId = {
        ...request,
        tokenInChainId: this.UNICHAIN_ID,
        tokenOutChainId: this.UNICHAIN_ID,
      };

      this.logger.debug("Getting quote from Uniswap API", {
        request: requestWithChainId,
      });

      const response = await this.makeRequest<QuoteResponse>(
        "/quote",
        "POST",
        requestWithChainId,
        "Failed to get quote"
      );

      this.logger.debug("Received quote from Uniswap API", {
        quoteId: response.requestId,
      });

      return response;
    } catch (error) {
      this.logger.error("Error getting quote from Uniswap API", { error });
      throw error;
    }
  }

  /**
   * Check if token approval is required
   * @param request Approval request parameters
   * @returns Approval response
   */
  async checkApproval(request: ApprovalRequest): Promise<ApprovalResponse> {
    try {
      // Ensure we're using Unichain
      const requestWithChainId = {
        ...request,
        chainId: this.UNICHAIN_ID,
      };

      this.logger.debug("Checking approval with Uniswap API", {
        request: requestWithChainId,
      });

      const response = await this.makeRequest<ApprovalResponse>(
        "/check_approval",
        "POST",
        requestWithChainId,
        "Failed to check approval"
      );

      this.logger.debug("Received approval check from Uniswap API", {
        requestId: response.requestId,
      });

      return response;
    } catch (error) {
      this.logger.error("Error checking approval with Uniswap API", { error });
      throw error;
    }
  }

  /**
   * Create a swap transaction
   * @param request Swap request parameters
   * @returns Swap transaction data
   */
  async createSwap(request: SwapRequest): Promise<SwapResponse> {
    try {
      this.logger.debug("Creating swap with Uniswap API", { request });

      const response = await this.makeRequest<SwapResponse>(
        "/swap",
        "POST",
        request,
        "Failed to create swap"
      );

      this.logger.debug("Received swap data from Uniswap API", {
        requestId: response.requestId,
      });

      return response;
    } catch (error) {
      this.logger.error("Error creating swap with Uniswap API", { error });
      throw error;
    }
  }

  /**
   * Execute a full swap flow: get quote, check approval if needed, and create swap transaction
   * @param tokenIn Input token address
   * @param tokenOut Output token address
   * @param amount Amount to swap
   * @param swapper Address of the swapper
   * @param slippageTolerance Slippage tolerance percentage
   * @returns Swap transaction data
   */
  async executeSwap(
    tokenIn: string,
    tokenOut: string,
    amount: string,
    swapper: string,
    slippageTolerance = 0.5
  ) {
    try {
      // 1. Get quote
      const quoteRequest: QuoteRequest = {
        type: "EXACT_INPUT",
        amount,
        tokenInChainId: this.UNICHAIN_ID,
        tokenOutChainId: this.UNICHAIN_ID,
        tokenIn,
        tokenOut,
        swapper,
        slippageTolerance,
        routingPreference: "BEST_PRICE",
      };

      const quoteResponse = await this.getQuote(quoteRequest);

      // 2. Check if approval is needed
      if (quoteResponse.permitData) {
        const approvalRequest: ApprovalRequest = {
          walletAddress: swapper,
          token: tokenIn,
          amount,
          chainId: this.UNICHAIN_ID,
        };

        const approvalResponse = await this.checkApproval(approvalRequest);

        // If approval transaction is returned, it needs to be executed first
        if (approvalResponse.approval) {
          this.logger.info("Token approval required before swap", {
            token: tokenIn,
            approvalTx: approvalResponse.approval,
          });

          return {
            requiresApproval: true,
            approvalTransaction: approvalResponse.approval,
            quoteResponse,
          };
        }
      }

      // 3. Create swap transaction with permit data if available
      let swapRequest: SwapRequest = {
        quote: quoteResponse.quote,
        simulateTransaction: true,
        refreshGasPrice: true,
      };

      // If we have permitData and a wallet client, sign the permit
      if (quoteResponse.permitData && this.walletClient) {
        try {
          this.logger.info("Signing permit data for token approval");

          // Get the account from the wallet client
          const account = this.walletClient.account;
          if (!account) {
            throw new Error("No account found in wallet client");
          }

          // Ensure the permit data has the required properties
          if (
            !quoteResponse.permitData.domain ||
            !quoteResponse.permitData.types ||
            !quoteResponse.permitData.values
          ) {
            throw new Error("Permit data is missing required properties");
          }

          // Convert the permit data to the format expected by signTypedData
          const domain = quoteResponse.permitData.domain as Record<
            string,
            unknown
          >;
          const types = quoteResponse.permitData.types as Record<
            string,
            unknown
          >;
          const values = quoteResponse.permitData.values as Record<
            string,
            unknown
          >;

          // Get the primary type (usually "Permit2" or similar)
          const primaryType = Object.keys(types).find(
            (key) => key !== "EIP712Domain"
          );
          if (!primaryType) {
            throw new Error(
              "Could not determine primary type from permit data"
            );
          }

          // Sign the typed data
          const signature = await signTypedData(this.walletClient, {
            account,
            domain,
            types,
            primaryType,
            message: values,
          });

          this.logger.info("Successfully signed permit data");

          // Include the permit data and signature in the swap request
          swapRequest = {
            ...swapRequest,
            permitData: quoteResponse.permitData,
            signature,
          };
        } catch (error) {
          this.logger.error("Error signing permit data:", error);
          // Fall back to traditional approval flow
          this.logger.info("Falling back to traditional approval flow");

          // Check for approval explicitly
          const approvalRequest: ApprovalRequest = {
            walletAddress: swapper,
            token: tokenIn,
            amount,
            chainId: this.UNICHAIN_ID,
          };

          const approvalResponse = await this.checkApproval(approvalRequest);

          if (approvalResponse.approval) {
            this.logger.info("Token approval required before swap", {
              token: tokenIn,
              approvalTx: approvalResponse.approval,
            });

            return {
              requiresApproval: true,
              approvalTransaction: approvalResponse.approval,
              quoteResponse,
            };
          }
        }
      }

      const swapResponse = await this.createSwap(swapRequest);

      return {
        requiresApproval: false,
        swapTransaction: swapResponse.swap,
        quoteResponse,
      };
    } catch (error) {
      this.logger.error("Error executing swap flow", { error });
      throw error;
    }
  }
}

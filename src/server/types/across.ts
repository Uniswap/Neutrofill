import type { Address } from "viem";

export interface AcrossFeeRequest {
  originChainId: number;
  destinationChainId: number;
  token: Address;
  amount: string; // Raw amount (e.g., 1 USDC = 1e6)
}

export interface AcrossTotalRelayFee {
  total: string;
  relayer: string;
  lpFee: string;
  protocolFee: string;
}

export interface AcrossFeeResponse {
  totalRelayFee: AcrossTotalRelayFee;
  timestamp: number;
  fillSpeedType: "instant" | "shortDelay" | "slow";
  estimateFillTimeSec: number;
  maxDepositInstant: string;
  maxDepositShortDelay: string;
  maxDeposit: string;
  recommendedDepositInstant: string;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  spokePoolAddress: Address;
}

export interface AcrossDepositParams {
  depositor: Address;
  recipient: Address;
  inputToken: Address;
  outputToken: Address;
  inputAmount: string;
  outputAmount: string;
  destinationChainId: number;
  exclusiveRelayer: Address;
  quoteTimestamp: number;
  fillDeadline: number;
  exclusivityDeadline: number;
  message: string;
}

export interface AcrossDepositStatusRequest {
  originChainId: number;
  depositId: string;
}

export interface AcrossDepositStatusResponse {
  status: "pending" | "filled" | "expired";
  depositId: string;
  originChainId: number;
  destinationChainId: number;
  depositor: Address;
  recipient: Address;
  inputToken: Address;
  outputToken: Address;
  inputAmount: string;
  outputAmount: string;
  fillTxHash?: string;
  fillTimestamp?: number;
}

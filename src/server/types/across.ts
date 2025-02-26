import type { Address } from "viem";

export interface AcrossFeeRequest {
  originChainId: number;
  destinationChainId: number;
  token: Address;
  amount: string; // Raw amount (e.g., 1 USDC = 1e6)
}

export interface AcrossTotalRelayFee {
  pct: string;
  total: string;
}

export interface AcrossRelayerCapitalFee {
  pct: string;
  total: string;
}

export interface AcrossRelayerGasFee {
  pct: string;
  total: string;
}

export interface AcrossLpFee {
  pct: string;
  total: string;
}

export interface AcrossLimits {
  minDeposit: string;
  maxDeposit: string;
  maxDepositInstant: string;
  maxDepositShortDelay: string;
  recommendedDepositInstant: string;
}

export interface AcrossFeeResponse {
  estimatedFillTimeSec: number;
  capitalFeePct: string;
  capitalFeeTotal: string;
  relayGasFeePct: string;
  relayGasFeeTotal: string;
  relayFeePct: string;
  relayFeeTotal: string;
  lpFeePct: string;
  timestamp: string;
  isAmountTooLow: boolean;
  quoteBlock: string;
  exclusiveRelayer: Address;
  exclusivityDeadline: number;
  spokePoolAddress: Address;
  destinationSpokePoolAddress: Address;
  totalRelayFee: AcrossTotalRelayFee;
  relayerCapitalFee: AcrossRelayerCapitalFee;
  relayerGasFee: AcrossRelayerGasFee;
  lpFee: AcrossLpFee;
  limits: AcrossLimits;
  fillDeadline: string;
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

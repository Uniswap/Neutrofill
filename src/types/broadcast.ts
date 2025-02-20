export interface Mandate {
  chainId: number;
  tribunal: string;
  recipient: string;
  expires: string;
  token: string;
  minimumAmount: string;
  baselinePriorityFee: string;
  scalingFactor: string;
  salt: string;
}

export interface Compact {
  arbiter: string;
  sponsor: string;
  nonce: string;
  expires: string;
  id: string;
  amount: string;
  mandate: Mandate;
}

export interface Context {
  dispensation: string;
  dispensationUSD: string;
  spotOutputAmount: string;
  quoteOutputAmountDirect: string;
  quoteOutputAmountNet: string;
  deltaAmount?: string;
  slippageBips?: number;
  witnessTypeString: string;
  witnessHash: string;
  claimHash?: string;
}

export interface BroadcastRequest {
  chainId: string;
  compact: Compact;
  sponsorSignature: string | null;
  allocatorSignature: string;
  context: Context;
  claimHash?: string;
}

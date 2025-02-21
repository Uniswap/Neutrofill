import type { BroadcastRequest } from "../validation/broadcast.js";
import type { PriceService } from "../services/price/PriceService.js";
import { derivePriorityFee } from "../utils.js";
import { encodeFunctionData, parseEther, formatEther, type Hash } from "viem";
import { Logger } from "../utils/logger.js";
import type { PublicClient, WalletClient, Chain } from "viem";
import type { SupportedChainId } from "../config/constants.js";

const logger = new Logger("BroadcastHelper");

export interface ProcessedBroadcastResult {
  success: boolean;
  hash?: Hash;
  reason?: string;
  details: {
    dispensationUSD: number;
    gasCostUSD?: number;
    netProfitUSD?: number;
    minProfitUSD?: number;
  };
}

export async function processBroadcastTransaction(
  request: BroadcastRequest & { chainId: number },
  chainId: SupportedChainId,
  priceService: PriceService,
  publicClient: PublicClient,
  walletClient: WalletClient,
  address: `0x${string}`
): Promise<ProcessedBroadcastResult> {
  // Get current ETH price for the chain from memory
  const ethPrice = priceService.getPrice(chainId);
  logger.info(`Current ETH price on chain ${chainId}: $${ethPrice}`);

  // Extract the dispensation amount in USD from the request
  const dispensationUSD = Number.parseFloat(
    request.context.dispensationUSD.replace("$", "")
  );

  // Calculate gas cost
  const baselinePriorityFee = BigInt(
    request.compact.mandate.baselinePriorityFee
  );
  const scalingFactor = BigInt(request.compact.mandate.scalingFactor);
  const minimumAmount = BigInt(request.compact.mandate.minimumAmount);
  const desiredSettlement = BigInt(request.context.spotOutputAmount);

  // Calculate priority fee based on desired settlement
  const priorityFee = derivePriorityFee(
    desiredSettlement,
    minimumAmount,
    baselinePriorityFee,
    scalingFactor
  );

  // Add 25% buffer to dispensation for cross-chain message fee
  const bufferedDispensation =
    (BigInt(request.context.dispensation) * 125n) / 100n;

  // Calculate total value to send (settlement + buffered dispensation for native token, just buffered dispensation for ERC20)
  const value =
    request.compact.mandate.token ===
    "0x0000000000000000000000000000000000000000"
      ? BigInt(request.context.spotOutputAmount) + bufferedDispensation
      : bufferedDispensation;

  // Encode function data with proper ABI
  const data = encodeFunctionData({
    abi: [
      {
        name: "fill",
        type: "function",
        stateMutability: "payable",
        inputs: [
          {
            name: "claim",
            type: "tuple",
            components: [
              { name: "chainId", type: "uint256" },
              {
                name: "compact",
                type: "tuple",
                components: [
                  { name: "arbiter", type: "address" },
                  { name: "sponsor", type: "address" },
                  { name: "nonce", type: "uint256" },
                  { name: "expires", type: "uint256" },
                  { name: "id", type: "uint256" },
                  { name: "amount", type: "uint256" },
                ],
              },
              { name: "sponsorSignature", type: "bytes" },
              { name: "allocatorSignature", type: "bytes" },
            ],
          },
          {
            name: "mandate",
            type: "tuple",
            components: [
              { name: "recipient", type: "address" },
              { name: "expires", type: "uint256" },
              { name: "token", type: "address" },
              { name: "minimumAmount", type: "uint256" },
              { name: "baselinePriorityFee", type: "uint256" },
              { name: "scalingFactor", type: "uint256" },
              { name: "salt", type: "bytes32" },
            ],
          },
          { name: "claimant", type: "address" },
        ],
        outputs: [
          { name: "mandateHash", type: "bytes32" },
          { name: "settlementAmount", type: "uint256" },
          { name: "claimAmount", type: "uint256" },
        ],
      },
    ],
    functionName: "fill",
    args: [
      {
        chainId: BigInt(request.chainId),
        compact: {
          arbiter: request.compact.arbiter as `0x${string}`,
          sponsor: request.compact.sponsor as `0x${string}`,
          nonce: BigInt(request.compact.nonce),
          expires: BigInt(request.compact.expires),
          id: BigInt(request.compact.id),
          amount: BigInt(request.compact.amount),
        },
        sponsorSignature: (request.sponsorSignature ||
          `0x${"0".repeat(128)}`) as `0x${string}`,
        allocatorSignature: request.allocatorSignature as `0x${string}`,
      },
      {
        recipient: request.compact.mandate.recipient as `0x${string}`,
        expires: BigInt(request.compact.mandate.expires),
        token: request.compact.mandate.token as `0x${string}`,
        minimumAmount: BigInt(request.compact.mandate.minimumAmount),
        baselinePriorityFee: BigInt(
          request.compact.mandate.baselinePriorityFee
        ),
        scalingFactor: BigInt(request.compact.mandate.scalingFactor),
        salt: request.compact.mandate.salt as `0x${string}`,
      },
      address,
    ],
  });

  // Estimate gas and add 25% buffer
  const estimatedGas = await publicClient.estimateGas({
    to: request.compact.mandate.tribunal as `0x${string}`,
    value,
    data,
    maxFeePerGas: priorityFee + BigInt(300000),
    maxPriorityFeePerGas: priorityFee,
    account: address,
  });

  const gasWithBuffer = (estimatedGas * 125n) / 100n;

  // Get current base fee from latest block and calculate max fee
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas ?? parseEther("0.00000005"); // 50 gwei default if baseFeePerGas is null
  const maxFeePerGas = priorityFee + (baseFee * 120n) / 100n; // Base fee + 20% buffer

  // Calculate total gas cost
  const totalGasCost = maxFeePerGas * gasWithBuffer;
  const gasCostEth = Number(formatEther(totalGasCost));
  const gasCostUSD = gasCostEth * ethPrice;

  // Calculate net profit
  const netProfitUSD = dispensationUSD - gasCostUSD;
  const minProfitUSD = 0.5; // Minimum profit threshold in USD

  const isProfitable = netProfitUSD > minProfitUSD;

  if (!isProfitable) {
    return {
      success: false,
      reason: "Transaction not profitable",
      details: {
        dispensationUSD,
        gasCostUSD,
        netProfitUSD,
        minProfitUSD,
      },
    };
  }

  // Submit the transaction using the chain from the mandate
  const mandateChainId = Number(request.compact.mandate.chainId);
  const chain =
    walletClient.chain?.id === mandateChainId
      ? walletClient.chain
      : ({
          id: mandateChainId,
          name: `Chain ${mandateChainId}`,
          network: `chain-${mandateChainId}`,
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
          rpcUrls: walletClient.chain?.rpcUrls ?? {
            default: { http: [""] },
            public: { http: [""] },
          },
        } as Chain);

  const hash = await walletClient.sendTransaction({
    to: request.compact.mandate.tribunal as `0x${string}`,
    value,
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
    gas: gasWithBuffer,
    data: data as `0x${string}`,
    account: address,
    chain,
  });

  logger.info(`Transaction submitted: ${hash}`);

  return {
    success: true,
    hash,
    details: {
      dispensationUSD,
      gasCostUSD,
      netProfitUSD,
    },
  };
}

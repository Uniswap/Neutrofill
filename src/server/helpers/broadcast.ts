import { type Hash, encodeFunctionData, formatEther, parseEther } from "viem";
import type { Chain, PublicClient, Transport, WalletClient } from "viem";
import {
  CHAIN_CONFIG,
  CHAIN_PRIORITY_FEES,
  type SupportedChainId,
} from "../config/constants.js";
import type { TokenBalanceService } from "../services/balance/TokenBalanceService.js";
import type { PriceService } from "../services/price/PriceService.js";
import { Logger } from "../utils/logger.js";
import type { BroadcastRequest } from "../validation/broadcast.js";

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
  tokenBalanceService: TokenBalanceService,
  publicClient: PublicClient,
  walletClient: WalletClient,
  address: `0x${string}`
): Promise<ProcessedBroadcastResult> {
  // Get the chain object and config for the mandate's chain
  const mandateChainId = Number(
    request.compact.mandate.chainId
  ) as SupportedChainId;
  const mandateChainConfig = CHAIN_CONFIG[mandateChainId];
  logger.info(`Evaluating fill against chainId ${mandateChainId}`);

  // Use chain from public client
  const chain = publicClient.chain;

  // Get current ETH price for the chain from memory
  const ethPrice = priceService.getPrice(chainId);
  logger.info(`Current ETH price on chain ${chainId}: $${ethPrice}`);

  // Extract the dispensation amount in USD from the request and add 25% buffer
  const dispensationUSD = Number.parseFloat(
    request.context.dispensationUSD.replace("$", "")
  );
  const bufferedDispensation =
    (BigInt(request.context.dispensation) * 125n) / 100n;

  // Calculate simulation values
  const minimumAmount = BigInt(request.compact.mandate.minimumAmount);
  const simulationSettlement = (minimumAmount * 101n) / 100n;
  const baselinePriorityFee = BigInt(
    request.compact.mandate.baselinePriorityFee
  );
  const scalingFactor = BigInt(request.compact.mandate.scalingFactor);

  // Get cached balances for the mandate chain
  const cachedBalances = tokenBalanceService.getBalances(chainId);
  if (!cachedBalances) {
    return {
      success: false,
      reason: "Could not get cached balances for chain",
      details: {
        dispensationUSD,
      },
    };
  }

  // Calculate settlement amount based on mandate token (ETH/WETH check)
  const mandateTokenAddress =
    request.compact.mandate.token.toLowerCase() as `0x${string}`;
  const isSettlementTokenETHorWETH = Object.values(CHAIN_CONFIG).some(
    (chainConfig) =>
      mandateTokenAddress === chainConfig.tokens.ETH.address.toLowerCase() ||
      mandateTokenAddress === chainConfig.tokens.WETH.address.toLowerCase()
  );

  // Get the relevant token balance based on mandate token
  let relevantTokenBalance: bigint;
  if (
    mandateTokenAddress === mandateChainConfig.tokens.ETH.address.toLowerCase()
  ) {
    relevantTokenBalance = cachedBalances.ETH;
  } else if (
    mandateTokenAddress === mandateChainConfig.tokens.WETH.address.toLowerCase()
  ) {
    relevantTokenBalance = cachedBalances.WETH;
  } else if (
    mandateTokenAddress === mandateChainConfig.tokens.USDC.address.toLowerCase()
  ) {
    relevantTokenBalance = cachedBalances.USDC;
  } else {
    return {
      success: false,
      reason: "Unsupported mandate token",
      details: {
        dispensationUSD,
      },
    };
  }

  // Check if we have sufficient token balance for minimum amount
  if (relevantTokenBalance < minimumAmount) {
    return {
      success: false,
      reason: "Token balance is less than minimum required settlement amount",
      details: {
        dispensationUSD,
      },
    };
  }

  // Check if we have sufficient token balance for simulation settlement
  if (relevantTokenBalance < simulationSettlement) {
    return {
      success: false,
      reason: "Token balance is less than simulation settlement amount",
      details: {
        dispensationUSD,
      },
    };
  }

  // Calculate simulation priority fee
  const simulationPriorityFee = CHAIN_PRIORITY_FEES[chainId];

  // Calculate simulation value
  const simulationValue =
    request.compact.mandate.token ===
    "0x0000000000000000000000000000000000000000"
      ? simulationSettlement + bufferedDispensation
      : bufferedDispensation;

  // Check if we have sufficient ETH for simulation value
  if (cachedBalances.ETH < simulationValue) {
    return {
      success: false,
      reason: "ETH balance is less than simulation value",
      details: {
        dispensationUSD,
      },
    };
  }

  // Encode simulation data with proper ABI
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
        sponsorSignature: (!request.sponsorSignature ||
        request.sponsorSignature === "0x"
          ? `0x${"0".repeat(128)}`
          : request.sponsorSignature) as `0x${string}`,
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

  // Get current base fee from latest block using mandate chain
  const block = await publicClient.getBlock();
  const baseFee = block.baseFeePerGas;
  if (!baseFee) {
    return {
      success: false,
      reason: "Could not get base fee from latest block",
      details: {
        dispensationUSD,
      },
    };
  }

  // Estimate gas using simulation values and add 25% buffer
  logger.info("Performing initial simulation to get gas estimate");
  const estimatedGas = await publicClient.estimateGas({
    to: request.compact.mandate.tribunal as `0x${string}`,
    value: simulationValue,
    data,
    maxFeePerGas: simulationPriorityFee + (baseFee * 120n) / 100n,
    maxPriorityFeePerGas: simulationPriorityFee,
    account: address,
  });

  const gasWithBuffer = (estimatedGas * 125n) / 100n;
  logger.info(
    `Got gas estimate: ${estimatedGas} (${gasWithBuffer} with buffer)`
  );

  // Calculate max fee and total gas cost
  const maxFeePerGas = simulationPriorityFee + (baseFee * 120n) / 100n; // Base fee + 20% buffer
  const totalGasCost = maxFeePerGas * gasWithBuffer;
  const gasCostEth = Number(formatEther(totalGasCost));
  const gasCostUSD = gasCostEth * ethPrice;

  // Calculate execution costs
  const executionCostWei = totalGasCost + bufferedDispensation;
  const executionCostUSD = gasCostUSD + dispensationUSD;

  // Get claim token from compact ID and check if it's ETH/WETH across all chains
  const claimTokenHex = BigInt(request.compact.id).toString(16).slice(-40);
  const claimToken = `0x${claimTokenHex}`.toLowerCase() as `0x${string}`;

  // Check if token is ETH/WETH in any supported chain
  const isETHorWETH = Object.values(CHAIN_CONFIG).some(
    (chainConfig) =>
      claimToken === chainConfig.tokens.ETH.address.toLowerCase() ||
      claimToken === chainConfig.tokens.WETH.address.toLowerCase()
  );

  // Calculate claim amount less execution costs
  let claimAmountLessExecutionCostsWei: bigint;
  let claimAmountLessExecutionCostsUSD: number;
  if (isETHorWETH) {
    claimAmountLessExecutionCostsWei =
      BigInt(request.compact.amount) - executionCostWei;
    claimAmountLessExecutionCostsUSD =
      Number(formatEther(claimAmountLessExecutionCostsWei)) * ethPrice;
  } else {
    // Assume USDC with 6 decimals
    claimAmountLessExecutionCostsUSD =
      Number(request.compact.amount) / 1e6 - executionCostUSD;
    claimAmountLessExecutionCostsWei = parseEther(
      (claimAmountLessExecutionCostsUSD / ethPrice).toString()
    );
  }

  const settlementAmount = isSettlementTokenETHorWETH
    ? claimAmountLessExecutionCostsWei
    : BigInt(Math.floor(claimAmountLessExecutionCostsUSD * 1e6)); // Scale up USDC amount

  logger.info(
    `Settlement amount: ${settlementAmount} (minimum: ${minimumAmount})`
  );

  // Check if we have sufficient token balance for settlement amount
  if (relevantTokenBalance < settlementAmount) {
    return {
      success: false,
      reason: "Token balance is less than settlement amount",
      details: {
        dispensationUSD,
      },
    };
  }

  // Check if profitable (settlement amount > minimum amount)
  if (settlementAmount <= minimumAmount) {
    return {
      success: false,
      reason: "Fill estimated to be unprofitable after execution costs",
      details: {
        dispensationUSD,
        gasCostUSD,
      },
    };
  }

  // Check if we have sufficient ETH for value
  if (cachedBalances.ETH < settlementAmount + bufferedDispensation) {
    return {
      success: false,
      reason: "ETH balance is less than settlement value",
      details: {
        dispensationUSD,
      },
    };
  }

  // Calculate final priority fee based on actual settlement amount
  const priorityFee = CHAIN_PRIORITY_FEES[chainId];

  // Calculate final value based on mandate token (using chain-specific ETH address)
  const value =
    mandateTokenAddress === mandateChainConfig.tokens.ETH.address.toLowerCase()
      ? settlementAmount + bufferedDispensation
      : bufferedDispensation;

  // Do final gas estimation with actual values
  const finalEstimatedGas = await publicClient.estimateGas({
    to: request.compact.mandate.tribunal as `0x${string}`,
    value,
    data,
    maxFeePerGas: priorityFee + (baseFee * 120n) / 100n,
    maxPriorityFeePerGas: priorityFee,
    account: address,
  });

  const finalGasWithBuffer = (finalEstimatedGas * 125n) / 100n;

  logger.info(
    `Got final gas estimate: ${finalEstimatedGas} (${finalGasWithBuffer} with buffer)`
  );

  // Check if we have enough ETH for value + gas using cached balance
  const requiredBalance =
    value + (priorityFee + (baseFee * 120n) / 100n) * finalGasWithBuffer;

  if (cachedBalances.ETH < requiredBalance) {
    const shortageWei = requiredBalance - cachedBalances.ETH;
    const shortageEth = Number(formatEther(shortageWei));
    return {
      success: false,
      reason: `Insufficient ETH balance. Need ${formatEther(requiredBalance)} ETH but only have ${formatEther(cachedBalances.ETH)} ETH (short ${shortageEth.toFixed(6)} ETH)`,
      details: {
        dispensationUSD,
        gasCostUSD,
      },
    };
  }

  logger.info(
    `account balance ${cachedBalances.ETH} exceeds required balance of ${requiredBalance}. Submitting transaction!`
  );

  // Get the account from the wallet client
  const account = walletClient.account;
  if (!account) {
    throw new Error("No account found in wallet client");
  }

  // Submit transaction with the wallet client
  const hash = await walletClient.sendTransaction({
    to: request.compact.mandate.tribunal as `0x${string}`,
    value,
    maxFeePerGas: priorityFee + (baseFee * 120n) / 100n,
    maxPriorityFeePerGas: priorityFee,
    gas: finalGasWithBuffer,
    data: data as `0x${string}`,
    chain,
    account,
  });

  // Calculate final costs and profit
  const finalGasCostWei =
    (priorityFee + (baseFee * 120n) / 100n) * finalGasWithBuffer;
  const finalGasCostEth = Number(formatEther(finalGasCostWei));
  const finalGasCostUSD = finalGasCostEth * ethPrice;

  logger.info(
    `Transaction submitted: ${hash} (${mandateChainConfig.blockExplorer}/tx/${hash})`
  );
  logger.info(
    `Settlement amount: ${settlementAmount} (minimum: ${minimumAmount})`
  );
  logger.info(
    `Final gas cost: $${finalGasCostUSD.toFixed(2)} (${formatEther(finalGasCostWei)} ETH)`
  );

  return {
    success: true,
    hash,
    details: {
      dispensationUSD,
      gasCostUSD: finalGasCostUSD,
      netProfitUSD: 0,
      minProfitUSD: 0,
    },
  };
}

import { type Address, parseAbi, encodeFunctionData } from "viem";
import type { WalletClient, PublicClient } from "viem";
import type { SupportedChainId } from "../config/constants.js";
import { CHAIN_CONFIG } from "../config/constants.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("Approvals");

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const MAX_UINT128 = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF");
const MIN_ETH_BALANCE = 100_000_000_000_000n; // 0.0001 ETH in wei

export async function checkAndSetTokenApprovals(
  chainId: SupportedChainId,
  tribunalAddress: Address,
  publicClient: PublicClient,
  walletClient: WalletClient
): Promise<void> {
  // Get the account from the wallet client
  const account = walletClient.account;
  if (!account) {
    throw new Error("No account found in wallet client");
  }

  // Check ETH balance
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance < MIN_ETH_BALANCE) {
    logger.error(
      `Insufficient ETH balance on chain ${chainId}. Have ${balance} wei, need ${MIN_ETH_BALANCE} wei`
    );
    return;
  }

  const tokens = ["WETH", "USDC"];

  for (const tokenSymbol of tokens) {
    const tokenAddress = CHAIN_CONFIG[chainId].tokens[tokenSymbol].address;

    try {
      // Skip if it's the zero address (native token)
      if (tokenAddress === "0x0000000000000000000000000000000000000000")
        continue;

      // Check current allowance
      const allowance = await publicClient.readContract({
        address: tokenAddress,
        abi: ERC20_ABI,
        functionName: "allowance",
        args: [account.address, tribunalAddress],
      });

      // If allowance is less than MAX_UINT128, approve
      if (allowance < MAX_UINT128) {
        logger.info(
          `Setting ${tokenSymbol} approval on chain ${chainId} for tribunal ${tribunalAddress}`
        );

        const data = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [tribunalAddress, MAX_UINT128],
        });

        // Get base fee
        const baseFee = await publicClient
          .getBlock({ blockTag: "latest" })
          .then((block) => block.baseFeePerGas || 0n);

        const hash = await walletClient.sendTransaction({
          to: tokenAddress,
          data,
          account,
          chain: null,
          maxFeePerGas: (baseFee * 120n) / 100n,
          maxPriorityFeePerGas: 1n,
        });

        logger.info(
          `Approval transaction sent for ${tokenSymbol} on chain ${chainId}: ${hash}`
        );
      } else {
        logger.info(
          `${tokenSymbol} already has sufficient approval on chain ${chainId}`
        );
      }
    } catch (error) {
      logger.error(
        `Error setting approval for ${tokenSymbol} on chain ${chainId}:`,
        error
      );
    }
  }
}

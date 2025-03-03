import {
  type Address,
  type PublicClient,
  type WalletClient,
  encodeFunctionData,
} from "viem";
import {
  CHAIN_PRIORITY_FEES,
  type SupportedChainId,
} from "../config/constants.js";
import { Logger } from "../utils/logger.js";

const logger = new Logger("TheCompactService");

const THE_COMPACT_ADDRESS = "0x00000000000018DF021Ff2467dF97ff846E09f48";

/**
 * @notice Status of a forced withdrawal
 * @dev Maps to the contract's ForcedWithdrawalStatus enum
 */
export enum ForcedWithdrawalStatus {
  Disabled = 0, // Not pending or enabled for forced withdrawal
  Pending = 1, // Not yet available, but initiated
  Enabled = 2, // Available for forced withdrawal on demand
}

const THE_COMPACT_ABI = [
  {
    inputs: [
      { name: "nonce", type: "uint256" },
      { name: "allocator", type: "address" },
    ],
    name: "hasConsumedAllocatorNonce",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "sponsor", type: "address" },
      { name: "claimHash", type: "bytes32" },
      { name: "typehash", type: "bytes32" },
    ],
    name: "getRegistrationStatus",
    outputs: [
      { name: "isActive", type: "bool" },
      { name: "expires", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "getForcedWithdrawalStatus",
    outputs: [
      { name: "status", type: "uint8" },
      { name: "forcedWithdrawalAvailableAt", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "id", type: "uint256" }],
    name: "enableForcedWithdrawal",
    outputs: [{ name: "withdrawableAt", type: "uint256" }],
    type: "function",
  },
  {
    inputs: [
      { name: "id", type: "uint256" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "forcedWithdrawal",
    outputs: [{ name: "", type: "bool" }],
    type: "function",
  },
] as const;

interface RegistrationStatus {
  isActive: boolean;
  expires: bigint;
}

export interface ForcedWithdrawalInfo {
  status: keyof typeof ForcedWithdrawalStatus;
  availableAt: number;
}

export class TheCompactService {
  // Map of chain IDs to their respective clients
  private readonly publicClients: Record<SupportedChainId, PublicClient>;
  private readonly walletClients: Record<SupportedChainId, WalletClient>;

  constructor(
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>
  ) {
    this.publicClients = publicClients;
    this.walletClients = walletClients;
  }

  async hasConsumedAllocatorNonce(
    chainId: SupportedChainId,
    nonce: bigint,
    allocator: `0x${string}`
  ): Promise<boolean> {
    const client = this.publicClients[chainId];
    if (!client) {
      throw new Error(`No client found for chain ${chainId}`);
    }

    const result = await client.readContract({
      address: THE_COMPACT_ADDRESS,
      abi: THE_COMPACT_ABI,
      functionName: "hasConsumedAllocatorNonce",
      args: [nonce, allocator],
    });

    return result as boolean;
  }

  async getRegistrationStatus(
    chainId: SupportedChainId,
    sponsor: `0x${string}`,
    claimHash: `0x${string}`,
    typehash: `0x${string}`
  ): Promise<RegistrationStatus> {
    const client = this.publicClients[chainId];
    if (!client) {
      throw new Error(`No client found for chain ${chainId}`);
    }

    try {
      logger.info(
        `Fetching registration status for sponsor ${sponsor}, claimHash ${claimHash}, and typehash ${typehash} on chain ${chainId}`
      );

      // Use explicit type assertion for the contract call result
      const result = await client.readContract({
        address: THE_COMPACT_ADDRESS,
        abi: THE_COMPACT_ABI,
        functionName: "getRegistrationStatus",
        args: [sponsor, claimHash, typehash],
      });

      // Access array elements directly with type assertion
      const resultArray = result as readonly [boolean, bigint];
      const isActive = resultArray[0];
      const expires = resultArray[1];

      logger.info(`Result: ${isActive}, ${expires}`);

      return { isActive, expires } as RegistrationStatus;
    } catch (error) {
      const errorInfo = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
        // For viem errors, they often have a cause property
        cause: (error as { cause?: unknown })?.cause,
        // Some errors might have a data property with more details
        data: (error as { data?: unknown })?.data,
        // Convert the whole error to string to capture anything else
        toString: String(error),
      };

      logger.error("Error in getRegistrationStatus:", {
        errorInfo,
        errorMessage: errorInfo.message,
        chainId,
        sponsor,
        claimHash,
        typehash,
      });
      throw error;
    }
  }

  async getForcedWithdrawalStatus(
    chainId: SupportedChainId,
    account: Address,
    lockId: bigint
  ): Promise<ForcedWithdrawalInfo> {
    const client = this.publicClients[chainId];
    if (!client) {
      throw new Error(`No client found for chain ${chainId}`);
    }

    const result = await client.readContract({
      address: THE_COMPACT_ADDRESS,
      abi: THE_COMPACT_ABI,
      functionName: "getForcedWithdrawalStatus",
      args: [account, lockId],
    });

    const [status, availableAt] = result as [number, bigint];

    // Map numeric status to enum key
    const statusKey = ForcedWithdrawalStatus[
      status
    ] as keyof typeof ForcedWithdrawalStatus;

    return {
      status: statusKey,
      availableAt: Number(availableAt),
    };
  }

  async enableForcedWithdrawal(
    chainId: SupportedChainId,
    lockId: bigint
  ): Promise<`0x${string}`> {
    logger.info(
      `Preparing to enable forced withdrawal for lock ${lockId} on chain ${chainId}`
    );

    const publicClient = this.publicClients[chainId];
    const walletClient = this.walletClients[chainId];

    if (!publicClient || !walletClient) {
      throw new Error(`No clients found for chain ${chainId}`);
    }

    // Get the account from the wallet client
    const account = walletClient.account;
    if (!account) {
      throw new Error("No account found in wallet client");
    }

    logger.info(`Using account ${account.address} for forced withdrawal`);

    // Encode the function call
    const data = encodeFunctionData({
      abi: THE_COMPACT_ABI,
      functionName: "enableForcedWithdrawal",
      args: [lockId],
    });

    logger.info(`Encoded enableForcedWithdrawal call for lock ${lockId}`);

    // Get base fee
    const baseFee = await publicClient
      .getBlock({ blockTag: "latest" })
      .then(
        (block: { baseFeePerGas: bigint | null }) => block.baseFeePerGas || 0n
      );

    logger.info(`Got base fee for chain ${chainId}: ${baseFee}`);

    // Submit the transaction
    logger.info(
      `Submitting enableForcedWithdrawal transaction for lock ${lockId}`
    );
    const hash = await walletClient.sendTransaction({
      to: THE_COMPACT_ADDRESS,
      data,
      account,
      chain: null,
      maxFeePerGas: (baseFee * 120n) / 100n,
      maxPriorityFeePerGas: CHAIN_PRIORITY_FEES[chainId],
    });

    logger.info(
      `Successfully submitted enableForcedWithdrawal transaction for lock ${lockId} on chain ${chainId}: ${hash}`
    );

    return hash;
  }

  async executeForcedWithdrawal(
    chainId: SupportedChainId,
    lockId: bigint,
    amount: bigint
  ): Promise<`0x${string}`> {
    logger.info(
      `Preparing to execute forced withdrawal for lock ${lockId} on chain ${chainId}`,
      { amount: amount.toString() }
    );

    const publicClient = this.publicClients[chainId];
    const walletClient = this.walletClients[chainId];

    if (!publicClient || !walletClient) {
      throw new Error(`No clients found for chain ${chainId}`);
    }

    // Get the account from the wallet client
    const account = walletClient.account;
    if (!account) {
      throw new Error("No account found in wallet client");
    }

    logger.info(`Using account ${account.address} for forced withdrawal`);

    // Double check that forced withdrawal is enabled
    const { status } = await this.getForcedWithdrawalStatus(
      chainId,
      account.address,
      lockId
    );

    if (status !== "Enabled") {
      throw new Error(
        `Forced withdrawal not enabled for lock ${lockId} on chain ${chainId}. ` +
          `Current status: ${status} (${ForcedWithdrawalStatus[status as keyof typeof ForcedWithdrawalStatus]})`
      );
    }

    // Encode the function call
    const data = encodeFunctionData({
      abi: THE_COMPACT_ABI,
      functionName: "forcedWithdrawal",
      args: [lockId, account.address, amount],
    });

    logger.info(`Encoded forcedWithdrawal call for lock ${lockId}`);

    // Get base fee
    const baseFee = await publicClient
      .getBlock({ blockTag: "latest" })
      .then(
        (block: { baseFeePerGas: bigint | null }) => block.baseFeePerGas || 0n
      );

    logger.info(`Got base fee for chain ${chainId}: ${baseFee}`);

    // Submit the transaction
    logger.info(`Submitting forcedWithdrawal transaction for lock ${lockId}`, {
      amount: amount.toString(),
    });
    const hash = await walletClient.sendTransaction({
      to: THE_COMPACT_ADDRESS,
      data,
      account,
      chain: null,
      maxFeePerGas: (baseFee * 120n) / 100n,
      maxPriorityFeePerGas: CHAIN_PRIORITY_FEES[chainId],
    });

    logger.info(
      `Successfully submitted forcedWithdrawal transaction for lock ${lockId} on chain ${chainId}: ${hash}`,
      { amount: amount.toString() }
    );

    return hash;
  }

  public getPublicClient(chainId: SupportedChainId) {
    return this.publicClients[chainId];
  }
}

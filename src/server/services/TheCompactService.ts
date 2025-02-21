import {
  type PublicClient,
  type WalletClient,
  type Address,
  encodeFunctionData,
} from "viem";
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
  private readonly publicClients: { [chainId: number]: PublicClient };
  private readonly walletClients: { [chainId: number]: WalletClient };

  constructor(
    publicClients: { [chainId: number]: PublicClient },
    walletClients: { [chainId: number]: WalletClient }
  ) {
    this.publicClients = publicClients;
    this.walletClients = walletClients;
  }

  async hasConsumedAllocatorNonce(
    chainId: number,
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
    chainId: number,
    sponsor: `0x${string}`,
    claimHash: `0x${string}`,
    typehash: `0x${string}`
  ): Promise<RegistrationStatus> {
    const client = this.publicClients[chainId];
    if (!client) {
      throw new Error(`No client found for chain ${chainId}`);
    }

    const result = await client.readContract({
      address: THE_COMPACT_ADDRESS,
      abi: THE_COMPACT_ABI,
      functionName: "getRegistrationStatus",
      args: [sponsor, claimHash, typehash],
    });

    return result as RegistrationStatus;
  }

  async getForcedWithdrawalStatus(
    chainId: number,
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
    chainId: number,
    lockId: bigint
  ): Promise<`0x${string}`> {
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

    // Encode the function call
    const data = encodeFunctionData({
      abi: THE_COMPACT_ABI,
      functionName: "enableForcedWithdrawal",
      args: [lockId],
    });

    // Get base fee
    const baseFee = await publicClient
      .getBlock({ blockTag: "latest" })
      .then((block) => block.baseFeePerGas || 0n);

    // Submit the transaction
    const hash = await walletClient.sendTransaction({
      to: THE_COMPACT_ADDRESS,
      data,
      account,
      chain: null,
      maxFeePerGas: (baseFee * 120n) / 100n,
      maxPriorityFeePerGas: 1n,
    });

    logger.info(
      `Submitted enableForcedWithdrawal transaction for lock ${lockId} on chain ${chainId}: ${hash}`
    );

    return hash;
  }

  async executeForcedWithdrawal(
    chainId: number,
    lockId: bigint,
    amount: bigint
  ): Promise<`0x${string}`> {
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

    // Check that forced withdrawal is enabled
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

    // Get base fee
    const baseFee = await publicClient
      .getBlock({ blockTag: "latest" })
      .then((block) => block.baseFeePerGas || 0n);

    // Submit the transaction
    const hash = await walletClient.sendTransaction({
      to: THE_COMPACT_ADDRESS,
      data,
      account,
      chain: null,
      maxFeePerGas: (baseFee * 120n) / 100n,
      maxPriorityFeePerGas: 1n,
    });

    logger.info(
      `Submitted forcedWithdrawal transaction for lock ${lockId} on chain ${chainId}: ${hash}`,
      { amount: amount.toString() }
    );

    return hash;
  }
}

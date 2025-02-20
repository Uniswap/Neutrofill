import type { PublicClient } from "viem";

const THE_COMPACT_ADDRESS = "0x00000000000018DF021Ff2467dF97ff846E09f48";

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
] as const;

interface RegistrationStatus {
  isActive: boolean;
  expires: bigint;
}

export class TheCompactService {
  // Map of chain IDs to their respective public clients
  private readonly clients: { [chainId: number]: PublicClient };

  constructor(chainClients: { [chainId: number]: PublicClient }) {
    this.clients = chainClients;
  }

  async hasConsumedAllocatorNonce(
    chainId: number,
    nonce: bigint,
    allocator: `0x${string}`
  ): Promise<boolean> {
    const client = this.clients[chainId];
    if (!client) {
      throw new Error(`No client configured for chain ID: ${chainId}`);
    }

    return client.readContract({
      address: THE_COMPACT_ADDRESS as `0x${string}`,
      abi: THE_COMPACT_ABI,
      functionName: "hasConsumedAllocatorNonce",
      args: [nonce, allocator],
    });
  }

  async getRegistrationStatus(
    chainId: number,
    sponsor: `0x${string}`,
    claimHash: `0x${string}`,
    typehash: `0x${string}`
  ): Promise<RegistrationStatus> {
    const client = this.clients[chainId];
    if (!client) {
      throw new Error(`No client configured for chain ID: ${chainId}`);
    }

    const [isActive, expires] = await client.readContract({
      address: THE_COMPACT_ADDRESS as `0x${string}`,
      abi: THE_COMPACT_ABI,
      functionName: "getRegistrationStatus",
      args: [sponsor, claimHash, typehash],
    });

    return { isActive, expires: BigInt(expires) };
  }
}

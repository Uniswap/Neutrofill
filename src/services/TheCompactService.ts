import { type PublicClient } from 'viem';

const THE_COMPACT_ADDRESS = '0x00000000000018DF021Ff2467dF97ff846E09f48';

const THE_COMPACT_ABI = [
  {
    inputs: [
      { name: 'nonce', type: 'uint256' },
      { name: 'allocator', type: 'address' },
    ],
    name: 'hasConsumedAllocatorNonce',
    outputs: [{ name: '', type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

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
      functionName: 'hasConsumedAllocatorNonce',
      args: [nonce, allocator],
    });
  }
}

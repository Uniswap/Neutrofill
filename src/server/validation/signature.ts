import {
  compactSignatureToSignature,
  keccak256,
  parseCompactSignature,
  recoverAddress,
  serializeSignature,
  toBytes,
} from "viem";
import { ALLOCATORS } from "../config/allocators.js";
import type { SupportedChainId } from "../config/constants.js";
import type { TheCompactService } from "../services/TheCompactService";
import type { BroadcastRequest } from "../types/broadcast";
import { Logger } from "../utils/logger.js";

const logger = new Logger("SignatureValidation");

// Chain-specific prefixes for signature verification
const CHAIN_PREFIXES = {
  1: "0x1901afbd5f3d34c216b31ba8b82d0b32ae91e4edea92dd5bbf4c1ad028f72364a211", // ethereum
  10: "0x1901ea25de9c16847077fe9d95916c29598dc64f4850ba02c5dbe7800d2e2ecb338e", // optimism
  8453: "0x1901a1324f3bfe91ee592367ae7552e9348145e65b410335d72e4507dcedeb41bf52", // base
  130: "0x190150e2b173e1ac2eac4e4995e45458f4cd549c256c423a041bf17d0c0a4a736d2c", // unichain
} as const;

// Extract allocator ID from compact.id
const extractAllocatorId = (compactId: string): string => {
  const compactIdBigInt = BigInt(compactId);

  // Shift right by 160 bits to remove the input token part
  const shiftedBigInt = compactIdBigInt >> 160n;

  // Then mask to get only the allocator ID bits (92 bits)
  const mask = (1n << 92n) - 1n;
  const allocatorIdBigInt = shiftedBigInt & mask;

  return allocatorIdBigInt.toString();
};

// The Compact typehash for registration checks
const COMPACT_REGISTRATION_TYPEHASH =
  "0x27f09e0bb8ce2ae63380578af7af85055d3ada248c502e2378b85bc3d05ee0b0" as const;

async function verifySignature(
  claimHash: string,
  signature: string,
  expectedSigner: string,
  chainPrefix: string
): Promise<boolean> {
  try {
    // Ensure hex values have 0x prefix
    const normalizedClaimHash = claimHash.startsWith("0x")
      ? claimHash
      : `0x${claimHash}`;
    const normalizedPrefix = chainPrefix.startsWith("0x")
      ? chainPrefix
      : `0x${chainPrefix}`;
    const normalizedSignature = signature.startsWith("0x")
      ? signature
      : `0x${signature}`;

    logger.debug("Verifying signature with:", {
      normalizedClaimHash,
      normalizedPrefix,
      normalizedSignature,
      expectedSigner,
    });

    // Convert hex strings to bytes and concatenate
    const prefixBytes = toBytes(normalizedPrefix);
    const claimHashBytes = toBytes(normalizedClaimHash);

    // Concatenate bytes
    const messageBytes = new Uint8Array(
      prefixBytes.length + claimHashBytes.length
    );
    messageBytes.set(prefixBytes);
    messageBytes.set(claimHashBytes, prefixBytes.length);

    // Get the digest
    const digest = keccak256(messageBytes);
    logger.debug(`Generated digest: ${digest}`);

    // Convert compact signature to full signature
    const parsedCompactSig = parseCompactSignature(
      normalizedSignature as `0x${string}`
    );
    const fullSig = compactSignatureToSignature(parsedCompactSig);
    const serializedSig = serializeSignature(fullSig);
    logger.debug(`Parsed signature: ${serializedSig}`);

    // Recover the signer address
    const recoveredAddress = await recoverAddress({
      hash: digest,
      signature: serializedSig,
    });
    logger.debug(`Recovered address: ${recoveredAddress}`);
    logger.debug(`Expected signer: ${expectedSigner}`);
    logger.debug(
      `Match: ${recoveredAddress.toLowerCase() === expectedSigner.toLowerCase()}`
    );

    // Compare recovered address with expected signer
    return recoveredAddress.toLowerCase() === expectedSigner.toLowerCase();
  } catch (error) {
    logger.error("Signature verification failed:", error);
    return false;
  }
}

export async function verifyBroadcastRequest(
  request: BroadcastRequest,
  theCompactService: TheCompactService
): Promise<{
  isValid: boolean;
  isOnchainRegistration: boolean;
  error?: string;
}> {
  const chainId = Number.parseInt(
    request.chainId.toString()
  ) as SupportedChainId;
  logger.info("Verifying broadcast request:", {
    chainId,
    sponsor: request.compact.sponsor,
    arbiter: request.compact.arbiter,
    nonce: request.compact.nonce,
    expires: request.compact.expires,
    id: request.compact.id,
    amount: request.compact.amount,
    sponsorSignature: request.sponsorSignature,
    allocatorSignature: request.allocatorSignature,
  });

  // Get chain prefix based on chainId
  const chainPrefix = CHAIN_PREFIXES[chainId];
  if (!chainPrefix) {
    throw new Error(`Unsupported chain ID: ${chainId}`);
  }

  // Get the claim hash from the request
  const claimHash = request.claimHash;
  if (!claimHash) {
    throw new Error("Claim hash is required for signature verification");
  }

  // Try to verify sponsor signature first
  let isSponsorValid = false;
  let registrationStatus = null;
  let isOnchainRegistration = false;
  let error: string | undefined;

  try {
    logger.debug("Attempting to verify sponsor signature:", {
      claimHash,
      sponsorSignature: request.sponsorSignature,
      sponsor: request.compact.sponsor,
      chainPrefix,
    });

    if (request.sponsorSignature && request.sponsorSignature !== "0x") {
      isSponsorValid = await verifySignature(
        claimHash,
        request.sponsorSignature,
        request.compact.sponsor,
        chainPrefix
      );

      if (!isSponsorValid) {
        error = "Invalid sponsor signature provided";
      }
    } else {
      // Check registration status if no valid signature provided
      logger.debug(
        "No sponsor signature provided, checking onchain registration..."
      );
      try {
        registrationStatus = await theCompactService.getRegistrationStatus(
          chainId,
          request.compact.sponsor as `0x${string}`,
          claimHash as `0x${string}`,
          COMPACT_REGISTRATION_TYPEHASH as `0x${string}`
        );

        logger.debug("Registration status check result:", {
          isActive: registrationStatus.isActive,
          expires: registrationStatus.expires?.toString(),
          compactExpires: request.compact.expires,
        });

        if (registrationStatus.isActive) {
          isSponsorValid = true;
          isOnchainRegistration = true;
        } else {
          error =
            "No sponsor signature provided (0x) and no active onchain registration found";
        }
      } catch (err) {
        logger.error("Registration status check failed:", {
          error: err,
          chainId,
          sponsor: request.compact.sponsor,
          claimHash,
        });
        error = "Failed to check onchain registration status";
      }
    }
  } catch (err) {
    logger.error("Sponsor signature verification failed:", err);
    error = "Sponsor signature verification failed";
  }

  if (!isSponsorValid) {
    logger.error(
      "Verification failed: Invalid sponsor signature and no active registration found",
      {
        sponsorSignaturePresent: !!request.sponsorSignature,
        registrationStatus: registrationStatus
          ? {
              isActive: registrationStatus.isActive,
              expires: registrationStatus.expires?.toString(),
            }
          : null,
      }
    );
    return { isValid: false, isOnchainRegistration, error };
  }

  // Extract allocator ID from compact.id
  const allocatorId = extractAllocatorId(request.compact.id);
  logger.debug("Extracted allocator ID:", allocatorId);

  // Find the matching allocator
  let allocatorAddress: string | undefined;
  for (const [name, allocator] of Object.entries(ALLOCATORS)) {
    if (allocator.id === allocatorId) {
      allocatorAddress = allocator.signingAddress;
      logger.debug(
        `Found matching allocator: ${name} with address ${allocatorAddress}`
      );
      break;
    }
  }

  if (!allocatorAddress) {
    logger.error(`No allocator found for ID: ${allocatorId}`);
    return {
      isValid: false,
      isOnchainRegistration,
      error: `No allocator found for ID: ${allocatorId}`,
    };
  }

  // Verify allocator signature
  const isAllocatorValid = await verifySignature(
    claimHash,
    request.allocatorSignature,
    allocatorAddress,
    chainPrefix
  );
  if (!isAllocatorValid) {
    logger.error("Invalid allocator signature");
    return {
      isValid: false,
      isOnchainRegistration,
      error: "Invalid allocator signature",
    };
  }

  return { isValid: true, isOnchainRegistration };
}

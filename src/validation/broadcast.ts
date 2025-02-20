import { z } from 'zod';
import { Request, Response, NextFunction } from 'express';

// Custom validators and constants
const isHexString = (str: string) => /^0x[0-9a-fA-F]*$/.test(str);
const isAddress = (str: string) => isHexString(str) && str.length === 42; // 0x + 40 chars (20 bytes)
const isHash = (str: string) => isHexString(str) && str.length === 66; // 0x + 64 chars (32 bytes)
const is64ByteHex = (str: string) => isHexString(str) && str.length === 130; // 0x + 128 chars (64 bytes)
const isEmptyHex = (str: string) => str === '0x';
const isNumericString = (str: string) => /^-?\d+$/.test(str);
const isNumericOrHexString = (str: string) => isNumericString(str) || isHexString(str);
const UINT32_MAX = 4294967295; // 2^32 - 1

const numericOrHexSchema = z.string().refine(isNumericOrHexString, {
  message: 'Must be either a numeric string or a hex string with 0x prefix',
});

const addressSchema = z.string().refine(isAddress, {
  message: 'Must be a valid Ethereum address (0x prefix + 20 bytes)',
});

const hashSchema = z.string().refine(isHash, {
  message: 'Must be a valid hash (0x prefix + 32 bytes)',
});

// Type definitions
const MandateSchema = z.object({
  chainId: z
    .number()
    .int()
    .min(1)
    .max(UINT32_MAX)
    .refine(n => n >= 1 && n <= UINT32_MAX, `Chain ID must be between 1 and ${UINT32_MAX}`),
  tribunal: addressSchema,
  recipient: addressSchema,
  expires: numericOrHexSchema,
  token: addressSchema,
  minimumAmount: numericOrHexSchema,
  baselinePriorityFee: numericOrHexSchema,
  scalingFactor: numericOrHexSchema,
  salt: hashSchema,
});

const CompactMessageSchema = z.object({
  arbiter: addressSchema,
  sponsor: addressSchema,
  nonce: hashSchema,
  expires: numericOrHexSchema,
  id: numericOrHexSchema,
  amount: numericOrHexSchema,
  mandate: MandateSchema,
});

const ContextSchema = z.object({
  dispensation: numericOrHexSchema,
  dispensationUSD: z.string(),
  spotOutputAmount: numericOrHexSchema,
  quoteOutputAmountDirect: numericOrHexSchema,
  quoteOutputAmountNet: numericOrHexSchema,
  deltaAmount: numericOrHexSchema.optional(),
  slippageBips: z
    .number()
    .int()
    .min(0)
    .max(10000)
    .refine(n => n >= 0 && n <= 10000, 'Slippage must be between 0 and 10000 basis points')
    .optional(),
  witnessTypeString: z.string(),
  witnessHash: hashSchema,
  claimHash: hashSchema.optional(),
});

export const BroadcastRequestSchema = z.object({
  chainId: numericOrHexSchema,
  compact: CompactMessageSchema,
  sponsorSignature: z
    .string()
    .refine(
      str => str === null || isEmptyHex(str) || is64ByteHex(str),
      'Sponsor signature must be null, 0x, or a 64-byte hex string'
    )
    .nullable(),
  allocatorSignature: z
    .string()
    .refine(is64ByteHex, 'Allocator signature must be a 64-byte hex string'),
  context: ContextSchema,
  claimHash: hashSchema.optional(),
});

// Validation middleware
export function validateBroadcastRequest(req: Request, res: Response, next: NextFunction) {
  try {
    BroadcastRequestSchema.parse(req.body);
    next();
  } catch (error) {
    res.status(400).json({
      success: false,
      error: 'Invalid payload',
      details: error,
    });
  }
}

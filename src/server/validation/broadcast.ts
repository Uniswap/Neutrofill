import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

// Custom validators and constants
const isHexString = (str: string) => /^0x[0-9a-fA-F]*$/.test(str);
const isAddress = (str: string) => isHexString(str) && str.length === 42; // 0x + 40 chars (20 bytes)
const isHash = (str: string) => isHexString(str) && str.length === 66; // 0x + 64 chars (32 bytes)
const is64ByteHex = (str: string) => isHexString(str) && str.length === 130; // 0x + 128 chars (64 bytes)
const isEmptyHex = (str: string) => str === "0x";
const isNumericString = (str: string) => /^-?\d+$/.test(str);
const isNumericOrHexString = (str: string) =>
  isNumericString(str) || isHexString(str);
const UINT32_MAX = 4294967295; // 2^32 - 1

const numericOrHexSchema = z.string().refine(isNumericOrHexString, {
  message: "Must be either a numeric string or a hex string with 0x prefix",
});

const addressSchema = z.string().refine(isAddress, {
  message: "Must be a valid Ethereum address (0x prefix + 20 bytes)",
});

const hashSchema = z.string().refine(isHash, {
  message: "Must be a valid hash (0x prefix + 32 bytes)",
});

// Helper functions
const isNumericStringHelper = (value: string): boolean => {
  return (
    !Number.isNaN(Number(value)) && !Number.isNaN(Number.parseFloat(value))
  );
};

const isEmptyHexHelper = (value: string): boolean => {
  return value === "0x" || value === "";
};

const is64ByteHexHelper = (value: string): boolean => {
  return /^0x[0-9a-fA-F]{128}$/.test(value);
};

interface UnvalidatedBroadcastRequest {
  chainId?: string | number;
  compact?: {
    mandate?: unknown;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

const parseChainId = (value: string | number): number => {
  const num = typeof value === "string" ? Number.parseInt(value) : value;
  if (Number.isNaN(num) || num < 1 || num > UINT32_MAX) {
    throw new Error(`Chain ID must be between 1 and ${UINT32_MAX}`);
  }
  return num;
};

// Schema definitions
const chainIdSchema = z.union([
  z
    .number()
    .int()
    .min(1)
    .max(UINT32_MAX)
    .refine(
      (n) => n >= 1 && n <= UINT32_MAX,
      `Chain ID must be between 1 and ${UINT32_MAX}`
    ),
  z
    .string()
    .refine(isNumericStringHelper, "Chain ID must be a valid number")
    .transform(parseChainId),
]);

const MandateSchema = z.object({
  chainId: chainIdSchema,
  tribunal: addressSchema,
  recipient: addressSchema,
  expires: numericOrHexSchema,
  token: addressSchema,
  minimumAmount: numericOrHexSchema,
  baselinePriorityFee: numericOrHexSchema,
  scalingFactor: numericOrHexSchema,
  salt: hashSchema,
});

const CompactSchema = z.object({
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
    .refine(
      (n) => n >= 0 && n <= 10000,
      "Slippage must be between 0 and 10000 basis points"
    )
    .optional(),
  witnessTypeString: z.string(),
  witnessHash: hashSchema,
  claimHash: hashSchema.optional(),
});

const BroadcastRequestSchema = z.object({
  chainId: chainIdSchema,
  compact: CompactSchema,
  sponsorSignature: z
    .string()
    .refine(
      (str) => str === null || isEmptyHexHelper(str) || is64ByteHexHelper(str),
      "Sponsor signature must be null, 0x, or a 64-byte hex string"
    )
    .nullable(),
  allocatorSignature: z
    .string()
    .refine(
      is64ByteHexHelper,
      "Allocator signature must be a 64-byte hex string"
    ),
  context: ContextSchema,
  claimHash: hashSchema.optional(),
});

// Validation middleware
export function validateBroadcastRequestMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    // Ensure we're working with JSON content type
    if (!req.is("application/json")) {
      throw new Error("Content-Type must be application/json");
    }

    // Ensure we have a request body
    const requestBody = req.body;
    if (!requestBody || typeof requestBody !== "object") {
      throw new Error(`Invalid request body type: ${typeof requestBody}`);
    }

    // Validate the request body
    const validatedBody = BroadcastRequestSchema.parse(requestBody);

    // Store validated body back in request
    req.body = validatedBody;
    next();
  } catch (error) {
    console.error("Validation error:", {
      error,
      requestBody: req.body,
      contentType: req.headers["content-type"],
      zodErrors:
        error instanceof z.ZodError
          ? error.errors.map((e) => ({
              path: e.path.join("."),
              message: e.message,
              code: e.code,
            }))
          : undefined,
    });

    if (error instanceof z.ZodError) {
      res.status(400).json({
        success: false,
        error: "Invalid payload",
        details: error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
          code: e.code,
        })),
      });
    } else {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}

// Type definitions
export type BroadcastRequest = z.infer<typeof BroadcastRequestSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
export type Compact = z.infer<typeof CompactSchema>;
export type Context = z.infer<typeof ContextSchema>;

// Validation functions
export const validateBroadcastRequest = (data: unknown): BroadcastRequest => {
  const unvalidatedData = data as UnvalidatedBroadcastRequest;

  try {
    const result = BroadcastRequestSchema.parse(data);
    return result;
  } catch (error) {
    console.error("Validation failed:", {
      error,
      zodErrors: error instanceof z.ZodError ? error.errors : undefined,
      rawData: data,
    });
    throw error;
  }
};

import type { NextFunction, Request, Response } from "express";
import { z } from "zod";

// Schema definitions
const MandateSchema = z.object({
  chainId: z.number(),
  expires: z.string(),
  tribunal: z.string(),
  recipient: z.string(),
  allocator: z.string(),
  token: z.string(),
  amount: z.string(),
  salt: z.string(),
});

const CompactSchema = z.object({
  arbiter: z.string(),
  sponsor: z.string(),
  nonce: z.string(),
  expires: z.string(),
  id: z.string(),
  amount: z.string(),
  mandate: MandateSchema,
});

const ContextSchema = z.object({
  timestamp: z.number(),
  source: z.string(),
});

const BroadcastRequestSchema = z.object({
  chainId: z.string(),
  compact: CompactSchema,
  sponsorSignature: z.string().nullable(),
  allocatorSignature: z.string(),
  context: ContextSchema,
});

// Type definitions
export type BroadcastRequest = z.infer<typeof BroadcastRequestSchema>;
export type Mandate = z.infer<typeof MandateSchema>;
export type Compact = z.infer<typeof CompactSchema>;
export type Context = z.infer<typeof ContextSchema>;

// Validation functions
export const validateBroadcastRequest = (data: unknown): BroadcastRequest => {
  const result = BroadcastRequestSchema.parse(data);
  return result;
};

// Validation middleware
export function validateBroadcastRequestMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    req.body = validateBroadcastRequest(req.body);
    next();
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: "Invalid request data",
        details: error.errors,
      });
    } else {
      res.status(500).json({
        error: "Internal server error",
      });
    }
  }
}

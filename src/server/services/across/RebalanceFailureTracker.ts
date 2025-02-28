import { Logger } from "../../utils/logger.js";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import { TokenUtils } from "./TokenUtils.js";

/**
 * Tracks failed rebalance attempts to avoid continuous retries
 */
interface FailedRebalanceAttempt {
  sourceChainId: SupportedChainId;
  destinationChainId: SupportedChainId;
  token: string;
  amount: number;
  timestamp: number;
  reason: string;
  // Track the balances at the time of failure to detect significant changes
  sourceTokenBalance?: string;
  destinationTokenBalance?: string;
}

/**
 * Tracks and manages failed rebalance attempts to prevent continuous retries
 */
export class RebalanceFailureTracker {
  private readonly logger: Logger;
  private readonly tokenUtils: TokenUtils;
  private readonly FAILED_ATTEMPT_EXPIRY = 30 * 60 * 1000; // 30 minutes
  private readonly BALANCE_CHANGE_THRESHOLD = 0.1; // 10% change in balance to retry
  private failedRebalanceAttempts: FailedRebalanceAttempt[] = [];

  constructor() {
    this.logger = new Logger("RebalanceFailureTracker");
    this.tokenUtils = new TokenUtils();
  }

  /**
   * Check if a rebalance attempt has failed recently
   */
  public hasRecentFailedAttempt(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    token: string,
    balances: AggregateBalance
  ): boolean {
    // Filter for recent failed attempts for this specific source, destination, and token
    const recentFailedAttempts = this.failedRebalanceAttempts.filter(
      (attempt) =>
        attempt.sourceChainId === sourceChainId &&
        attempt.destinationChainId === destinationChainId &&
        attempt.token === token &&
        Date.now() - attempt.timestamp < this.FAILED_ATTEMPT_EXPIRY &&
        (attempt.reason.includes("AMOUNT_TOO_LOW") || // Track AMOUNT_TOO_LOW errors
          attempt.reason.includes("UNSUPPORTED_TOKEN") || // Also track UNSUPPORTED_TOKEN errors
          attempt.reason.includes("Unsupported token")) // Handle both error message formats
    );

    if (recentFailedAttempts.length === 0) {
      return false; // No recent failures with tracked error types
    }

    // Get the most recent failed attempt
    const lastFailedAttempt = recentFailedAttempts.sort(
      (a, b) => b.timestamp - a.timestamp
    )[0];

    // Get current balances
    const currentSourceTokenBalance = this.tokenUtils.getTokenBalance(
      token,
      sourceChainId,
      balances
    );
    const currentDestinationTokenBalance = this.tokenUtils.getTokenBalance(
      token,
      destinationChainId,
      balances
    );

    // If we don't have balance information, we can't make a good decision
    if (
      !currentSourceTokenBalance ||
      !currentDestinationTokenBalance ||
      !lastFailedAttempt.sourceTokenBalance ||
      !lastFailedAttempt.destinationTokenBalance
    ) {
      this.logger.debug(
        "Missing balance information to compare with failed attempt"
      );
      return true; // Be conservative and skip the rebalance
    }

    try {
      // Convert to BigInt for safe comparison
      const oldSourceBalance = BigInt(lastFailedAttempt.sourceTokenBalance);
      const newSourceBalance = BigInt(currentSourceTokenBalance);
      const oldDestBalance = BigInt(lastFailedAttempt.destinationTokenBalance);
      const newDestBalance = BigInt(currentDestinationTokenBalance);

      // Check if either balance is zero
      if (oldSourceBalance === 0n || oldDestBalance === 0n) {
        // If old balance was zero and new is not, that's a significant change
        if (
          (oldSourceBalance === 0n && newSourceBalance > 0n) ||
          (oldDestBalance === 0n && newDestBalance > 0n)
        ) {
          return false; // Allow rebalance
        }
      } else {
        // Calculate percentage changes
        const sourceChangeRatio = Math.abs(
          Number(newSourceBalance - oldSourceBalance) / Number(oldSourceBalance)
        );
        const destChangeRatio = Math.abs(
          Number(newDestBalance - oldDestBalance) / Number(oldDestBalance)
        );

        // If either balance has changed significantly, allow the rebalance
        if (
          sourceChangeRatio > this.BALANCE_CHANGE_THRESHOLD ||
          destChangeRatio > this.BALANCE_CHANGE_THRESHOLD
        ) {
          this.logger.debug(
            `Balance changed significantly (source: ${sourceChangeRatio.toFixed(2)}, dest: ${destChangeRatio.toFixed(2)}), allowing rebalance attempt`
          );
          return false;
        }
      }

      // If we get here, balances haven't changed enough to warrant retrying
      this.logger.debug(
        `Skipping rebalance due to recent error (${new Date(lastFailedAttempt.timestamp).toISOString()}) and no significant balance change`
      );
      return true;
    } catch (error) {
      this.logger.error("Error comparing balances:", error);
      return true; // Be conservative and skip the rebalance on error
    }
  }

  /**
   * Add a failed rebalance attempt to the tracking list
   */
  public addFailedAttempt(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    token: string,
    amount: number,
    reason: string,
    balances: AggregateBalance
  ): void {
    // Only track AMOUNT_TOO_LOW and UNSUPPORTED_TOKEN errors
    if (
      !reason.includes("AMOUNT_TOO_LOW") &&
      !reason.includes("UNSUPPORTED_TOKEN") &&
      !reason.includes("Unsupported token")
    ) {
      return;
    }

    // Get token balances for tracking
    const sourceTokenBalance = this.tokenUtils.getTokenBalance(
      token,
      sourceChainId,
      balances
    );
    const destinationTokenBalance = this.tokenUtils.getTokenBalance(
      token,
      destinationChainId,
      balances
    );

    // Log the failure with appropriate message based on the error type
    if (reason.includes("AMOUNT_TOO_LOW")) {
      this.logger.info(
        `Tracking failed rebalance attempt for ${amount} ${token} from chain ${sourceChainId} to chain ${destinationChainId} due to AMOUNT_TOO_LOW error`
      );
    } else if (
      reason.includes("UNSUPPORTED_TOKEN") ||
      reason.includes("Unsupported token")
    ) {
      this.logger.info(
        `Tracking failed rebalance attempt for ${token} from chain ${sourceChainId} to chain ${destinationChainId} due to UNSUPPORTED_TOKEN error`
      );
    } else {
      this.logger.info(
        `Tracking failed rebalance attempt for ${amount} ${token} from chain ${sourceChainId} to chain ${destinationChainId}: ${reason}`
      );
    }

    // Add to the failed attempts list
    const failedAttempt: FailedRebalanceAttempt = {
      sourceChainId,
      destinationChainId,
      token,
      amount,
      timestamp: Date.now(),
      reason,
      sourceTokenBalance,
      destinationTokenBalance,
    };

    this.failedRebalanceAttempts.push(failedAttempt);

    this.logger.info(
      `Tracked failed rebalance attempt for ${amount} ${token} from chain ${sourceChainId} to chain ${destinationChainId} due to: ${reason}`,
      {
        sourceTokenBalance,
        destinationTokenBalance,
        failedAttemptsCount: this.failedRebalanceAttempts.length,
      }
    );

    // Clean up expired failed attempts
    this.cleanupExpiredFailedAttempts();
  }

  /**
   * Clean up expired failed attempts
   */
  private cleanupExpiredFailedAttempts(): void {
    const now = Date.now();
    const expiredCutoff = now - this.FAILED_ATTEMPT_EXPIRY;

    const initialCount = this.failedRebalanceAttempts.length;
    this.failedRebalanceAttempts = this.failedRebalanceAttempts.filter(
      (attempt) => attempt.timestamp > expiredCutoff
    );

    const removedCount = initialCount - this.failedRebalanceAttempts.length;
    if (removedCount > 0) {
      this.logger.debug(
        `Cleaned up ${removedCount} expired failed rebalance attempts`
      );
    }
  }
}

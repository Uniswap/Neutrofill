import { randomUUID } from "node:crypto";
import type { SupportedChainId } from "../../config/constants.js";
import { Logger } from "../../utils/logger.js";
import type {
  RebalanceOperation,
  RebalanceStatus,
} from "../../types/rebalance.js";

/**
 * Store for managing rebalance operations with locking mechanism
 * to prevent concurrent operations
 */
export class RebalanceOperationStore {
  private readonly logger: Logger;
  private operations: Map<string, RebalanceOperation> = new Map();
  private processingLock = false;
  private lastRebalanceTime = 0;

  constructor() {
    this.logger = new Logger("RebalanceOperationStore");
  }

  /**
   * Create a new rebalance operation
   */
  public createOperation(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    token: string,
    amount: number,
    usdValue: number
  ): RebalanceOperation {
    const id = randomUUID();
    const now = Date.now();

    const operation: RebalanceOperation = {
      id,
      sourceChainId,
      destinationChainId,
      token,
      amount,
      usdValue,
      status: "Pending",
      createdAt: now,
      updatedAt: now,
    };

    this.operations.set(id, operation);
    this.logger.info(`Created rebalance operation ${id}`, operation);

    return operation;
  }

  /**
   * Update an existing rebalance operation
   */
  public updateOperation(
    id: string,
    updates: Partial<Omit<RebalanceOperation, "id" | "createdAt">>
  ): RebalanceOperation | null {
    const operation = this.operations.get(id);

    if (!operation) {
      this.logger.warn(`Attempted to update non-existent operation ${id}`);
      return null;
    }

    const updatedOperation = {
      ...operation,
      ...updates,
      updatedAt: Date.now(),
    };

    this.operations.set(id, updatedOperation);
    this.logger.debug(`Updated rebalance operation ${id}`, updatedOperation);

    return updatedOperation;
  }

  /**
   * Get a rebalance operation by ID
   */
  public getOperation(id: string): RebalanceOperation | null {
    return this.operations.get(id) || null;
  }

  /**
   * Get all rebalance operations
   */
  public getAllOperations(): RebalanceOperation[] {
    return Array.from(this.operations.values());
  }

  /**
   * Get the most recent pending operation
   */
  public getNextPendingOperation(): RebalanceOperation | null {
    const pendingOperations = Array.from(this.operations.values())
      .filter((op) => op.status === "Pending")
      .sort((a, b) => a.createdAt - b.createdAt);

    return pendingOperations.length > 0 ? pendingOperations[0] : null;
  }

  /**
   * Try to acquire the processing lock
   * @returns true if the lock was acquired, false otherwise
   */
  public tryAcquireProcessingLock(): boolean {
    if (this.processingLock) {
      return false;
    }

    this.processingLock = true;
    return true;
  }

  /**
   * Release the processing lock
   */
  public releaseProcessingLock(): void {
    this.processingLock = false;
  }

  /**
   * Check if the processing lock is currently held
   */
  public isProcessingLocked(): boolean {
    return this.processingLock;
  }

  /**
   * Update the last rebalance time
   */
  public updateLastRebalanceTime(): void {
    this.lastRebalanceTime = Date.now();
  }

  /**
   * Check if the cooldown period has elapsed since the last rebalance
   */
  public hasCooldownElapsed(cooldownPeriodMs: number): boolean {
    return Date.now() - this.lastRebalanceTime >= cooldownPeriodMs;
  }

  /**
   * Clear completed operations older than the specified age
   */
  public clearOldOperations(maxAgeMs: number): void {
    const now = Date.now();
    const cutoffTime = now - maxAgeMs;

    let clearedCount = 0;

    for (const [id, operation] of this.operations.entries()) {
      if (
        (operation.status === "Completed" || operation.status === "Failed") &&
        operation.updatedAt < cutoffTime
      ) {
        this.operations.delete(id);
        clearedCount++;
      }
    }

    if (clearedCount > 0) {
      this.logger.debug(`Cleared ${clearedCount} old rebalance operations`);
    }
  }

  /**
   * Check if there's a similar pending operation
   * @returns true if a similar operation exists
   */
  public hasSimilarPendingOperation(
    sourceChainId: SupportedChainId,
    destinationChainId: SupportedChainId,
    token: string
  ): boolean {
    return Array.from(this.operations.values()).some(
      (op) =>
        op.status === "Pending" &&
        op.sourceChainId === sourceChainId &&
        op.destinationChainId === destinationChainId &&
        op.token === token
    );
  }

  /**
   * Cancel an operation by ID
   */
  public cancelOperation(
    id: string,
    reason: string
  ): RebalanceOperation | null {
    const operation = this.operations.get(id);

    if (!operation) {
      this.logger.warn(`Attempted to cancel non-existent operation ${id}`);
      return null;
    }

    // Only pending operations can be cancelled
    if (operation.status !== "Pending") {
      this.logger.warn(
        `Cannot cancel operation ${id} with status ${operation.status}`
      );
      return null;
    }

    const updatedOperation = {
      ...operation,
      status: "Cancelled" as RebalanceStatus,
      error: reason,
      updatedAt: Date.now(),
      completedAt: Date.now(), // Mark as completed when cancelled
    };

    this.operations.set(id, updatedOperation);
    this.logger.info(`Cancelled rebalance operation ${id}: ${reason}`);

    return updatedOperation;
  }

  /**
   * Get operations that have been pending for too long
   * @param maxAgeMs Maximum age in milliseconds for a pending operation
   */
  public getStaleOperations(
    maxAgeMs = 24 * 60 * 60 * 1000
  ): RebalanceOperation[] {
    const now = Date.now();
    const cutoffTime = now - maxAgeMs;

    return Array.from(this.operations.values()).filter(
      (op) => op.status === "Pending" && op.createdAt < cutoffTime
    );
  }
}

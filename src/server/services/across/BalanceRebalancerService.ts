import { EventEmitter } from "node:events";
import type { Address, PublicClient, WalletClient } from "viem";
import type { SupportedChainId } from "../../config/constants.js";
import type { AggregateBalance } from "../../types/balance.js";
import type {
  RebalanceConfig,
  RebalanceOperation,
} from "../../types/rebalance.js";
import { Logger } from "../../utils/logger.js";
import type { AggregateBalanceService } from "../balance/AggregateBalanceService.js";
import { BalanceAnalyzer } from "./BalanceAnalyzer.js";
import { RebalanceOperationStore } from "./RebalanceOperationStore.js";
import type { RebalanceService } from "./RebalanceService.js";

/**
 * Service for automatically rebalancing funds across chains based on configured thresholds
 */
export class BalanceRebalancerService extends EventEmitter {
  private readonly logger: Logger;
  private readonly rebalanceService: RebalanceService;
  private readonly operationStore: RebalanceOperationStore;
  private readonly aggregateBalanceService: AggregateBalanceService;
  private readonly balanceAnalyzer: BalanceAnalyzer;
  private config: RebalanceConfig;
  private updateInterval: NodeJS.Timeout | null = null;
  private readonly UPDATE_INTERVAL = 30000; // 30 seconds
  private readonly MAX_OPERATION_AGE = 7 * 24 * 60 * 60 * 1000; // 7 days
  private running = false;

  constructor(
    accountAddress: Address,
    publicClients: Record<SupportedChainId, PublicClient>,
    walletClients: Record<SupportedChainId, WalletClient>,
    rebalanceService: RebalanceService,
    aggregateBalanceService: AggregateBalanceService,
    config: RebalanceConfig
  ) {
    super();
    this.logger = new Logger("BalanceRebalancerService");
    this.rebalanceService = rebalanceService;
    this.aggregateBalanceService = aggregateBalanceService;
    this.operationStore = new RebalanceOperationStore();
    this.config = config;

    // Create the balance analyzer
    this.balanceAnalyzer = new BalanceAnalyzer(
      rebalanceService,
      this.operationStore,
      config
    );

    // Listen for balance updates
    this.aggregateBalanceService.on(
      "aggregate_balance_update",
      this.onBalanceUpdate.bind(this)
    );
  }

  /**
   * Check if the service is currently running
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Start the rebalancing service
   */
  public start(): void {
    if (this.updateInterval) {
      this.logger.warn("BalanceRebalancerService already running");
      return;
    }

    this.logger.info("Starting BalanceRebalancerService");
    this.running = true;

    // Cancel any stale operations first
    this.cancelStaleOperations();

    // Process any pending operations immediately
    void this.processOperations();

    // Then process every 30 seconds
    this.updateInterval = setInterval(() => {
      // Check for and cancel stale operations
      this.cancelStaleOperations();

      // Process pending operations
      void this.processOperations();
    }, this.UPDATE_INTERVAL);

    this.logger.info("Balance rebalancer service started");
  }

  /**
   * Stop the rebalancing service
   */
  public stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
      this.running = false;
      this.logger.info("Balance rebalancer service stopped");
    }
  }

  /**
   * Update the rebalance configuration
   */
  public updateConfig(config: RebalanceConfig): void {
    this.config = config;
    this.balanceAnalyzer.updateConfig(config);
    this.logger.info("Updated rebalance configuration");
  }

  /**
   * Get the current rebalance configuration
   */
  public getConfig(): RebalanceConfig {
    return this.config;
  }

  /**
   * Get all rebalance operations
   */
  public getOperations(): RebalanceOperation[] {
    return this.operationStore.getAllOperations();
  }

  /**
   * Handle balance updates from the AggregateBalanceService
   */
  private onBalanceUpdate(balances: AggregateBalance): void {
    if (!this.config.global.enabled) {
      return;
    }

    // Only check for rebalancing needs if no operation is currently in progress
    if (!this.operationStore.isProcessingLocked()) {
      void this.balanceAnalyzer.checkRebalanceNeeded(balances);
    }
  }

  /**
   * Process pending rebalance operations
   */
  private async processOperations(): Promise<void> {
    try {
      // Clear old operations
      this.operationStore.clearOldOperations(this.MAX_OPERATION_AGE);

      // Skip if global rebalancing is disabled
      if (!this.config.global.enabled) {
        return;
      }

      // Skip if already processing
      if (this.operationStore.isProcessingLocked()) {
        return;
      }

      // Get the next pending operation
      const operation = this.operationStore.getNextPendingOperation();
      if (!operation) {
        return;
      }

      // Try to acquire the processing lock
      if (!this.operationStore.tryAcquireProcessingLock()) {
        return;
      }

      try {
        // Check if the operation is still valid (e.g., chain configs might have changed)
        if (!this.isOperationValid(operation)) {
          this.operationStore.cancelOperation(
            operation.id,
            "Operation is no longer valid due to configuration changes"
          );
          this.operationStore.releaseProcessingLock();
          return;
        }

        // Update operation status
        this.operationStore.updateOperation(operation.id, {
          status: "Processing",
        });

        this.logger.info(
          `Processing rebalance operation ${operation.id}`,
          operation
        );

        // Execute the rebalance
        const txHash = await this.rebalanceService.rebalanceToken(
          operation.sourceChainId,
          operation.destinationChainId,
          operation.token,
          operation.amount
        );

        // Update operation with transaction hash
        this.operationStore.updateOperation(operation.id, {
          status: "Completed",
          txHash,
          completedAt: Date.now(),
        });

        // Update last rebalance time
        this.operationStore.updateLastRebalanceTime();

        this.logger.info(`Completed rebalance operation ${operation.id}`, {
          operationId: operation.id,
          txHash,
        });

        // Emit event for the completed operation
        this.emit("rebalance_operation_completed", {
          ...operation,
          status: "Completed",
          txHash,
          completedAt: Date.now(),
        });
      } catch (error) {
        this.logger.error(
          `Failed to process rebalance operation ${operation.id}:`,
          error
        );

        // Update operation as failed
        this.operationStore.updateOperation(operation.id, {
          status: "Failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });

        // Emit event for the failed operation
        this.emit("rebalance_operation_failed", {
          ...operation,
          status: "Failed",
          error: error instanceof Error ? error.message : String(error),
          completedAt: Date.now(),
        });

        // Add failed attempt to tracking list
        const currentBalances =
          this.aggregateBalanceService.getAggregateBalances();
        if (currentBalances) {
          const failureTracker = this.balanceAnalyzer.getFailureTracker();
          failureTracker.addFailedAttempt(
            operation.sourceChainId,
            operation.destinationChainId,
            operation.token,
            operation.amount,
            error instanceof Error ? error.message : String(error),
            currentBalances
          );
        } else {
          this.logger.warn(
            "Could not track failed attempt: no aggregate balances available"
          );
        }
      } finally {
        // Release the processing lock
        this.operationStore.releaseProcessingLock();
      }
    } catch (error) {
      this.logger.error("Error processing rebalance operations:", error);
      this.operationStore.releaseProcessingLock();
    }
  }

  /**
   * Check if an operation is still valid
   */
  private isOperationValid(operation: RebalanceOperation): boolean {
    // Check if source chain is still configured
    const sourceChainConfig = this.config.chains[operation.sourceChainId];
    if (!sourceChainConfig) {
      this.logger.info(
        `Operation ${operation.id} is invalid: source chain ${operation.sourceChainId} is no longer configured`
      );
      return false;
    }

    // Check if destination chain is still enabled for rebalancing
    const destChainConfig = this.config.chains[operation.destinationChainId];
    if (!destChainConfig || !destChainConfig.canBeDestination) {
      this.logger.info(
        `Operation ${operation.id} is invalid: destination chain ${operation.destinationChainId} is no longer a valid destination`
      );
      return false;
    }

    // Check if the operation is too old
    const maxOperationAge = 24 * 60 * 60 * 1000; // 24 hours
    if (Date.now() - operation.createdAt > maxOperationAge) {
      this.logger.info(
        `Operation ${operation.id} is invalid: operation is too old (created at ${new Date(operation.createdAt).toISOString()})`
      );
      return false;
    }

    return true;
  }

  /**
   * Cancel stale operations
   */
  public cancelStaleOperations(): void {
    const staleOperations = this.operationStore.getStaleOperations();

    if (staleOperations.length === 0) {
      return;
    }

    this.logger.info(
      `Found ${staleOperations.length} stale operations to cancel`
    );

    for (const operation of staleOperations) {
      this.operationStore.cancelOperation(
        operation.id,
        "Operation is stale and has been cancelled"
      );
    }
  }
}

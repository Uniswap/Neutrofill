// Message type definitions
export interface ConnectionUpdate {
  type: "connected";
  data: {
    clientCount: number;
  };
  timestamp: string;
}

export interface AccountUpdate {
  type: "account_update";
  account: string;
  chainId: number;
  balances: Record<string, string>;
}

export interface PriceUpdate {
  type: "price_update";
  chainId: number;
  price: string;
}

export interface TokenBalancesUpdate {
  type: "token_balances";
  chainId: number;
  balances: Record<string, string>;
}

export interface AggregateBalanceUpdate {
  type: "aggregate_balance_update";
  chainBalances: Record<
    number,
    {
      ETH: number;
      WETH: number;
      USDC: number;
      total: number;
      percentageOfTotal: number;
    }
  >;
  tokenBalances: {
    ETH: number;
    WETH: number;
    USDC: number;
  };
  totalBalance: number;
  lastUpdated: number;
  timestamp: string;
}

export interface FillRequestUpdate {
  type: "fill_request_update";
  request: string;
  willFill: boolean;
  reason?: string;
}

export interface PingMessage {
  type: "ping";
  timestamp: number;
}

export interface PongMessage {
  type: "pong";
  timestamp: number;
}

export type WebSocketMessage =
  | ConnectionUpdate
  | AccountUpdate
  | PriceUpdate
  | TokenBalancesUpdate
  | AggregateBalanceUpdate
  | FillRequestUpdate
  | PingMessage
  | PongMessage;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second delay
  private pingInterval: NodeJS.Timeout | null = null;
  private pongTimeout: NodeJS.Timeout | null = null;
  private wsUrl: string;
  private lastPingTime = 0;

  // Event handlers
  public onOpen?: () => void;
  public onClose?: () => void;
  public onAccountUpdate?: (account: string) => void;
  public onTokenBalances?: (
    chainId: number,
    balances: Record<string, string>
  ) => void;
  public onEthPrice?: (chainId: number, price: string) => void;
  public onAggregateBalances?: (aggregateBalances: {
    chainBalances: Record<
      number,
      {
        ETH: number;
        WETH: number;
        USDC: number;
        total: number;
        percentageOfTotal: number;
      }
    >;
    tokenBalances: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
    totalBalance: number;
    lastUpdated: number;
    timestamp: string;
  }) => void;
  public onFillRequest?: (
    request: string,
    willFill: boolean,
    reason?: string
  ) => void;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.connect(wsUrl);
  }

  private connect(wsUrl: string): void {
    try {
      this.ws = new WebSocket(wsUrl);
      this.setupEventListeners();
    } catch (error) {
      console.error("Failed to create WebSocket connection:", error);
      this.handleReconnect();
    }
  }

  private setupEventListeners(): void {
    if (!this.ws) return;

    this.ws.onopen = (): void => {
      console.info("WebSocket connection established");
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.setupPingInterval();
      this.onOpen?.();
    };

    this.ws.onclose = (): void => {
      console.info("WebSocket connection closed");
      this.cleanupPingInterval();
      this.onClose?.();
      this.handleReconnect(); // Always try to reconnect on close
    };

    this.ws.onerror = (): void => {
      console.error("WebSocket error occurred");
      this.cleanupPingInterval();
    };

    this.ws.onmessage = (event: MessageEvent): void => {
      try {
        const data = JSON.parse(event.data) as WebSocketMessage;
        this.handleMessage(data);
      } catch (error) {
        console.error("Error parsing message:", error);
      }
    };
  }

  private handleReconnect(): void {
    this.cleanupPingInterval();
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      console.info(
        `Attempting to reconnect... (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`
      );
      setTimeout(() => {
        this.reconnectAttempts++;
        this.reconnectDelay *= 2; // Exponential backoff
        this.connect(this.wsUrl);
      }, this.reconnectDelay);
    } else {
      console.error("Max reconnection attempts reached");
    }
  }

  private setupPingInterval(): void {
    // Send a ping every 15 seconds
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.lastPingTime = Date.now();
        this.ws.send(
          JSON.stringify({ type: "ping", timestamp: this.lastPingTime })
        );

        // Set a timeout to close and reconnect if we don't receive a pong within 5 seconds
        this.pongTimeout = setTimeout(() => {
          console.warn(
            "No pong received within timeout, closing connection..."
          );
          if (this.ws) {
            this.ws.close();
          }
        }, 5000);
      }
    }, 15000);
  }

  private cleanupPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private handleMessage(data: WebSocketMessage): void {
    switch (data.type) {
      case "connected":
        console.log("Connected to the server");
        console.log(`Client count: ${data.data.clientCount}`);
        console.log(`Timestamp: ${data.timestamp}`);
        break;
      case "account_update":
        this.onAccountUpdate?.(data.account);
        break;
      case "price_update":
        this.onEthPrice?.(data.chainId, data.price);
        break;
      case "token_balances":
        this.onTokenBalances?.(data.chainId, data.balances);
        break;
      case "aggregate_balance_update":
        this.onAggregateBalances?.(data);
        break;
      case "fill_request_update":
        this.onFillRequest?.(data.request, data.willFill, data.reason);
        break;
      case "ping":
        // Respond to server pings with a pong
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(
            JSON.stringify({ type: "pong", timestamp: data.timestamp })
          );
        }
        break;
      case "pong": {
        // Clear the pong timeout since we received a response
        if (this.pongTimeout) {
          clearTimeout(this.pongTimeout);
          this.pongTimeout = null;
        }
        const latency = Date.now() - data.timestamp;
        console.debug(`WebSocket latency: ${latency}ms`);
        break;
      }
      default:
        console.error("Unknown message type:", data);
    }
  }
}

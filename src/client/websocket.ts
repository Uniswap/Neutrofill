// Message type definitions
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

export interface FillRequestUpdate {
  type: "fill_request_update";
  request: string;
  willFill: boolean;
  reason?: string;
}

export type WebSocketMessage = AccountUpdate | PriceUpdate | FillRequestUpdate;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000; // Start with 1 second delay

  // Event handlers
  public onOpen?: () => void;
  public onClose?: () => void;
  public onAccountUpdate?: (account: string) => void;
  public onTokenBalances?: (
    chainId: number,
    balances: Record<string, string>
  ) => void;
  public onEthPrice?: (chainId: number, price: string) => void;
  public onFillRequest?: (
    request: string,
    willFill: boolean,
    reason?: string
  ) => void;

  constructor(wsUrl: string) {
    this.connect(wsUrl);
  }

  private connect(wsUrl: string): void {
    try {
      this.ws = new WebSocket(wsUrl);
      this.setupEventListeners();
    } catch (error) {
      console.error("Failed to create WebSocket connection:", error);
      this.handleReconnect(wsUrl);
    }
  }

  private setupEventListeners(): void {
    if (!this.ws) return;

    this.ws.onopen = (): void => {
      console.info("WebSocket connection established");
      this.reconnectAttempts = 0;
      this.reconnectDelay = 1000;
      this.onOpen?.();
    };

    this.ws.onclose = (): void => {
      console.info("WebSocket connection closed");
      this.onClose?.();
    };

    this.ws.onerror = (): void => {
      console.error("WebSocket error occurred");
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

  private handleReconnect(wsUrl: string): void {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      console.info(
        `Attempting to reconnect... (${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})`
      );
      setTimeout(() => {
        this.reconnectAttempts++;
        this.reconnectDelay *= 2; // Exponential backoff
        this.connect(wsUrl);
      }, this.reconnectDelay);
    } else {
      console.error("Max reconnection attempts reached");
    }
  }

  private handleMessage(data: WebSocketMessage): void {
    switch (data.type) {
      case "account_update":
        this.onAccountUpdate?.(data.account);
        break;
      case "price_update":
        this.onEthPrice?.(data.chainId, data.price);
        break;
      case "fill_request_update":
        this.onFillRequest?.(data.request, data.willFill, data.reason);
        break;
      default:
        console.error("Unknown message type:", data);
    }
  }
}

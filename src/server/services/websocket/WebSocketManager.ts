import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { Logger } from "../../utils/logger.js";

interface WebSocketMessage {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

interface PingMessage {
  type: "ping";
  timestamp: number;
}

interface PongMessage {
  type: "pong";
  timestamp: number;
}

export class WebSocketManager {
  private clients: Set<WebSocket> = new Set();
  private readonly logger: Logger;
  private readonly wss: WebSocketServer;

  constructor(server: Server) {
    this.logger = new Logger("WebSocketManager");
    this.wss = new WebSocketServer({ server, path: "/ws" });
    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
      const timestamp = new Date().toISOString();
      this.logger.info(
        `New WebSocket connection from: ${req.socket.remoteAddress}`
      );

      // Set up connection monitoring
      const pingInterval = setInterval(() => {
        if (!(ws as WebSocket & { isAlive?: boolean }).isAlive) {
          this.logger.debug("Terminating inactive connection");
          clearInterval(pingInterval);
          return ws.terminate();
        }
        (ws as WebSocket & { isAlive?: boolean }).isAlive = false;
        ws.ping();
      }, 30000);

      // Handle application-level ping/pong messages
      ws.on("message", (data: Buffer) => {
        try {
          const message = JSON.parse(data.toString());
          if (message.type === "ping") {
            // Respond to client pings with pongs
            ws.send(
              JSON.stringify({
                type: "pong",
                timestamp: message.timestamp,
              })
            );
          }
        } catch (error) {
          this.logger.error("Error parsing message:", error);
        }
      });

      // Handle built-in WebSocket pong frames
      ws.on("pong", () => {
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      });

      this.addClient(ws);

      // Clean up on server shutdown
      this.wss.on("close", () => {
        clearInterval(pingInterval);
      });

      ws.on("error", (error: Error) => {
        this.logger.error("WebSocket error:", error);
        this.removeClient(ws);
      });

      ws.on("close", () => {
        this.logger.debug("Client disconnected");
        this.removeClient(ws);
        clearInterval(pingInterval);
      });

      // Send connection confirmation
      this.sendToClient(ws, {
        type: "connected",
        data: { clientCount: this.clients.size },
        timestamp,
      });
    });
  }

  public addClient(client: WebSocket): void {
    this.clients.add(client);
  }

  public removeClient(client: WebSocket): void {
    this.clients.delete(client);
  }

  public broadcastAccountUpdate(account: string): void {
    const timestamp = new Date().toISOString();
    this.broadcast("account_update", { account, timestamp });
  }

  public broadcastTokenBalances(
    chainId: number,
    account: string,
    balances: Record<string, string>
  ): void {
    const timestamp = new Date().toISOString();
    this.broadcast("account_update", { chainId, account, balances, timestamp });
  }

  public broadcastEthPrice(chainId: number, price: string): void {
    const timestamp = new Date().toISOString();
    this.broadcast("price_update", { chainId, price, timestamp });
  }

  public broadcastFillRequest(
    request: string,
    willFill: boolean,
    reason?: string
  ): void {
    const timestamp = new Date().toISOString();
    this.broadcast("fill_request_update", {
      request,
      willFill,
      reason,
      timestamp,
    });
  }

  public broadcastAggregateBalances(
    aggregateBalances: Record<string, unknown>
  ): void {
    const timestamp = new Date().toISOString();
    this.broadcast("aggregate_balance_update", {
      ...aggregateBalances,
      timestamp,
    });
  }

  private broadcast(type: string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ type, ...data });
    for (const client of this.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  }

  private sendToClient(client: WebSocket, message: WebSocketMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }

  public getClientCount(): number {
    return this.clients.size;
  }
}

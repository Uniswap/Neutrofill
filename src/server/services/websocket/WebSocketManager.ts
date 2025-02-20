import { WebSocket, WebSocketServer } from 'ws';
import { Logger } from '../../utils/logger';
import { Server, IncomingMessage } from 'http';

interface WebSocketMessage {
  type: string;
  data: Record<string, unknown>;
  timestamp: string;
}

export class WebSocketManager {
  private clients: Set<WebSocket> = new Set();
  private readonly logger: Logger;
  private readonly wss: WebSocketServer;

  constructor(server: Server) {
    this.logger = new Logger('WebSocketManager');
    this.wss = new WebSocketServer({ server, path: '/ws' });
    this.setupWebSocketServer();
  }

  private setupWebSocketServer(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const timestamp = new Date().toISOString();
      this.logger.info(`New WebSocket connection from: ${req.socket.remoteAddress}`);

      // Set up connection monitoring
      const pingInterval = setInterval(() => {
        if (!(ws as WebSocket & { isAlive?: boolean }).isAlive) {
          this.logger.info('Terminating inactive connection');
          clearInterval(pingInterval);
          return ws.terminate();
        }
        (ws as WebSocket & { isAlive?: boolean }).isAlive = false;
        ws.ping();
      }, 30000);

      ws.on('pong', () => {
        (ws as WebSocket & { isAlive?: boolean }).isAlive = true;
      });

      this.addClient(ws);

      // Clean up on server shutdown
      this.wss.on('close', () => {
        clearInterval(pingInterval);
      });

      ws.on('error', (error: Error) => {
        this.logger.error('WebSocket error:', error);
        this.removeClient(ws);
      });

      ws.on('close', () => {
        this.logger.info('Client disconnected');
        this.removeClient(ws);
        clearInterval(pingInterval);
      });

      // Send connection confirmation
      this.sendToClient(ws, {
        type: 'connected',
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
    this.broadcast('account', { account });
  }

  public broadcastTokenBalances(chainId: number, balances: Record<string, string>): void {
    this.broadcast('token_balances', { chainId, balances });
  }

  public broadcastEthPrice(chainId: number, price: string): void {
    this.broadcast('eth_price', { chainId, price });
  }

  public broadcastFillRequest(request: string, willFill: boolean, reason?: string): void {
    this.broadcast('fill_request', { request, willFill, reason });
  }

  private broadcast(type: string, data: Record<string, unknown>): void {
    const message: WebSocketMessage = {
      type,
      data,
      timestamp: new Date().toISOString(),
    };

    const messageStr = JSON.stringify(message);
    this.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(messageStr);
      }
    });
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

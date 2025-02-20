import React, { useEffect, useState } from 'react';
import { WebSocketClient } from './websocket';

interface FillRequest {
  request: unknown;
  willFill: boolean;
  reason?: string;
  timestamp: string;
}

interface TokenBalances {
  [chainId: number]: {
    balances: Record<string, string>;
    timestamp: string;
  };
}

interface EthPrices {
  [chainId: number]: {
    price: string;
    timestamp: string;
  };
}

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export function App() {
  const [serverAccount, setServerAccount] = useState<string | null>(null);
  const [tokenBalances, setTokenBalances] = useState<TokenBalances>({});
  const [ethPrices, setEthPrices] = useState<EthPrices>({});
  const [fillRequests, setFillRequests] = useState<FillRequest[]>([]);
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    const ws = new WebSocketClient('ws://localhost:3000');

    ws.onOpen = () => setWsStatus('connected');
    ws.onClose = () => setWsStatus('disconnected');

    ws.onAccountUpdate = (account: string) => {
      setServerAccount(account);
    };

    ws.onTokenBalances = (chainId: number, balances: Record<string, string>) => {
      setTokenBalances(prev => ({
        ...prev,
        [chainId]: {
          balances,
          timestamp: new Date().toISOString(),
        },
      }));
    };

    ws.onEthPrice = (chainId: number, price: string) => {
      setEthPrices(prev => ({
        ...prev,
        [chainId]: {
          price,
          timestamp: new Date().toISOString(),
        },
      }));
    };

    ws.onFillRequest = (request: unknown, willFill: boolean, reason?: string) => {
      setFillRequests(prev =>
        [
          {
            request,
            willFill,
            reason,
            timestamp: new Date().toISOString(),
          },
          ...prev,
        ].slice(0, 10)
      ); // Keep last 10 requests
    };

    return () => {
      // WebSocket cleanup will happen automatically
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-100 p-4">
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Connection Status */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-2">Connection Status</h2>
          <div className="flex items-center space-x-2">
            <div
              className={`w-3 h-3 rounded-full ${
                wsStatus === 'connected'
                  ? 'bg-green-500'
                  : wsStatus === 'connecting'
                    ? 'bg-yellow-500'
                    : 'bg-red-500'
              }`}
            />
            <span className="capitalize">{wsStatus}</span>
          </div>
        </div>

        {/* Server Account */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-2">Server Account</h2>
          <div className="font-mono break-all">{serverAccount || 'Waiting for account...'}</div>
        </div>

        {/* ETH Prices */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-2">ETH Prices</h2>
          {Object.entries(ethPrices).length === 0 ? (
            <p className="text-gray-500">No price data yet</p>
          ) : (
            <div className="space-y-2">
              {Object.entries(ethPrices).map(([chainId, { price, timestamp }]) => (
                <div key={chainId} className="flex justify-between items-center">
                  <span>Chain {chainId}:</span>
                  <span className="font-mono">${parseFloat(price).toFixed(2)}</span>
                  <span className="text-sm text-gray-500">
                    {new Date(timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Token Balances */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-2">Token Balances</h2>
          {Object.entries(tokenBalances).length === 0 ? (
            <p className="text-gray-500">No balance data yet</p>
          ) : (
            <div className="space-y-4">
              {Object.entries(tokenBalances).map(([chainId, { balances, timestamp }]) => (
                <div key={chainId}>
                  <h3 className="font-medium">Chain {chainId}</h3>
                  <div className="space-y-1 mt-2">
                    {Object.entries(balances).map(([token, balance]) => (
                      <div key={token} className="flex justify-between">
                        <span className="font-mono">{token}</span>
                        <span className="font-mono">{String(balance)}</span>
                      </div>
                    ))}
                  </div>
                  <div className="text-sm text-gray-500 mt-1">
                    Updated: {new Date(timestamp).toLocaleTimeString()}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Fill Requests */}
        <div className="bg-white rounded-lg shadow p-4">
          <h2 className="text-lg font-semibold mb-2">Recent Fill Requests</h2>
          {fillRequests.length === 0 ? (
            <p className="text-gray-500">No fill requests yet</p>
          ) : (
            <div className="space-y-4">
              {fillRequests.map((request, index) => (
                <div key={index} className="border-l-4 border-blue-500 pl-4">
                  <div className="flex justify-between items-start">
                    <div className="space-y-1">
                      <div className="font-medium">
                        Will Fill:{' '}
                        <span className={request.willFill ? 'text-green-600' : 'text-red-600'}>
                          {request.willFill ? 'Yes' : 'No'}
                        </span>
                      </div>
                      {request.reason && (
                        <div className="text-sm text-gray-600">Reason: {request.reason}</div>
                      )}
                      <div className="text-sm text-gray-500">
                        {new Date(request.timestamp).toLocaleTimeString()}
                      </div>
                    </div>
                    <div className="font-mono text-sm max-w-[50%] break-all">
                      {JSON.stringify(request.request)}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

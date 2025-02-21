import React, { useEffect, useState } from "react";
import { WebSocketClient } from "./websocket";
import { formatEthBalance, formatUsdcBalance } from "./utils";

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

type ConnectionStatus = "connecting" | "connected" | "disconnected";

export function App() {
  const [serverAccount, setServerAccount] = useState<string | null>(null);
  const [tokenBalances, setTokenBalances] = useState<TokenBalances>({});
  const [ethPrices, setEthPrices] = useState<EthPrices>({});
  const [fillRequests, setFillRequests] = useState<FillRequest[]>([]);
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    const ws = new WebSocketClient("ws://localhost:3000/ws");

    ws.onOpen = () => setWsStatus("connected");
    ws.onClose = () => setWsStatus("disconnected");

    ws.onAccountUpdate = (account: string) => {
      setServerAccount(account);
    };

    ws.onTokenBalances = (
      chainId: number,
      balances: Record<string, string>
    ) => {
      setTokenBalances((prev) => ({
        ...prev,
        [chainId]: {
          balances,
          timestamp: new Date().toISOString(),
        },
      }));
    };

    ws.onEthPrice = (chainId: number, price: string) => {
      setEthPrices((prev) => ({
        ...prev,
        [chainId]: {
          price,
          timestamp: new Date().toISOString(),
        },
      }));
    };

    ws.onFillRequest = (
      request: unknown,
      willFill: boolean,
      reason?: string
    ) => {
      setFillRequests((prev) =>
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

  const chainNames: Record<number, string> = {
    1: "Ethereum",
    10: "Optimism",
    130: "Unichain",
    8453: "Base",
  };

  const orderedChainIds = [1, 10, 130, 8453];

  return (
    <div className="min-h-screen bg-background text-gray-200">
      <header className="border-b border-gray-800 bg-background/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-7xl mx-auto px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold bg-gradient-to-r from-blue-400 via-blue-500 to-purple-600 bg-clip-text text-transparent">
              Neutrofill
            </h1>
            <div className="flex items-center space-x-3">
              <div className="flex items-center space-x-2 px-3 py-1.5 rounded-full bg-gray-800/50">
                <div
                  className={`h-2 w-2 rounded-full ${
                    wsStatus === "connected"
                      ? "bg-green-400"
                      : wsStatus === "connecting"
                        ? "bg-yellow-400"
                        : "bg-red-400"
                  }`}
                />
                <span className="text-sm text-gray-400 capitalize">
                  {wsStatus}
                </span>
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-8 sm:px-6 lg:px-8">
        <div className="space-y-6">
          {/* Server Account */}
          <div className="glass-panel">
            <div className="px-6 py-5">
              <h2 className="text-lg font-medium text-gray-200">
                Server Account
              </h2>
              <div className="mt-4 font-mono text-sm text-gray-300 break-all">
                {serverAccount || "Waiting for account..."}
              </div>
            </div>
          </div>

          {/* ETH Prices and Token Balances */}
          <div className="glass-panel">
            <div className="px-6 py-5">
              <h2 className="text-lg font-medium text-gray-200 mb-4">
                Prices & Balances
              </h2>
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="text-left border-b border-gray-800">
                      <th className="py-2 font-medium text-gray-400">Chain</th>
                      {orderedChainIds.map((chainId) => (
                        <th
                          key={chainId}
                          className="py-2 font-medium text-gray-200"
                        >
                          {chainNames[chainId]}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-800">
                    <tr>
                      <td className="py-3 font-medium text-gray-400">
                        ETH Price
                      </td>
                      {orderedChainIds.map((chainId) => (
                        <td key={chainId} className="py-3">
                          <span className="font-mono text-gray-200">
                            {ethPrices[chainId]?.price
                              ? `$${Number.parseFloat(ethPrices[chainId].price).toFixed(2)}`
                              : "-"}
                          </span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 font-medium text-gray-400">
                        ETH Balance
                      </td>
                      {orderedChainIds.map((chainId) => (
                        <td key={chainId} className="py-3">
                          <span className="font-mono text-gray-200">
                            {formatEthBalance(
                              tokenBalances[chainId]?.balances?.ETH ?? "-"
                            )}
                          </span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 font-medium text-gray-400">
                        WETH Balance
                      </td>
                      {orderedChainIds.map((chainId) => (
                        <td key={chainId} className="py-3">
                          <span className="font-mono text-gray-200">
                            {formatEthBalance(
                              tokenBalances[chainId]?.balances?.WETH ?? "-"
                            )}
                          </span>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="py-3 font-medium text-gray-400">
                        USDC Balance
                      </td>
                      {orderedChainIds.map((chainId) => (
                        <td key={chainId} className="py-3">
                          <span className="font-mono text-gray-200">
                            {formatUsdcBalance(
                              tokenBalances[chainId]?.balances?.USDC ?? "-"
                            )}
                          </span>
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Fill Requests */}
          <div className="glass-panel">
            <div className="px-6 py-5">
              <h2 className="text-lg font-medium text-gray-200">
                Recent Fill Requests
              </h2>
              <div className="mt-4">
                {fillRequests.length === 0 ? (
                  <p className="text-gray-500">No fill requests yet</p>
                ) : (
                  <div className="space-y-4">
                    {fillRequests.map((request, index) => (
                      <div
                        key={index}
                        className="rounded-lg bg-gray-800/50 p-4"
                      >
                        <div className="flex items-center justify-between mb-2">
                          <span
                            className={`text-sm font-medium ${
                              request.willFill
                                ? "text-green-400"
                                : "text-red-400"
                            }`}
                          >
                            {request.willFill ? "Will Fill" : "Won't Fill"}
                          </span>
                          <span className="text-xs text-gray-500">
                            {new Date(request.timestamp).toLocaleTimeString()}
                          </span>
                        </div>
                        {request.reason && (
                          <p className="text-sm text-gray-400 mt-1">
                            {request.reason}
                          </p>
                        )}
                        <pre className="mt-3 text-xs font-mono bg-gray-900/50 p-3 rounded overflow-x-auto">
                          {JSON.stringify(request.request, null, 2)}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

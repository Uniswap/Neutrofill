import React, { useEffect, useState } from "react";
import { WebSocketClient } from "./websocket";
import {
  formatEthBalance,
  formatUsdcBalance,
  formatTokenAmount,
} from "./utils";

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

// Define the type expected by WebSocketClient.onAggregateBalances
interface WebSocketAggregateBalances {
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

// Define the structure of the data received from the WebSocket
interface WebSocketData {
  type: string;
  chainBalances: Record<
    string,
    {
      tokens: {
        ETH: string | number;
        WETH: string | number;
        USDC: string | number;
      };
      usd: {
        ETH: number;
        WETH: number;
        USDC: number;
        total: number;
      };
      percentageOfTotal: number;
    }
  >;
  tokenBalances: {
    tokens: {
      ETH: string | number;
      WETH: string | number;
      USDC: string | number;
    };
    usd: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
    percentages: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
  };
  totalBalance: number;
  lastUpdated: number;
  timestamp: string;
}

interface AggregateBalances {
  chainBalances: Record<
    number,
    {
      tokens: {
        ETH: string;
        WETH: string;
        USDC: string;
      };
      usd: {
        ETH: number;
        WETH: number;
        USDC: number;
        total: number;
      };
      percentageOfTotal: number;
    }
  >;
  tokenBalances: {
    tokens: {
      ETH: string;
      WETH: string;
      USDC: string;
    };
    usd: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
    percentages: {
      ETH: number;
      WETH: number;
      USDC: number;
    };
  };
  totalBalance: number;
  lastUpdated: number;
  timestamp: string;
}

type ConnectionStatus = "connecting" | "connected" | "disconnected";

export function App() {
  const [serverAccount, setServerAccount] = useState<string | null>(null);
  const [tokenBalances, setTokenBalances] = useState<TokenBalances>({});
  const [ethPrices, setEthPrices] = useState<EthPrices>({});
  const [aggregateBalances, setAggregateBalances] =
    useState<AggregateBalances | null>(null);
  const [fillRequests, setFillRequests] = useState<FillRequest[]>([]);
  const [wsStatus, setWsStatus] = useState<ConnectionStatus>("connecting");

  useEffect(() => {
    // Determine WebSocket URL based on the current environment
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsHost =
      window.location.hostname === "localhost"
        ? "localhost:3000"
        : window.location.host;
    const wsUrl = `${wsProtocol}//${wsHost}/ws`;

    const ws = new WebSocketClient(wsUrl);

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

    ws.onAggregateBalances = (data: unknown) => {
      try {
        // Cast to WebSocketData for transformation
        const rawData = data as WebSocketData;

        if (rawData && rawData.type === "aggregate_balance_update") {
          // Transform the data to match our AggregateBalances interface
          const transformedChainBalances: Record<
            number,
            {
              tokens: {
                ETH: string;
                WETH: string;
                USDC: string;
              };
              usd: {
                ETH: number;
                WETH: number;
                USDC: number;
                total: number;
              };
              percentageOfTotal: number;
            }
          > = {};

          // Transform chain balances
          for (const [chainId, values] of Object.entries(
            rawData.chainBalances || {}
          )) {
            if (!values) continue;

            transformedChainBalances[Number(chainId)] = {
              tokens: {
                ETH: String(values.tokens?.ETH || "0"),
                WETH: String(values.tokens?.WETH || "0"),
                USDC: String(values.tokens?.USDC || "0"),
              },
              usd: {
                ETH: Number(values.usd?.ETH || 0),
                WETH: Number(values.usd?.WETH || 0),
                USDC: Number(values.usd?.USDC || 0),
                total: Number(values.usd?.total || 0),
              },
              percentageOfTotal: Number(values.percentageOfTotal || 0),
            };
          }

          const transformedData: AggregateBalances = {
            chainBalances: transformedChainBalances,
            tokenBalances: {
              tokens: {
                ETH: String(rawData.tokenBalances?.tokens?.ETH || "0"),
                WETH: String(rawData.tokenBalances?.tokens?.WETH || "0"),
                USDC: String(rawData.tokenBalances?.tokens?.USDC || "0"),
              },
              usd: {
                ETH: Number(rawData.tokenBalances?.usd?.ETH || 0),
                WETH: Number(rawData.tokenBalances?.usd?.WETH || 0),
                USDC: Number(rawData.tokenBalances?.usd?.USDC || 0),
              },
              percentages: {
                ETH: Number(rawData.tokenBalances?.percentages?.ETH || 0),
                WETH: Number(rawData.tokenBalances?.percentages?.WETH || 0),
                USDC: Number(rawData.tokenBalances?.percentages?.USDC || 0),
              },
            },
            totalBalance: Number(rawData.totalBalance || 0),
            lastUpdated: Number(rawData.lastUpdated || Date.now()),
            timestamp: String(rawData.timestamp || new Date().toISOString()),
          };

          setAggregateBalances(transformedData);
        }
      } catch (error) {
        console.error("Error handling aggregate balances:", error);
      }
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
              <div className="container mx-auto p-4">
                <h1 className="text-2xl font-bold mb-4">Prices & Balances</h1>
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead>
                      <tr className="text-left border-b border-gray-800">
                        <th className="py-2 font-medium text-gray-400">
                          Chain
                        </th>
                        {[1, 10, 130, 8453].map((chainId) => (
                          <th
                            key={chainId}
                            className="py-2 font-medium text-gray-200"
                          >
                            {chainId === 1
                              ? "Ethereum"
                              : chainId === 10
                                ? "Optimism"
                                : chainId === 130
                                  ? "Unichain"
                                  : "Base"}
                          </th>
                        ))}
                        <th className="py-2 font-medium text-gray-200">
                          Total Balance
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      <tr>
                        <td className="py-3 font-medium text-gray-400">
                          ETH Price
                        </td>
                        {[1, 10, 130, 8453].map((chainId) => (
                          <td key={chainId} className="py-3">
                            <span className="font-mono text-gray-200">
                              $
                              {ethPrices[chainId]?.price
                                ? Number(ethPrices[chainId].price).toFixed(2)
                                : "-"}
                            </span>
                          </td>
                        ))}
                        <td className="py-3">
                          <span className="font-mono text-gray-200">-</span>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 font-medium text-gray-400">
                          ETH Balance
                        </td>
                        {[1, 10, 130, 8453].map((chainId) => (
                          <td key={chainId} className="py-3">
                            <span className="font-mono text-gray-200">
                              {aggregateBalances?.chainBalances[chainId]?.tokens
                                .ETH
                                ? formatEthBalance(
                                    aggregateBalances.chainBalances[chainId]
                                      .tokens.ETH
                                  )
                                : "-"}
                            </span>
                          </td>
                        ))}
                        <td className="py-3">
                          <span className="font-mono text-gray-200">
                            {formatEthBalance(
                              aggregateBalances?.tokenBalances?.tokens?.ETH ??
                                "0"
                            )}
                            {aggregateBalances?.tokenBalances?.percentages
                              ?.ETH != null &&
                              aggregateBalances.tokenBalances.percentages.ETH >
                                0 && (
                                <span className="text-gray-500 ml-1">
                                  (
                                  {aggregateBalances.tokenBalances.percentages.ETH.toFixed(
                                    1
                                  )}
                                  %)
                                </span>
                              )}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 font-medium text-gray-400">
                          WETH Balance
                        </td>
                        {[1, 10, 130, 8453].map((chainId) => (
                          <td key={chainId} className="py-3">
                            <span className="font-mono text-gray-200">
                              {aggregateBalances?.chainBalances[chainId]?.tokens
                                .WETH
                                ? formatEthBalance(
                                    aggregateBalances.chainBalances[chainId]
                                      .tokens.WETH
                                  )
                                : "-"}
                            </span>
                          </td>
                        ))}
                        <td className="py-3">
                          <span className="font-mono text-gray-200">
                            {formatEthBalance(
                              aggregateBalances?.tokenBalances?.tokens?.WETH ??
                                "0"
                            )}
                            {aggregateBalances?.tokenBalances?.percentages
                              ?.WETH != null &&
                              aggregateBalances.tokenBalances.percentages.WETH >
                                0 && (
                                <span className="text-gray-500 ml-1">
                                  (
                                  {aggregateBalances.tokenBalances.percentages.WETH.toFixed(
                                    1
                                  )}
                                  %)
                                </span>
                              )}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 font-medium text-gray-400">
                          USDC Balance
                        </td>
                        {[1, 10, 130, 8453].map((chainId) => (
                          <td key={chainId} className="py-3">
                            <span className="font-mono text-gray-200">
                              {aggregateBalances?.chainBalances[chainId]?.tokens
                                .USDC
                                ? formatUsdcBalance(
                                    aggregateBalances.chainBalances[chainId]
                                      .tokens.USDC
                                  )
                                : "-"}
                            </span>
                          </td>
                        ))}
                        <td className="py-3">
                          <span className="font-mono text-gray-200">
                            {formatUsdcBalance(
                              aggregateBalances?.tokenBalances?.tokens?.USDC ??
                                "0"
                            )}
                            {aggregateBalances?.tokenBalances?.percentages
                              ?.USDC != null &&
                              aggregateBalances.tokenBalances.percentages.USDC >
                                0 && (
                                <span className="text-gray-500 ml-1">
                                  (
                                  {aggregateBalances.tokenBalances.percentages.USDC.toFixed(
                                    1
                                  )}
                                  %)
                                </span>
                              )}
                          </span>
                        </td>
                      </tr>
                      <tr>
                        <td className="py-3 font-medium text-gray-400">
                          Total Value (USD)
                        </td>
                        {[1, 10, 130, 8453].map((chainId) => (
                          <td key={chainId} className="py-3">
                            <span className="font-mono text-gray-200">
                              $
                              {Number(
                                aggregateBalances?.chainBalances[chainId]?.usd
                                  .total ?? 0
                              ).toFixed(2)}
                              {aggregateBalances?.chainBalances[chainId]
                                ?.percentageOfTotal != null &&
                                aggregateBalances.chainBalances[chainId]
                                  .percentageOfTotal > 0 && (
                                  <span className="text-gray-500 ml-1">
                                    (
                                    {aggregateBalances.chainBalances[
                                      chainId
                                    ].percentageOfTotal.toFixed(1)}
                                    %)
                                  </span>
                                )}
                            </span>
                          </td>
                        ))}
                        <td className="py-3">
                          <span className="font-mono text-gray-200">
                            $
                            {Number(
                              aggregateBalances?.totalBalance ?? 0
                            ).toFixed(2)}
                          </span>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
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

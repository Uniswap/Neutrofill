// Scale down a value by the specified number of decimals and format it
export function formatTokenAmount(
  amount: string,
  decimals: number,
  maxDecimals = 6
): string {
  if (!amount || amount === "-") return "-";

  // Convert from wei to decimal
  const scaled = Number(amount) / 10 ** decimals;

  // Format with maxDecimals precision, trimming trailing zeros
  return Number(scaled.toFixed(maxDecimals)).toString();
}

// Format ETH/WETH balance (18 decimals)
export function formatEthBalance(amount: string): string {
  return formatTokenAmount(amount, 18);
}

// Format USDC balance (6 decimals)
export function formatUsdcBalance(amount: string): string {
  return formatTokenAmount(amount, 6);
}

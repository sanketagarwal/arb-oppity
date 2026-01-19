/**
 * Agent Tool: Analyze Cross-Venue Arbitrage
 * 
 * Analyzes if a cross-venue arb between Kalshi and Polymarket is profitable
 * after accounting for fees using replay-fee-oracle.
 */

import { z } from 'zod';
import { getOracle } from 'replay-fee-oracle';

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════

export const analyzeArbInputSchema = z.object({
  kalshi_ticker: z.string().describe('Kalshi market ticker (e.g., "PRES-2024-DJT")'),
  polymarket_token_id: z.string().describe('Polymarket CLOB token ID or condition ID'),
  size_usd: z.number().default(1000).describe('Trade size in USD (default $1000)'),
  min_net_profit_pct: z.number().default(0.5).describe('Minimum net profit % to consider profitable'),
});

export const analyzeArbOutputSchema = z.object({
  // Prices
  kalshi_price: z.number().describe('Kalshi mid price (0-1)'),
  polymarket_price: z.number().describe('Polymarket mid price (0-1)'),
  price_diff: z.number().describe('Absolute price difference'),
  
  // Spread
  gross_spread_pct: z.number().describe('Gross spread as percentage'),
  gross_profit_usd: z.number().describe('Gross profit before fees'),
  
  // Fees (from replay-fee-oracle)
  kalshi_fee_usd: z.number().describe('Kalshi trading fee'),
  polymarket_fee_usd: z.number().describe('Polymarket trading fee + gas'),
  total_fees_usd: z.number().describe('Total fees both sides'),
  fees_as_pct_of_gross: z.number().describe('Fees as % of gross profit'),
  
  // Net
  net_profit_usd: z.number().describe('Net profit after fees'),
  net_profit_pct: z.number().describe('Net profit as % of trade size'),
  is_profitable: z.boolean().describe('True if net > min threshold'),
  
  // Direction
  buy_venue: z.enum(['KALSHI', 'POLYMARKET']).describe('Which venue to buy on'),
  sell_venue: z.enum(['KALSHI', 'POLYMARKET']).describe('Which venue to sell on'),
  
  // Decision
  action: z.enum(['EXECUTE', 'WAIT', 'SKIP']).describe('Recommended action'),
  reason: z.string().describe('Explanation of decision'),
  
  // Metadata
  timestamp: z.string(),
  size_usd: z.number(),
});

export type AnalyzeArbInput = z.infer<typeof analyzeArbInputSchema>;
export type AnalyzeArbOutput = z.infer<typeof analyzeArbOutputSchema>;

// ═══════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

interface ReplayLabsClient {
  getKalshiOrderbook(ticker: string): Promise<{
    mid_price: number;
    spread_bps: number;
  }>;
  getPolymarketBook(tokenId: string): Promise<{
    mid_price: number;
    spread_bps: number;
  }>;
}

/**
 * Determine action based on profitability and spread
 */
function determineAction(
  isProfitable: boolean,
  grossSpreadPct: number,
  netProfitPct: number
): { action: 'EXECUTE' | 'WAIT' | 'SKIP'; reason: string } {
  
  // Very profitable - execute
  if (isProfitable && grossSpreadPct >= 3) {
    return {
      action: 'EXECUTE',
      reason: `Strong opportunity: ${grossSpreadPct.toFixed(1)}% gross spread, ${netProfitPct.toFixed(2)}% net profit`,
    };
  }
  
  // Profitable but small - still execute
  if (isProfitable) {
    return {
      action: 'EXECUTE',
      reason: `Profitable: ${grossSpreadPct.toFixed(1)}% spread yields ${netProfitPct.toFixed(2)}% net after fees`,
    };
  }
  
  // Borderline - wait for better
  if (grossSpreadPct >= 1.5) {
    return {
      action: 'WAIT',
      reason: `Borderline: ${grossSpreadPct.toFixed(1)}% spread but fees make it unprofitable. Wait for >3% spread.`,
    };
  }
  
  // Not worth it
  if (grossSpreadPct < 0.5) {
    return {
      action: 'SKIP',
      reason: `No opportunity: ${grossSpreadPct.toFixed(1)}% spread is too small`,
    };
  }
  
  return {
    action: 'SKIP',
    reason: `Unprofitable: ${grossSpreadPct.toFixed(1)}% spread doesn't cover fees`,
  };
}

/**
 * Execute the analyze-arb tool
 */
export async function analyzeArb(
  input: AnalyzeArbInput,
  client: ReplayLabsClient
): Promise<AnalyzeArbOutput> {
  const { kalshi_ticker, polymarket_token_id, size_usd, min_net_profit_pct } = input;
  
  // 1. Get prices from both venues
  const [kalshiBook, polyBook] = await Promise.all([
    client.getKalshiOrderbook(kalshi_ticker),
    client.getPolymarketBook(polymarket_token_id),
  ]);
  
  const kalshiPrice = kalshiBook.mid_price;
  const polymarketPrice = polyBook.mid_price;
  const priceDiff = Math.abs(kalshiPrice - polymarketPrice);
  
  // 2. Determine direction (buy low, sell high)
  const buyVenue = kalshiPrice < polymarketPrice ? 'KALSHI' : 'POLYMARKET';
  const sellVenue = kalshiPrice < polymarketPrice ? 'POLYMARKET' : 'KALSHI';
  const buyPrice = Math.min(kalshiPrice, polymarketPrice);
  const sellPrice = Math.max(kalshiPrice, polymarketPrice);
  
  // 3. Calculate gross spread
  const grossSpreadPct = (priceDiff / buyPrice) * 100;
  const grossProfitUsd = size_usd * (grossSpreadPct / 100);
  
  // 4. Get fee estimates from replay-fee-oracle
  const oracle = getOracle();
  const analysis = await oracle.analyzeArbitrage(
    [
      { venue: 'KALSHI', direction: buyVenue === 'KALSHI' ? 'BUY' : 'SELL', size_usd, price: buyVenue === 'KALSHI' ? buyPrice : sellPrice },
      { venue: 'POLYMARKET', direction: buyVenue === 'POLYMARKET' ? 'BUY' : 'SELL', size_usd, price: buyVenue === 'POLYMARKET' ? buyPrice : sellPrice },
    ],
    grossProfitUsd,
    min_net_profit_pct
  );
  
  // 5. Extract individual fees
  const kalshiFee = analysis.leg_estimates.find(e => e.venue === 'KALSHI')?.total_fee_usd ?? 0;
  const polymarketFee = analysis.leg_estimates.find(e => e.venue === 'POLYMARKET')?.total_fee_usd ?? 0;
  
  // 6. Calculate fee percentage
  const feesAsPctOfGross = grossProfitUsd > 0 
    ? (analysis.total_fees_usd / grossProfitUsd) * 100 
    : 100;
  
  // 7. Determine action
  const { action, reason } = determineAction(
    analysis.is_profitable,
    grossSpreadPct,
    analysis.net_profit_pct
  );
  
  return {
    kalshi_price: kalshiPrice,
    polymarket_price: polymarketPrice,
    price_diff: priceDiff,
    gross_spread_pct: grossSpreadPct,
    gross_profit_usd: grossProfitUsd,
    kalshi_fee_usd: kalshiFee,
    polymarket_fee_usd: polymarketFee,
    total_fees_usd: analysis.total_fees_usd,
    fees_as_pct_of_gross: feesAsPctOfGross,
    net_profit_usd: analysis.net_profit_usd,
    net_profit_pct: analysis.net_profit_pct,
    is_profitable: analysis.is_profitable,
    buy_venue: buyVenue,
    sell_venue: sellVenue,
    action,
    reason,
    timestamp: new Date().toISOString(),
    size_usd,
  };
}

// ═══════════════════════════════════════════════════════════════
// TOOL DEFINITION (Mastra-compatible structure)
// ═══════════════════════════════════════════════════════════════

export const analyzeArbTool = {
  id: 'analyze-cross-venue-arb',
  description: `Analyze cross-venue arbitrage opportunity between Kalshi and Polymarket.

Compares prices on both venues, calculates fees using replay-fee-oracle,
and determines if the arb is profitable.

Returns:
- Prices on both venues
- Gross spread percentage
- Fee breakdown (Kalshi formula-based, Polymarket 1bp + gas)
- Net profit after fees
- Action recommendation: EXECUTE, WAIT, or SKIP

Use AFTER checking liquidity regime to ensure timing is favorable.`,
  inputSchema: analyzeArbInputSchema,
  outputSchema: analyzeArbOutputSchema,
  execute: analyzeArb,
};

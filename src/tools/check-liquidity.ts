/**
 * Agent Tool: Check Liquidity Regime
 * 
 * Checks current liquidity conditions for a prediction market.
 * Returns regime classification and recommendation for agent.
 */

import { z } from 'zod';
import type { LiquidityRegime } from '../types';

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════

export const checkLiquidityInputSchema = z.object({
  market_id: z.string().describe('Kalshi ticker (e.g., "PRES-2024-DJT") or Polymarket condition ID'),
  venue: z.enum(['KALSHI', 'POLYMARKET']).describe('Which venue to check'),
});

export const checkLiquidityOutputSchema = z.object({
  market_id: z.string(),
  venue: z.string(),
  timestamp: z.string(),
  
  // Regime
  regime: z.enum(['thick', 'normal', 'thin', 'very_thin']),
  spread_bps: z.number().describe('Current spread in basis points'),
  spread_zscore: z.number().describe('Spread z-score vs 7-day average'),
  
  // Depth
  bid_depth: z.number(),
  ask_depth: z.number(),
  depth_zscore: z.number(),
  
  // Time factors
  hour_est: z.number().describe('Current hour in EST (0-23)'),
  is_off_hours: z.boolean().describe('True if 12am-6am EST'),
  is_weekend: z.boolean(),
  
  // Recommendation
  is_favorable: z.boolean().describe('True if good conditions for arb'),
  recommendation: z.string().describe('Action recommendation for agent'),
});

export type CheckLiquidityInput = z.infer<typeof checkLiquidityInputSchema>;
export type CheckLiquidityOutput = z.infer<typeof checkLiquidityOutputSchema>;

// ═══════════════════════════════════════════════════════════════
// THRESHOLDS (to be calibrated from historical analysis)
// ═══════════════════════════════════════════════════════════════

const REGIME_THRESHOLDS = {
  very_thin_zscore: 2.5,
  thin_zscore: 1.5,
  thick_zscore: -1.0,
};

// ═══════════════════════════════════════════════════════════════
// TOOL IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

interface ReplayLabsClient {
  getKalshiOrderbook(ticker: string): Promise<{
    mid_price: number;
    spread: number;
    spread_bps: number;
    bid_depth: number;
    ask_depth: number;
  }>;
  getPolymarketSpread(tokenId: string): Promise<{
    mid_price: number;
    spread: number;
    spread_bps: number;
    bid_depth: number;
    ask_depth: number;
  }>;
  getHistoricalStats(marketId: string, venue: string): Promise<{
    mean_spread_bps: number;
    std_spread_bps: number;
    mean_depth: number;
    std_depth: number;
  }>;
}

/**
 * Compute liquidity regime from spread z-score
 */
function computeRegime(spreadZscore: number): LiquidityRegime {
  if (spreadZscore >= REGIME_THRESHOLDS.very_thin_zscore) return 'very_thin';
  if (spreadZscore >= REGIME_THRESHOLDS.thin_zscore) return 'thin';
  if (spreadZscore <= REGIME_THRESHOLDS.thick_zscore) return 'thick';
  return 'normal';
}

/**
 * Get current hour in EST
 */
function getHourEST(): number {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return (utcHour - 5 + 24) % 24;
}

/**
 * Check if current time is off-hours (12am-6am EST)
 */
function isOffHours(): boolean {
  const hour = getHourEST();
  return hour >= 0 && hour < 6;
}

/**
 * Check if today is weekend
 */
function isWeekendNow(): boolean {
  const dow = new Date().getUTCDay();
  return dow === 0 || dow === 6;
}

/**
 * Generate recommendation based on regime and time
 */
function generateRecommendation(
  regime: LiquidityRegime,
  isOffHoursNow: boolean,
  isWeekendNow: boolean
): string {
  if (regime === 'very_thin') {
    return '🎯 Excellent conditions - spreads are very wide, check for cross-venue arb immediately';
  }
  if (regime === 'thin') {
    return '✅ Good conditions - spreads are wider than normal, favorable for arb entry';
  }
  if (regime === 'thick') {
    return '⏸️ Tight spreads - liquidity is high, wait for better entry';
  }
  
  // Normal regime - give time-based advice
  if (isOffHoursNow || isWeekendNow) {
    return '👀 Normal spreads during off-hours - monitor for widening';
  }
  return '⏳ Normal conditions - spreads may widen during off-hours (12am-6am EST) or weekends';
}

/**
 * Execute the check-liquidity tool
 */
export async function checkLiquidity(
  input: CheckLiquidityInput,
  client: ReplayLabsClient
): Promise<CheckLiquidityOutput> {
  const { market_id, venue } = input;
  
  // 1. Get current orderbook
  const orderbook = venue === 'KALSHI'
    ? await client.getKalshiOrderbook(market_id)
    : await client.getPolymarketSpread(market_id);
  
  // 2. Get historical stats for z-score calculation
  const stats = await client.getHistoricalStats(market_id, venue);
  
  // 3. Compute z-scores
  const spreadZscore = stats.std_spread_bps > 0
    ? (orderbook.spread_bps - stats.mean_spread_bps) / stats.std_spread_bps
    : 0;
  
  const totalDepth = orderbook.bid_depth + orderbook.ask_depth;
  const depthZscore = stats.std_depth > 0
    ? (totalDepth - stats.mean_depth) / stats.std_depth
    : 0;
  
  // 4. Compute regime
  const regime = computeRegime(spreadZscore);
  
  // 5. Time factors
  const hourEst = getHourEST();
  const offHours = isOffHours();
  const weekend = isWeekendNow();
  
  // 6. Determine if favorable
  const isFavorable = regime === 'thin' || regime === 'very_thin';
  
  // 7. Generate recommendation
  const recommendation = generateRecommendation(regime, offHours, weekend);
  
  return {
    market_id,
    venue,
    timestamp: new Date().toISOString(),
    regime,
    spread_bps: orderbook.spread_bps,
    spread_zscore: spreadZscore,
    bid_depth: orderbook.bid_depth,
    ask_depth: orderbook.ask_depth,
    depth_zscore: depthZscore,
    hour_est: hourEst,
    is_off_hours: offHours,
    is_weekend: weekend,
    is_favorable: isFavorable,
    recommendation,
  };
}

// ═══════════════════════════════════════════════════════════════
// TOOL DEFINITION (Mastra-compatible structure)
// ═══════════════════════════════════════════════════════════════

export const checkLiquidityTool = {
  id: 'check-liquidity-regime',
  description: `Check current liquidity regime for a prediction market.

Returns:
- regime: thick/normal/thin/very_thin
- spread in basis points
- whether conditions are favorable for arbitrage
- actionable recommendation

Use this BEFORE analyzing cross-venue arb to ensure timing is right.`,
  inputSchema: checkLiquidityInputSchema,
  outputSchema: checkLiquidityOutputSchema,
  execute: checkLiquidity,
};

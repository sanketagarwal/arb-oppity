/**
 * Agent Tool: Scan for Arbitrage Opportunities
 * 
 * Two modes:
 * 1. SCAN NOW: Find markets with wide spreads right now
 * 2. PREDICT: Forecast when spreads will likely widen for a specific market
 */

import { z } from 'zod';
import { getOracle } from 'replay-fee-oracle';
import type { LiquidityRegime } from '../types';

// ═══════════════════════════════════════════════════════════════
// SCHEMAS
// ═══════════════════════════════════════════════════════════════

export const scanOpportunitiesInputSchema = z.object({
  mode: z.enum(['scan_now', 'predict']).describe('scan_now = find current opportunities, predict = forecast future windows'),
  
  // For scan_now mode
  min_spread_pct: z.number().default(2).describe('Minimum gross spread % to consider (default 2%)'),
  min_net_profit_usd: z.number().default(10).describe('Minimum net profit after fees (default $10)'),
  size_usd: z.number().default(1000).describe('Trade size for calculations'),
  
  // For predict mode
  market_id: z.string().optional().describe('Market to predict (required for predict mode)'),
  hours_ahead: z.number().default(24).describe('How far ahead to predict (default 24h)'),
});

export const opportunitySchema = z.object({
  market_id: z.string(),
  kalshi_ticker: z.string(),
  polymarket_token_id: z.string(),
  
  // Current state
  kalshi_price: z.number(),
  polymarket_price: z.number(),
  gross_spread_pct: z.number(),
  
  // Fee-adjusted
  total_fees_usd: z.number(),
  net_profit_usd: z.number(),
  net_profit_pct: z.number(),
  
  // Quality score (0-100)
  score: z.number().describe('Opportunity quality score'),
  
  // Direction
  buy_venue: z.enum(['KALSHI', 'POLYMARKET']),
  sell_venue: z.enum(['KALSHI', 'POLYMARKET']),
});

export const predictionSchema = z.object({
  market_id: z.string(),
  
  // Historical patterns
  best_hours_est: z.array(z.number()).describe('Hours (EST) with historically widest spreads'),
  best_days: z.array(z.string()).describe('Days with historically widest spreads'),
  
  // Predictions
  next_likely_window: z.object({
    start: z.string().describe('ISO timestamp'),
    end: z.string().describe('ISO timestamp'),
    expected_spread_pct: z.number(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string(),
  }),
  
  // Current vs historical
  current_spread_pct: z.number(),
  avg_spread_pct: z.number(),
  spread_percentile: z.number().describe('Current spread percentile (0-100, higher = wider than usual)'),
});

export const scanOpportunitiesOutputSchema = z.object({
  mode: z.enum(['scan_now', 'predict']),
  timestamp: z.string(),
  
  // For scan_now
  opportunities: z.array(opportunitySchema).optional(),
  total_scanned: z.number().optional(),
  
  // For predict
  prediction: predictionSchema.optional(),
  
  // Summary
  summary: z.string(),
});

export type ScanOpportunitiesInput = z.infer<typeof scanOpportunitiesInputSchema>;
export type ScanOpportunitiesOutput = z.infer<typeof scanOpportunitiesOutputSchema>;
export type Opportunity = z.infer<typeof opportunitySchema>;
export type Prediction = z.infer<typeof predictionSchema>;

// ═══════════════════════════════════════════════════════════════
// MARKET REGISTRY (to be populated from Replay Labs)
// ═══════════════════════════════════════════════════════════════

interface MarketPair {
  id: string;
  name: string;
  kalshi_ticker: string;
  polymarket_token_id: string;
  category: string;
}

// Placeholder - in production, fetch from Replay Labs or maintain a mapping
const MARKET_PAIRS: MarketPair[] = [
  // These would be populated from actual market data
];

// ═══════════════════════════════════════════════════════════════
// HISTORICAL STATS (to be populated from analysis)
// ═══════════════════════════════════════════════════════════════

interface MarketStats {
  market_id: string;
  mean_spread_pct: number;
  std_spread_pct: number;
  
  // By hour (EST)
  spread_by_hour: Record<number, { mean: number; std: number; sample_count: number }>;
  
  // By day of week
  spread_by_dow: Record<number, { mean: number; std: number; sample_count: number }>;
  
  // Best times (historically widest)
  best_hours: number[];
  best_days: number[];
}

// Cache for historical stats
const statsCache = new Map<string, MarketStats>();

// ═══════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ═══════════════════════════════════════════════════════════════

interface ReplayLabsClient {
  getKalshiOrderbook(ticker: string): Promise<{ mid_price: number; spread_bps: number }>;
  getPolymarketBook(tokenId: string): Promise<{ mid_price: number; spread_bps: number }>;
  getKalshiMarkets(params?: { status?: string }): Promise<{ ticker: string; title: string }[]>;
  getHistoricalSpreads(marketId: string, days: number): Promise<{
    timestamp: string;
    spread_pct: number;
  }[]>;
}

/**
 * Calculate opportunity score (0-100)
 * Higher = better opportunity
 */
function calculateScore(
  netProfitPct: number,
  spreadPercentile: number,
  bidDepth: number,
  askDepth: number
): number {
  // Factors:
  // 1. Net profit (most important) - 50%
  // 2. Spread percentile (how unusual is this) - 30%
  // 3. Depth (can we actually execute) - 20%
  
  const profitScore = Math.min(netProfitPct * 10, 50); // Max 50 points for 5%+ profit
  const percentileScore = (spreadPercentile / 100) * 30; // Max 30 points
  const depthScore = Math.min((bidDepth + askDepth) / 10000, 1) * 20; // Max 20 points
  
  return Math.round(profitScore + percentileScore + depthScore);
}

/**
 * Get current hour in EST
 */
function getCurrentHourEST(): number {
  const now = new Date();
  const utcHour = now.getUTCHours();
  return (utcHour - 5 + 24) % 24;
}

/**
 * Find next occurrence of a specific hour
 */
function getNextOccurrence(targetHour: number): Date {
  const now = new Date();
  const currentHourEST = getCurrentHourEST();
  
  let hoursUntil = targetHour - currentHourEST;
  if (hoursUntil <= 0) hoursUntil += 24;
  
  const next = new Date(now.getTime() + hoursUntil * 60 * 60 * 1000);
  return next;
}

/**
 * SCAN NOW: Find current opportunities across all markets
 */
async function scanNow(
  input: ScanOpportunitiesInput,
  client: ReplayLabsClient
): Promise<ScanOpportunitiesOutput> {
  const { min_spread_pct, min_net_profit_usd, size_usd } = input;
  const oracle = getOracle();
  const opportunities: Opportunity[] = [];
  
  // Get all active markets
  const markets = await client.getKalshiMarkets({ status: 'open' });
  
  for (const pair of MARKET_PAIRS) {
    try {
      // Get current prices
      const [kalshiBook, polyBook] = await Promise.all([
        client.getKalshiOrderbook(pair.kalshi_ticker),
        client.getPolymarketBook(pair.polymarket_token_id),
      ]);
      
      const kalshiPrice = kalshiBook.mid_price;
      const polymarketPrice = polyBook.mid_price;
      const priceDiff = Math.abs(kalshiPrice - polymarketPrice);
      const grossSpreadPct = (priceDiff / Math.min(kalshiPrice, polymarketPrice)) * 100;
      
      // Skip if spread too small
      if (grossSpreadPct < min_spread_pct) continue;
      
      // Calculate fees
      const buyVenue = kalshiPrice < polymarketPrice ? 'KALSHI' : 'POLYMARKET';
      const buyPrice = Math.min(kalshiPrice, polymarketPrice);
      const sellPrice = Math.max(kalshiPrice, polymarketPrice);
      
      const analysis = await oracle.analyzeArbitrage(
        [
          { venue: 'KALSHI', direction: buyVenue === 'KALSHI' ? 'BUY' : 'SELL', size_usd, price: buyVenue === 'KALSHI' ? buyPrice : sellPrice },
          { venue: 'POLYMARKET', direction: buyVenue === 'POLYMARKET' ? 'BUY' : 'SELL', size_usd, price: buyVenue === 'POLYMARKET' ? buyPrice : sellPrice },
        ],
        size_usd * grossSpreadPct / 100,
        0.5
      );
      
      // Skip if not profitable enough
      if (analysis.net_profit_usd < min_net_profit_usd) continue;
      
      // Get historical percentile
      const stats = statsCache.get(pair.id);
      const spreadPercentile = stats 
        ? calculatePercentile(grossSpreadPct, stats.mean_spread_pct, stats.std_spread_pct)
        : 50;
      
      opportunities.push({
        market_id: pair.id,
        kalshi_ticker: pair.kalshi_ticker,
        polymarket_token_id: pair.polymarket_token_id,
        kalshi_price: kalshiPrice,
        polymarket_price: polymarketPrice,
        gross_spread_pct: grossSpreadPct,
        total_fees_usd: analysis.total_fees_usd,
        net_profit_usd: analysis.net_profit_usd,
        net_profit_pct: analysis.net_profit_pct,
        score: calculateScore(analysis.net_profit_pct, spreadPercentile, 1000, 1000),
        buy_venue: buyVenue,
        sell_venue: buyVenue === 'KALSHI' ? 'POLYMARKET' : 'KALSHI',
      });
    } catch (e) {
      // Skip markets with errors
      continue;
    }
  }
  
  // Sort by score descending
  opportunities.sort((a, b) => b.score - a.score);
  
  const summary = opportunities.length > 0
    ? `Found ${opportunities.length} opportunities. Best: ${opportunities[0]?.market_id} with ${opportunities[0]?.net_profit_pct.toFixed(2)}% net profit`
    : `No opportunities found above ${min_spread_pct}% spread / $${min_net_profit_usd} profit threshold`;
  
  return {
    mode: 'scan_now',
    timestamp: new Date().toISOString(),
    opportunities,
    total_scanned: MARKET_PAIRS.length,
    summary,
  };
}

/**
 * PREDICT: Forecast when spreads will likely widen
 */
async function predict(
  input: ScanOpportunitiesInput,
  client: ReplayLabsClient
): Promise<ScanOpportunitiesOutput> {
  const { market_id, hours_ahead } = input;
  
  if (!market_id) {
    return {
      mode: 'predict',
      timestamp: new Date().toISOString(),
      summary: 'Error: market_id is required for predict mode',
    };
  }
  
  // Get historical data
  const historicalSpreads = await client.getHistoricalSpreads(market_id, 90);
  
  // Compute statistics
  const stats = computeMarketStats(market_id, historicalSpreads);
  statsCache.set(market_id, stats);
  
  // Get current spread
  const pair = MARKET_PAIRS.find(p => p.id === market_id);
  let currentSpreadPct = 0;
  
  if (pair) {
    const [kalshiBook, polyBook] = await Promise.all([
      client.getKalshiOrderbook(pair.kalshi_ticker),
      client.getPolymarketBook(pair.polymarket_token_id),
    ]);
    currentSpreadPct = Math.abs(kalshiBook.mid_price - polyBook.mid_price) * 100;
  }
  
  // Find best hours and days
  const bestHours = stats.best_hours.slice(0, 3);
  const bestDays = stats.best_days.slice(0, 2);
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  // Predict next window
  const nextBestHour = findNextBestHour(bestHours, hours_ahead);
  const expectedSpread = stats.spread_by_hour[nextBestHour.hour]?.mean ?? stats.mean_spread_pct;
  
  // Calculate percentile
  const spreadPercentile = calculatePercentile(currentSpreadPct, stats.mean_spread_pct, stats.std_spread_pct);
  
  // Determine confidence based on sample size and consistency
  const hourStats = stats.spread_by_hour[nextBestHour.hour];
  const confidence = hourStats && hourStats.sample_count > 50 ? 'high' : hourStats && hourStats.sample_count > 20 ? 'medium' : 'low';
  
  const prediction: Prediction = {
    market_id,
    best_hours_est: bestHours,
    best_days: bestDays.map(d => dayNames[d] ?? 'Unknown'),
    next_likely_window: {
      start: nextBestHour.start.toISOString(),
      end: new Date(nextBestHour.start.getTime() + 2 * 60 * 60 * 1000).toISOString(), // 2 hour window
      expected_spread_pct: expectedSpread,
      confidence,
      reason: `Hour ${nextBestHour.hour} EST historically has ${((expectedSpread / stats.mean_spread_pct - 1) * 100).toFixed(0)}% wider spreads than average`,
    },
    current_spread_pct: currentSpreadPct,
    avg_spread_pct: stats.mean_spread_pct,
    spread_percentile: spreadPercentile,
  };
  
  const isCurrentlyWide = spreadPercentile > 70;
  const summary = isCurrentlyWide
    ? `Current spread is in the ${spreadPercentile.toFixed(0)}th percentile - WIDER than usual. Consider scanning now.`
    : `Current spread is normal (${spreadPercentile.toFixed(0)}th percentile). Next likely window: ${nextBestHour.start.toLocaleTimeString()} EST`;
  
  return {
    mode: 'predict',
    timestamp: new Date().toISOString(),
    prediction,
    summary,
  };
}

/**
 * Compute market statistics from historical data
 */
function computeMarketStats(marketId: string, data: { timestamp: string; spread_pct: number }[]): MarketStats {
  const spreads = data.map(d => d.spread_pct);
  const mean = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const std = Math.sqrt(spreads.reduce((sum, x) => sum + (x - mean) ** 2, 0) / spreads.length);
  
  // Group by hour
  const byHour: Record<number, number[]> = {};
  for (let h = 0; h < 24; h++) byHour[h] = [];
  
  for (const d of data) {
    const hour = new Date(d.timestamp).getUTCHours();
    const hourEST = (hour - 5 + 24) % 24;
    byHour[hourEST]?.push(d.spread_pct);
  }
  
  const spreadByHour: Record<number, { mean: number; std: number; sample_count: number }> = {};
  for (let h = 0; h < 24; h++) {
    const hourSpreads = byHour[h] ?? [];
    if (hourSpreads.length > 0) {
      const hourMean = hourSpreads.reduce((a, b) => a + b, 0) / hourSpreads.length;
      const hourStd = Math.sqrt(hourSpreads.reduce((sum, x) => sum + (x - hourMean) ** 2, 0) / hourSpreads.length);
      spreadByHour[h] = { mean: hourMean, std: hourStd, sample_count: hourSpreads.length };
    }
  }
  
  // Group by day of week
  const byDow: Record<number, number[]> = {};
  for (let d = 0; d < 7; d++) byDow[d] = [];
  
  for (const d of data) {
    const dow = new Date(d.timestamp).getUTCDay();
    byDow[dow]?.push(d.spread_pct);
  }
  
  const spreadByDow: Record<number, { mean: number; std: number; sample_count: number }> = {};
  for (let d = 0; d < 7; d++) {
    const dowSpreads = byDow[d] ?? [];
    if (dowSpreads.length > 0) {
      const dowMean = dowSpreads.reduce((a, b) => a + b, 0) / dowSpreads.length;
      const dowStd = Math.sqrt(dowSpreads.reduce((sum, x) => sum + (x - dowMean) ** 2, 0) / dowSpreads.length);
      spreadByDow[d] = { mean: dowMean, std: dowStd, sample_count: dowSpreads.length };
    }
  }
  
  // Find best hours (highest mean spread)
  const bestHours = Object.entries(spreadByHour)
    .sort(([, a], [, b]) => b.mean - a.mean)
    .slice(0, 5)
    .map(([h]) => parseInt(h));
  
  // Find best days
  const bestDays = Object.entries(spreadByDow)
    .sort(([, a], [, b]) => b.mean - a.mean)
    .slice(0, 3)
    .map(([d]) => parseInt(d));
  
  return {
    market_id: marketId,
    mean_spread_pct: mean,
    std_spread_pct: std,
    spread_by_hour: spreadByHour,
    spread_by_dow: spreadByDow,
    best_hours: bestHours,
    best_days: bestDays,
  };
}

/**
 * Calculate percentile (0-100) for a value given mean and std
 */
function calculatePercentile(value: number, mean: number, std: number): number {
  if (std === 0) return 50;
  const zscore = (value - mean) / std;
  // Approximate CDF using error function approximation
  const percentile = 50 * (1 + Math.sign(zscore) * Math.sqrt(1 - Math.exp(-2 * zscore * zscore / Math.PI)));
  return Math.max(0, Math.min(100, percentile));
}

/**
 * Find next occurrence of one of the best hours within time limit
 */
function findNextBestHour(bestHours: number[], hoursAhead: number): { hour: number; start: Date } {
  const now = new Date();
  const currentHourEST = getCurrentHourEST();
  
  let bestMatch = { hour: bestHours[0] ?? 0, hoursUntil: 24 };
  
  for (const hour of bestHours) {
    let hoursUntil = hour - currentHourEST;
    if (hoursUntil <= 0) hoursUntil += 24;
    
    if (hoursUntil <= hoursAhead && hoursUntil < bestMatch.hoursUntil) {
      bestMatch = { hour, hoursUntil };
    }
  }
  
  const start = new Date(now.getTime() + bestMatch.hoursUntil * 60 * 60 * 1000);
  return { hour: bestMatch.hour, start };
}

/**
 * Main execution function
 */
export async function scanOpportunities(
  input: ScanOpportunitiesInput,
  client: ReplayLabsClient
): Promise<ScanOpportunitiesOutput> {
  if (input.mode === 'scan_now') {
    return scanNow(input, client);
  } else {
    return predict(input, client);
  }
}

// ═══════════════════════════════════════════════════════════════
// TOOL DEFINITION
// ═══════════════════════════════════════════════════════════════

export const scanOpportunitiesTool = {
  id: 'scan-opportunities',
  description: `Scan for cross-venue arbitrage opportunities.

TWO MODES:

1. scan_now: Find markets with wide spreads RIGHT NOW
   - Scans all tracked market pairs
   - Calculates fees and net profit
   - Returns ranked list of actionable opportunities
   
2. predict: Forecast WHEN spreads will likely widen
   - Analyzes historical patterns for a specific market
   - Identifies best hours/days based on data
   - Returns next predicted window and current percentile

Example usage:
- "Scan for opportunities now" → mode: scan_now
- "When will Trump market spreads widen?" → mode: predict, market_id: "TRUMP-2024"`,
  inputSchema: scanOpportunitiesInputSchema,
  outputSchema: scanOpportunitiesOutputSchema,
  execute: scanOpportunities,
};

/**
 * arb-oppity: Cross-Venue Prediction Market Arbitrage Tools
 * 
 * Extension for Replay Labs API.
 * 
 * @example
 * ```ts
 * import { scanOpportunities, analyzeArb } from 'arb-oppity';
 * 
 * // Step 1: Find opportunities across all markets
 * const scan = await scanOpportunities({
 *   mode: 'scan_now',
 *   min_spread_pct: 3,
 *   min_net_profit_usd: 20,
 * }, replayLabsClient);
 * 
 * // Step 2: If opportunities exist, analyze the best one
 * if (scan.opportunities.length > 0) {
 *   const best = scan.opportunities[0];
 *   const analysis = await analyzeArb({
 *     kalshi_ticker: best.kalshi_ticker,
 *     polymarket_token_id: best.polymarket_token_id,
 *     size_usd: 1000,
 *   }, replayLabsClient);
 *   
 *   if (analysis.action === 'EXECUTE') {
 *     console.log(`Execute: Buy ${analysis.buy_venue}, Sell ${analysis.sell_venue}`);
 *   }
 * }
 * 
 * // Or: Predict when a specific market will have opportunities
 * const prediction = await scanOpportunities({
 *   mode: 'predict',
 *   market_id: 'TRUMP-2024',
 *   hours_ahead: 24,
 * }, replayLabsClient);
 * 
 * console.log(`Next window: ${prediction.prediction.next_likely_window.start}`);
 * ```
 */

// Tools
export {
  // Primary: Scan for opportunities
  scanOpportunitiesTool,
  scanOpportunities,
  scanOpportunitiesInputSchema,
  scanOpportunitiesOutputSchema,
  type ScanOpportunitiesInput,
  type ScanOpportunitiesOutput,
  type Opportunity,
  type Prediction,
  
  // Secondary: Detailed analysis of specific opportunity
  analyzeArbTool,
  analyzeArb,
  analyzeArbInputSchema,
  analyzeArbOutputSchema,
  type AnalyzeArbInput,
  type AnalyzeArbOutput,
  
  // Tool registry for agent frameworks
  arbOppityTools,
} from './tools';

// Types
export type {
  LiquidityRegime,
  MarketCategory,
  ArbAction,
  OrderbookSnapshot,
  Market,
  SpreadDataPoint,
  SpreadStats,
  CrossVenueSnapshot,
  LiquidityIndicator,
  LiquidityWindow,
  HypothesisResult,
  FeeAdjustedOpportunity,
} from './types';

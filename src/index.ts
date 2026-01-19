/**
 * arb-oppity: Liquidity Timing Extension for Replay Labs
 * 
 * Agent tools for cross-venue prediction market arbitrage.
 * Integrates with Replay Labs API and replay-fee-oracle.
 * 
 * @example
 * ```ts
 * import { checkLiquidity, analyzeArb } from 'arb-oppity';
 * 
 * // Step 1: Check if liquidity conditions are favorable
 * const liquidity = await checkLiquidity({
 *   market_id: 'PRES-2024-DJT',
 *   venue: 'KALSHI',
 * }, replayLabsClient);
 * 
 * if (liquidity.is_favorable) {
 *   // Step 2: Analyze the arb opportunity
 *   const arb = await analyzeArb({
 *     kalshi_ticker: 'PRES-2024-DJT',
 *     polymarket_token_id: '0x123...',
 *     size_usd: 1000,
 *   }, replayLabsClient);
 *   
 *   if (arb.action === 'EXECUTE') {
 *     console.log(`Execute: Buy on ${arb.buy_venue}, Sell on ${arb.sell_venue}`);
 *     console.log(`Net profit: $${arb.net_profit_usd.toFixed(2)}`);
 *   }
 * }
 * ```
 */

// Tools
export {
  checkLiquidityTool,
  checkLiquidity,
  checkLiquidityInputSchema,
  checkLiquidityOutputSchema,
  type CheckLiquidityInput,
  type CheckLiquidityOutput,
  
  analyzeArbTool,
  analyzeArb,
  analyzeArbInputSchema,
  analyzeArbOutputSchema,
  type AnalyzeArbInput,
  type AnalyzeArbOutput,
  
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

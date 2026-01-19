/**
 * Agent Tools for Cross-Venue Prediction Market Arbitrage
 * 
 * These tools are designed for use with AI agents (e.g., Mastra framework).
 * They integrate with Replay Labs API for market data and replay-fee-oracle for fee calculation.
 */

export { 
  checkLiquidityTool,
  checkLiquidity,
  checkLiquidityInputSchema,
  checkLiquidityOutputSchema,
  type CheckLiquidityInput,
  type CheckLiquidityOutput,
} from './check-liquidity';

export {
  analyzeArbTool,
  analyzeArb,
  analyzeArbInputSchema,
  analyzeArbOutputSchema,
  type AnalyzeArbInput,
  type AnalyzeArbOutput,
} from './analyze-arb';

/**
 * All tools for easy registration with agent framework
 */
export const arbOppityTools = {
  checkLiquidityRegime: {
    id: 'check-liquidity-regime',
    description: 'Check current liquidity regime for a prediction market',
  },
  analyzeCrossVenueArb: {
    id: 'analyze-cross-venue-arb', 
    description: 'Analyze if cross-venue arb is profitable after fees',
  },
};

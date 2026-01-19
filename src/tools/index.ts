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

export {
  scanOpportunitiesTool,
  scanOpportunities,
  scanOpportunitiesInputSchema,
  scanOpportunitiesOutputSchema,
  type ScanOpportunitiesInput,
  type ScanOpportunitiesOutput,
  type Opportunity,
  type Prediction,
} from './scan-opportunities';

/**
 * All tools for easy registration with agent framework
 */
export const arbOppityTools = {
  // PRIMARY TOOL - Use this first
  scanOpportunities: {
    id: 'scan-opportunities',
    description: 'Scan for arb opportunities NOW or PREDICT when they will occur',
  },
  
  // SECONDARY - For detailed analysis of a specific opportunity
  analyzeCrossVenueArb: {
    id: 'analyze-cross-venue-arb', 
    description: 'Deep analysis of a specific arb with full fee breakdown',
  },
  
  // LEGACY - Kept for compatibility
  checkLiquidityRegime: {
    id: 'check-liquidity-regime',
    description: 'Check liquidity regime for a single market',
  },
};

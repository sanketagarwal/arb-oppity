/**
 * Agent Tools for Cross-Venue Prediction Market Arbitrage
 * 
 * Two tools, both market-specific:
 * 
 * 1. scan-opportunities: Find opportunities across markets
 *    - scan_now: Which markets have wide spreads RIGHT NOW?
 *    - predict: When will THIS MARKET likely have wide spreads?
 * 
 * 2. analyze-arb: Deep dive into a SPECIFIC opportunity
 *    - Full fee breakdown
 *    - Direction (buy/sell venue)
 *    - Execute/wait/skip recommendation
 */

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

export {
  analyzeArbTool,
  analyzeArb,
  analyzeArbInputSchema,
  analyzeArbOutputSchema,
  type AnalyzeArbInput,
  type AnalyzeArbOutput,
} from './analyze-arb';

/**
 * All tools for agent registration
 */
export const arbOppityTools = {
  scanOpportunities: {
    id: 'scan-opportunities',
    description: `Find arbitrage opportunities across prediction markets.
    
    Mode 'scan_now': Returns ALL markets with spreads above threshold, ranked by profit potential.
    Mode 'predict': For a SPECIFIC market, predicts when spreads will likely widen based on historical patterns.`,
  },
  
  analyzeArb: {
    id: 'analyze-cross-venue-arb', 
    description: `Analyze a SPECIFIC market pair for arbitrage.
    
    Given Kalshi ticker + Polymarket token, returns:
    - Current prices on both venues
    - Fee breakdown (Kalshi formula, Polymarket 1bp + gas)
    - Net profit after fees
    - EXECUTE / WAIT / SKIP recommendation`,
  },
};

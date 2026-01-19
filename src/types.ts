/**
 * Core types for arb-oppity
 * 
 * Extension types for Replay Labs prediction market arbitrage.
 */

export type LiquidityRegime = 'thick' | 'normal' | 'thin' | 'very_thin';
export type MarketCategory = 'politics' | 'sports' | 'crypto' | 'economics' | 'weather' | 'other';
export type ArbAction = 'EXECUTE' | 'WAIT' | 'SKIP';

/**
 * Orderbook snapshot from Replay Labs API
 */
export interface OrderbookSnapshot {
  timestamp: string;
  mid_price: number;
  spread: number;
  spread_bps: number;
  imbalance: number;
  bid_depth: number;
  ask_depth: number;
}

/**
 * Market metadata
 */
export interface Market {
  id: string;
  ticker: string;
  title: string;
  category: MarketCategory;
  volume_24h_usd: number;
  created_at: string;
  closes_at?: string;
  
  // Cross-venue mapping
  polymarket_id?: string;
}

/**
 * Spread data point for analysis
 */
export interface SpreadDataPoint {
  timestamp: string;
  market_id: string;
  spread_bps: number;
  mid_price: number;
  bid_depth: number;
  ask_depth: number;
  
  // Derived
  hour_of_day: number;  // 0-23 EST
  day_of_week: number;  // 0=Sun, 6=Sat
  is_weekend: boolean;
}

/**
 * Spread statistics for a group
 */
export interface SpreadStats {
  group_key: string;
  sample_count: number;
  mean_spread_bps: number;
  median_spread_bps: number;
  std_spread_bps: number;
  p90_spread_bps: number;
  min_spread_bps: number;
  max_spread_bps: number;
}

/**
 * Cross-venue price comparison
 */
export interface CrossVenueSnapshot {
  timestamp: string;
  market_id: string;
  kalshi_price: number;
  polymarket_price: number;
  price_diff: number;
  price_diff_pct: number;
  
  // Fee-adjusted
  gross_profit_usd?: number;
  total_fees_usd?: number;
  net_profit_usd?: number;
  is_profitable?: boolean;
}

/**
 * Liquidity regime indicator output
 */
export interface LiquidityIndicator {
  timestamp: string;
  market_id: string;
  regime: LiquidityRegime;
  spread_bps: number;
  spread_zscore: number;
  volume_zscore: number;
  factors: {
    hour_factor: number;    // 0-1, higher = thinner liquidity expected
    dow_factor: number;     // 0-1, higher = thinner liquidity expected
    depth_factor: number;   // 0-1, higher = thinner liquidity
  };
  confidence: 'high' | 'medium' | 'low';
}

/**
 * Liquidity window annotation
 */
export interface LiquidityWindow {
  market_id: string;
  start_time: string;
  end_time: string;
  regime: LiquidityRegime;
  avg_spread_bps: number;
  trigger: 'late_night' | 'weekend' | 'holiday' | 'low_volume' | 'event_specific';
  
  // Fee-adjusted opportunity analysis
  opportunities_detected: number;
  opportunities_profitable: number;
  avg_net_profit_pct: number;
}

/**
 * Hypothesis test result
 */
export interface HypothesisResult {
  id: string;
  description: string;
  test_type: 't-test' | 'correlation' | 'comparison';
  group_a: string;
  group_b?: string;
  statistic: number;
  p_value: number;
  effect_size?: number;
  is_significant: boolean;  // p < 0.05
  conclusion: string;
}

/**
 * Opportunity with fee analysis
 */
export interface FeeAdjustedOpportunity {
  timestamp: string;
  market_id: string;
  liquidity_regime: LiquidityRegime;
  
  // Prices
  kalshi_price: number;
  polymarket_price: number;
  
  // Gross
  gross_spread_pct: number;
  size_usd: number;
  gross_profit_usd: number;
  
  // Fees (from replay-fee-oracle)
  kalshi_fee_usd: number;
  polymarket_fee_usd: number;
  total_fees_usd: number;
  
  // Net
  net_profit_usd: number;
  net_profit_pct: number;
  is_profitable: boolean;
  
  // Thresholds
  min_profitable_spread_pct: number;
}

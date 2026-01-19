/**
 * Spread Statistics Analysis
 * 
 * Computes spread statistics grouped by hour, day of week, and category.
 */

import type { SpreadDataPoint, SpreadStats, OrderbookSnapshot, MarketCategory } from '../types';

/**
 * Convert timestamp to EST hour (0-23)
 */
export function getHourEST(timestamp: string): number {
  const date = new Date(timestamp);
  // EST is UTC-5 (ignoring DST for simplicity)
  const utcHour = date.getUTCHours();
  const estHour = (utcHour - 5 + 24) % 24;
  return estHour;
}

/**
 * Get day of week (0=Sunday, 6=Saturday)
 */
export function getDayOfWeek(timestamp: string): number {
  return new Date(timestamp).getUTCDay();
}

/**
 * Check if timestamp is weekend
 */
export function isWeekend(timestamp: string): boolean {
  const dow = getDayOfWeek(timestamp);
  return dow === 0 || dow === 6;
}

/**
 * Convert orderbook snapshot to spread data point
 */
export function toSpreadDataPoint(
  snapshot: OrderbookSnapshot,
  marketId: string
): SpreadDataPoint {
  return {
    timestamp: snapshot.timestamp,
    market_id: marketId,
    spread_bps: snapshot.spread_bps,
    mid_price: snapshot.mid_price,
    bid_depth: snapshot.bid_depth,
    ask_depth: snapshot.ask_depth,
    hour_of_day: getHourEST(snapshot.timestamp),
    day_of_week: getDayOfWeek(snapshot.timestamp),
    is_weekend: isWeekend(snapshot.timestamp),
  };
}

/**
 * Compute statistics for a group of spread values
 */
export function computeStats(spreads: number[], groupKey: string): SpreadStats {
  if (spreads.length === 0) {
    return {
      group_key: groupKey,
      sample_count: 0,
      mean_spread_bps: 0,
      median_spread_bps: 0,
      std_spread_bps: 0,
      p90_spread_bps: 0,
      min_spread_bps: 0,
      max_spread_bps: 0,
    };
  }
  
  const sorted = [...spreads].sort((a, b) => a - b);
  const n = sorted.length;
  
  const mean = spreads.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 === 0
    ? ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2
    : (sorted[Math.floor(n / 2)] ?? 0);
  
  const variance = spreads.reduce((sum, x) => sum + (x - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  
  const p90Index = Math.floor(n * 0.9);
  const p90 = sorted[p90Index] ?? sorted[n - 1] ?? 0;
  
  return {
    group_key: groupKey,
    sample_count: n,
    mean_spread_bps: mean,
    median_spread_bps: median,
    std_spread_bps: std,
    p90_spread_bps: p90,
    min_spread_bps: sorted[0] ?? 0,
    max_spread_bps: sorted[n - 1] ?? 0,
  };
}

/**
 * Group spread data by hour of day
 */
export function groupByHour(data: SpreadDataPoint[]): Map<number, SpreadDataPoint[]> {
  const groups = new Map<number, SpreadDataPoint[]>();
  
  for (let h = 0; h < 24; h++) {
    groups.set(h, []);
  }
  
  for (const point of data) {
    const arr = groups.get(point.hour_of_day);
    if (arr) arr.push(point);
  }
  
  return groups;
}

/**
 * Group spread data by day of week
 */
export function groupByDayOfWeek(data: SpreadDataPoint[]): Map<number, SpreadDataPoint[]> {
  const groups = new Map<number, SpreadDataPoint[]>();
  
  for (let d = 0; d < 7; d++) {
    groups.set(d, []);
  }
  
  for (const point of data) {
    const arr = groups.get(point.day_of_week);
    if (arr) arr.push(point);
  }
  
  return groups;
}

/**
 * Compute spread stats by hour
 */
export function statsByHour(data: SpreadDataPoint[]): SpreadStats[] {
  const groups = groupByHour(data);
  const stats: SpreadStats[] = [];
  
  for (let h = 0; h < 24; h++) {
    const points = groups.get(h) ?? [];
    const spreads = points.map(p => p.spread_bps);
    stats.push(computeStats(spreads, `hour_${h.toString().padStart(2, '0')}`));
  }
  
  return stats;
}

/**
 * Compute spread stats by day of week
 */
export function statsByDayOfWeek(data: SpreadDataPoint[]): SpreadStats[] {
  const groups = groupByDayOfWeek(data);
  const dayNames = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const stats: SpreadStats[] = [];
  
  for (let d = 0; d < 7; d++) {
    const points = groups.get(d) ?? [];
    const spreads = points.map(p => p.spread_bps);
    stats.push(computeStats(spreads, `dow_${dayNames[d]}`));
  }
  
  return stats;
}

/**
 * Compute spread stats by weekend vs weekday
 */
export function statsByWeekendWeekday(data: SpreadDataPoint[]): { weekend: SpreadStats; weekday: SpreadStats } {
  const weekendSpreads = data.filter(p => p.is_weekend).map(p => p.spread_bps);
  const weekdaySpreads = data.filter(p => !p.is_weekend).map(p => p.spread_bps);
  
  return {
    weekend: computeStats(weekendSpreads, 'weekend'),
    weekday: computeStats(weekdaySpreads, 'weekday'),
  };
}

/**
 * Compute spread stats by market category
 */
export function statsByCategory(
  data: SpreadDataPoint[],
  marketCategories: Map<string, MarketCategory>
): Map<MarketCategory, SpreadStats> {
  const groups = new Map<MarketCategory, number[]>();
  
  for (const point of data) {
    const category = marketCategories.get(point.market_id) ?? 'other';
    if (!groups.has(category)) {
      groups.set(category, []);
    }
    groups.get(category)!.push(point.spread_bps);
  }
  
  const result = new Map<MarketCategory, SpreadStats>();
  for (const [category, spreads] of groups) {
    result.set(category, computeStats(spreads, `category_${category}`));
  }
  
  return result;
}

/**
 * Compute spread stats for late night (12am-6am EST) vs business hours (9am-5pm EST)
 */
export function statsLateNightVsBusinessHours(data: SpreadDataPoint[]): {
  late_night: SpreadStats;
  business_hours: SpreadStats;
} {
  const lateNightSpreads = data
    .filter(p => p.hour_of_day >= 0 && p.hour_of_day < 6)
    .map(p => p.spread_bps);
  
  const businessHoursSpreads = data
    .filter(p => p.hour_of_day >= 9 && p.hour_of_day < 17)
    .map(p => p.spread_bps);
  
  return {
    late_night: computeStats(lateNightSpreads, 'late_night_0am_6am'),
    business_hours: computeStats(businessHoursSpreads, 'business_hours_9am_5pm'),
  };
}

/**
 * Compute Z-score for a spread value given historical data
 */
export function computeZScore(value: number, mean: number, std: number): number {
  if (std === 0) return 0;
  return (value - mean) / std;
}

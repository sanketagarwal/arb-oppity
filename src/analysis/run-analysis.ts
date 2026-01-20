#!/usr/bin/env npx tsx
/**
 * Spread Analysis Runner
 * 
 * Fetches historical data from Replay Labs API and analyzes:
 * 1. Spread patterns by hour-of-day
 * 2. Spread patterns by day-of-week
 * 3. Cross-venue price differences (Kalshi vs Polymarket)
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEPLOYMENT_URL = 'https://replay-lab.preview.recall.network';
const API_KEY = process.env.REPLAY_LABS_API_KEY || 'rn_JOMhskPDoihvsPkVTawOFLHeUfPgLLTxutXYIBMyKrIfrLChqtSFMvSsjiVdxLyj';

const RESULTS_DIR = path.join(__dirname, '../../results');
const DAYS_BACK = 30;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface SemanticSearchResult {
  venue: 'KALSHI' | 'POLYMARKET';
  id: string;
  question: string;
  isOpen: boolean;
  similarity?: number;
}

interface MarketPair {
  question: string;
  kalshi_id: string;
  polymarket_id: string;
  similarity: number;
}

interface KalshiCandlestick {
  end_period_ts: number;
  yes_bid: { close: number | null; close_dollars: string | null };
  yes_ask: { close: number | null; close_dollars: string | null };
  volume: number;
}

interface SpreadDataPoint {
  timestamp: Date;
  hour: number;  // 0-23 EST
  dayOfWeek: number;  // 0=Sun, 6=Sat
  dayName: string;
  kalshi_mid?: number;
  kalshi_spread?: number;
  polymarket_mid?: number;
  polymarket_spread?: number;
  cross_venue_diff?: number;  // |kalshi - polymarket|
}

interface HourlyStats {
  hour: number;
  count: number;
  avg_kalshi_spread: number;
  avg_polymarket_spread: number;
  avg_cross_venue_diff: number;
  max_cross_venue_diff: number;
}

interface DailyStats {
  dayOfWeek: number;
  dayName: string;
  count: number;
  avg_kalshi_spread: number;
  avg_polymarket_spread: number;
  avg_cross_venue_diff: number;
  max_cross_venue_diff: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// API HELPERS
// ═══════════════════════════════════════════════════════════════════════════

async function apiFetch<T>(endpoint: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(endpoint, BASE_URL);
  if (params) {
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  }
  
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-api-key': API_KEY!,
  };
  
  console.log(`  → GET ${url.pathname}${url.search}`);
  
  const res = await fetch(url.toString(), { headers });
  
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  
  return res.json();
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: FIND MATCHING MARKETS
// ═══════════════════════════════════════════════════════════════════════════

const SEARCH_QUERIES = [
  'Trump win president 2024',
  'Federal Reserve interest rate cut',
  'Bitcoin price 100k',
  'SpaceX Starship launch',
  'AI regulation bill pass',
  'Tesla stock price',
  'Democrat win senate',
  'Recession 2024',
  'OpenAI GPT-5',
  'Ukraine war end',
];

async function findMatchingMarkets(): Promise<MarketPair[]> {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('STEP 1: Finding matching markets (semantic search)');
  console.log('════════════════════════════════════════════════════════════\n');
  
  const pairs: MarketPair[] = [];
  
  for (const query of SEARCH_QUERIES) {
    console.log(`\nSearching: "${query}"`);
    
    try {
      const results = await apiFetch<SemanticSearchResult[]>(
        '/api/markets/semantic-search',
        { q: query, limit: '10' }
      );
      
      // Group by venue
      const kalshiResults = results.filter(r => r.venue === 'KALSHI' && r.isOpen);
      const polyResults = results.filter(r => r.venue === 'POLYMARKET' && r.isOpen);
      
      console.log(`  Found: ${kalshiResults.length} Kalshi, ${polyResults.length} Polymarket`);
      
      // Match by similarity (take top result from each)
      if (kalshiResults.length > 0 && polyResults.length > 0) {
        const kalshi = kalshiResults[0];
        const poly = polyResults[0];
        
        pairs.push({
          question: query,
          kalshi_id: kalshi.id,
          polymarket_id: poly.id,
          similarity: (kalshi.similarity ?? 0 + (poly.similarity ?? 0)) / 2,
        });
        
        console.log(`  ✓ Matched: Kalshi=${kalshi.id.slice(0, 30)}... ↔ Polymarket=${poly.id.slice(0, 30)}...`);
      }
    } catch (err: any) {
      console.log(`  ✗ Error: ${err.message}`);
    }
    
    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`\n→ Found ${pairs.length} market pairs`);
  return pairs;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: FETCH HISTORICAL DATA
// ═══════════════════════════════════════════════════════════════════════════

async function fetchKalshiHistory(ticker: string, startTs: number, endTs: number): Promise<KalshiCandlestick[]> {
  try {
    const response = await apiFetch<{ candlesticks: Record<string, KalshiCandlestick[]> }>(
      '/api/kalshi/markets/candlesticks',
      {
        market_tickers: ticker,
        start_ts: startTs.toString(),
        end_ts: endTs.toString(),
        period_interval: '60', // 1 hour
      }
    );
    
    return response.candlesticks[ticker] ?? [];
  } catch (err: any) {
    console.log(`    ✗ Kalshi error: ${err.message}`);
    return [];
  }
}

interface PolymarketPricePoint {
  t: number;  // timestamp
  p: number;  // price (0-1)
}

async function fetchPolymarketHistory(tokenId: string, startTs: number, endTs: number): Promise<PolymarketPricePoint[]> {
  try {
    const response = await apiFetch<{ history: PolymarketPricePoint[] }>(
      '/api/polymarket/clob/prices-history',
      {
        market: tokenId,
        startTs: startTs.toString(),
        endTs: endTs.toString(),
        interval: '1h',
      }
    );
    
    return response.history ?? [];
  } catch (err: any) {
    console.log(`    ✗ Polymarket error: ${err.message}`);
    return [];
  }
}

async function fetchHistoricalData(pairs: MarketPair[]): Promise<Map<string, SpreadDataPoint[]>> {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('STEP 2: Fetching historical data (30 days)');
  console.log('════════════════════════════════════════════════════════════\n');
  
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - (DAYS_BACK * 24 * 60 * 60);
  
  const dataByPair = new Map<string, SpreadDataPoint[]>();
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  for (const pair of pairs) {
    console.log(`\nFetching: "${pair.question}"`);
    
    const kalshiCandles = await fetchKalshiHistory(pair.kalshi_id, startTs, endTs);
    console.log(`  Kalshi: ${kalshiCandles.length} candles`);
    
    await new Promise(r => setTimeout(r, 100));
    
    const polyPrices = await fetchPolymarketHistory(pair.polymarket_id, startTs, endTs);
    console.log(`  Polymarket: ${polyPrices.length} price points`);
    
    // Merge data by timestamp (hourly alignment)
    const dataPoints: SpreadDataPoint[] = [];
    
    // Create a map of Polymarket prices by hour
    const polyByHour = new Map<number, number>();
    for (const p of polyPrices) {
      const hourKey = Math.floor(p.t / 3600) * 3600;
      polyByHour.set(hourKey, p.p);
    }
    
    // Combine with Kalshi data
    for (const candle of kalshiCandles) {
      const ts = candle.end_period_ts;
      const hourKey = Math.floor(ts / 3600) * 3600;
      const date = new Date(ts * 1000);
      
      // Convert to EST (UTC-5)
      const estDate = new Date(date.getTime() - 5 * 60 * 60 * 1000);
      const hour = estDate.getUTCHours();
      const dow = estDate.getUTCDay();
      
      // Kalshi prices are in cents (0-100), convert to 0-1
      const kalshiBid = candle.yes_bid.close !== null ? candle.yes_bid.close / 100 : undefined;
      const kalshiAsk = candle.yes_ask.close !== null ? candle.yes_ask.close / 100 : undefined;
      
      const kalshiMid = kalshiBid !== undefined && kalshiAsk !== undefined
        ? (kalshiBid + kalshiAsk) / 2
        : undefined;
      const kalshiSpread = kalshiBid !== undefined && kalshiAsk !== undefined
        ? kalshiAsk - kalshiBid
        : undefined;
      
      const polyPrice = polyByHour.get(hourKey);
      
      // Cross-venue difference (if both have data)
      const crossVenueDiff = kalshiMid !== undefined && polyPrice !== undefined
        ? Math.abs(kalshiMid - polyPrice)
        : undefined;
      
      dataPoints.push({
        timestamp: date,
        hour,
        dayOfWeek: dow,
        dayName: dayNames[dow],
        kalshi_mid: kalshiMid,
        kalshi_spread: kalshiSpread,
        polymarket_mid: polyPrice,
        cross_venue_diff: crossVenueDiff,
      });
    }
    
    dataByPair.set(pair.question, dataPoints);
    console.log(`  Combined: ${dataPoints.length} data points`);
    
    await new Promise(r => setTimeout(r, 200));
  }
  
  return dataByPair;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: COMPUTE STATISTICS
// ═══════════════════════════════════════════════════════════════════════════

function computeStats(allData: SpreadDataPoint[]): { hourly: HourlyStats[]; daily: DailyStats[] } {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  
  // Group by hour
  const byHour: Map<number, SpreadDataPoint[]> = new Map();
  for (let h = 0; h < 24; h++) byHour.set(h, []);
  
  // Group by day
  const byDay: Map<number, SpreadDataPoint[]> = new Map();
  for (let d = 0; d < 7; d++) byDay.set(d, []);
  
  for (const dp of allData) {
    byHour.get(dp.hour)!.push(dp);
    byDay.get(dp.dayOfWeek)!.push(dp);
  }
  
  // Compute hourly stats
  const hourly: HourlyStats[] = [];
  for (let h = 0; h < 24; h++) {
    const points = byHour.get(h)!;
    const kalshiSpreads = points.filter(p => p.kalshi_spread !== undefined).map(p => p.kalshi_spread!);
    const crossDiffs = points.filter(p => p.cross_venue_diff !== undefined).map(p => p.cross_venue_diff!);
    
    hourly.push({
      hour: h,
      count: points.length,
      avg_kalshi_spread: kalshiSpreads.length > 0 ? avg(kalshiSpreads) : 0,
      avg_polymarket_spread: 0, // Polymarket doesn't have orderbook spread in history
      avg_cross_venue_diff: crossDiffs.length > 0 ? avg(crossDiffs) : 0,
      max_cross_venue_diff: crossDiffs.length > 0 ? Math.max(...crossDiffs) : 0,
    });
  }
  
  // Compute daily stats
  const daily: DailyStats[] = [];
  for (let d = 0; d < 7; d++) {
    const points = byDay.get(d)!;
    const kalshiSpreads = points.filter(p => p.kalshi_spread !== undefined).map(p => p.kalshi_spread!);
    const crossDiffs = points.filter(p => p.cross_venue_diff !== undefined).map(p => p.cross_venue_diff!);
    
    daily.push({
      dayOfWeek: d,
      dayName: dayNames[d],
      count: points.length,
      avg_kalshi_spread: kalshiSpreads.length > 0 ? avg(kalshiSpreads) : 0,
      avg_polymarket_spread: 0,
      avg_cross_venue_diff: crossDiffs.length > 0 ? avg(crossDiffs) : 0,
      max_cross_venue_diff: crossDiffs.length > 0 ? Math.max(...crossDiffs) : 0,
    });
  }
  
  return { hourly, daily };
}

function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4: OUTPUT RESULTS
// ═══════════════════════════════════════════════════════════════════════════

function printResults(hourly: HourlyStats[], daily: DailyStats[]) {
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('RESULTS: Spread Patterns (30 days)');
  console.log('════════════════════════════════════════════════════════════\n');
  
  // Compute overall average for comparison
  const overallAvgCrossVenue = avg(hourly.filter(h => h.count > 0).map(h => h.avg_cross_venue_diff));
  const overallAvgKalshiSpread = avg(hourly.filter(h => h.count > 0).map(h => h.avg_kalshi_spread));
  
  console.log('📊 HOURLY PATTERNS (EST)\n');
  console.log('Hour │ Samples │ Kalshi Spread │ Cross-Venue Diff │ vs Avg');
  console.log('─────┼─────────┼───────────────┼──────────────────┼────────');
  
  for (const h of hourly) {
    const vsAvg = overallAvgCrossVenue > 0 
      ? ((h.avg_cross_venue_diff - overallAvgCrossVenue) / overallAvgCrossVenue * 100).toFixed(0)
      : '0';
    const vsAvgStr = Number(vsAvg) > 0 ? `+${vsAvg}%` : `${vsAvg}%`;
    const highlight = Number(vsAvg) > 30 ? ' ← WIDE' : '';
    
    console.log(
      `${h.hour.toString().padStart(4)}h │ ${h.count.toString().padStart(7)} │ ` +
      `${(h.avg_kalshi_spread * 100).toFixed(2)}%`.padStart(13) + ' │ ' +
      `${(h.avg_cross_venue_diff * 100).toFixed(2)}%`.padStart(16) + ' │ ' +
      vsAvgStr.padStart(6) + highlight
    );
  }
  
  console.log('\n📅 DAILY PATTERNS\n');
  console.log('Day │ Samples │ Kalshi Spread │ Cross-Venue Diff │ vs Avg');
  console.log('────┼─────────┼───────────────┼──────────────────┼────────');
  
  for (const d of daily) {
    const vsAvg = overallAvgCrossVenue > 0
      ? ((d.avg_cross_venue_diff - overallAvgCrossVenue) / overallAvgCrossVenue * 100).toFixed(0)
      : '0';
    const vsAvgStr = Number(vsAvg) > 0 ? `+${vsAvg}%` : `${vsAvg}%`;
    const highlight = Number(vsAvg) > 20 ? ' ← WIDE' : '';
    
    console.log(
      `${d.dayName} │ ${d.count.toString().padStart(7)} │ ` +
      `${(d.avg_kalshi_spread * 100).toFixed(2)}%`.padStart(13) + ' │ ' +
      `${(d.avg_cross_venue_diff * 100).toFixed(2)}%`.padStart(16) + ' │ ' +
      vsAvgStr.padStart(6) + highlight
    );
  }
  
  // Find best hours/days
  const sortedHours = [...hourly].filter(h => h.count > 0).sort((a, b) => b.avg_cross_venue_diff - a.avg_cross_venue_diff);
  const sortedDays = [...daily].filter(d => d.count > 0).sort((a, b) => b.avg_cross_venue_diff - a.avg_cross_venue_diff);
  
  console.log('\n════════════════════════════════════════════════════════════');
  console.log('💡 RECOMMENDATIONS');
  console.log('════════════════════════════════════════════════════════════\n');
  
  if (sortedHours.length >= 3) {
    const topHours = sortedHours.slice(0, 5);
    console.log('Best hours for arb opportunities (EST):');
    topHours.forEach(h => {
      const pct = overallAvgCrossVenue > 0 
        ? ((h.avg_cross_venue_diff - overallAvgCrossVenue) / overallAvgCrossVenue * 100).toFixed(0)
        : '0';
      console.log(`  ${h.hour}:00 - ${h.hour + 1}:00  (${h.avg_cross_venue_diff * 100 > 0.1 ? '+' : ''}${pct}% wider than avg)`);
    });
  }
  
  if (sortedDays.length >= 2) {
    const topDays = sortedDays.slice(0, 3);
    console.log('\nBest days for arb opportunities:');
    topDays.forEach(d => {
      const pct = overallAvgCrossVenue > 0
        ? ((d.avg_cross_venue_diff - overallAvgCrossVenue) / overallAvgCrossVenue * 100).toFixed(0)
        : '0';
      console.log(`  ${d.dayName}  (${Number(pct) > 0 ? '+' : ''}${pct}% wider than avg)`);
    });
  }
  
  console.log('\n════════════════════════════════════════════════════════════\n');
}

function saveResults(pairs: MarketPair[], hourly: HourlyStats[], daily: DailyStats[]) {
  // Ensure results directory exists
  if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
  }
  
  const output = {
    generated_at: new Date().toISOString(),
    days_analyzed: DAYS_BACK,
    market_pairs: pairs,
    hourly_stats: hourly,
    daily_stats: daily,
    recommendations: {
      best_hours_est: hourly
        .filter(h => h.count > 0)
        .sort((a, b) => b.avg_cross_venue_diff - a.avg_cross_venue_diff)
        .slice(0, 5)
        .map(h => h.hour),
      best_days: daily
        .filter(d => d.count > 0)
        .sort((a, b) => b.avg_cross_venue_diff - a.avg_cross_venue_diff)
        .slice(0, 3)
        .map(d => d.dayName),
    },
  };
  
  const outputPath = path.join(RESULTS_DIR, 'spread_analysis.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`Results saved to: ${outputPath}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║  ARB-OPPITY: Cross-Venue Spread Analysis                 ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`API: ${BASE_URL}`);
  console.log(`Period: Last ${DAYS_BACK} days\n`);
  
  // Step 1: Find matching markets
  const pairs = await findMatchingMarkets();
  
  if (pairs.length === 0) {
    console.log('\n❌ No matching market pairs found. Cannot proceed.');
    process.exit(1);
  }
  
  // Step 2: Fetch historical data
  const dataByPair = await fetchHistoricalData(pairs);
  
  // Merge all data points
  const allData: SpreadDataPoint[] = [];
  for (const points of dataByPair.values()) {
    allData.push(...points);
  }
  
  if (allData.length === 0) {
    console.log('\n❌ No historical data retrieved. Check API access.');
    process.exit(1);
  }
  
  console.log(`\nTotal data points: ${allData.length}`);
  
  // Step 3: Compute statistics
  const { hourly, daily } = computeStats(allData);
  
  // Step 4: Output results
  printResults(hourly, daily);
  saveResults(pairs, hourly, daily);
  
  console.log('✅ Analysis complete!\n');
}

main().catch(err => {
  console.error('\n❌ Error:', err.message);
  process.exit(1);
});

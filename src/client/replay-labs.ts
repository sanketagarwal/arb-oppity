/**
 * Replay Labs API Client
 * 
 * Fetches market data from Kalshi and Polymarket via Replay Labs API.
 */

import type { OrderbookSnapshot, Market, MarketCategory } from '../types';

const BASE_URL = process.env.REPLAY_LABS_API_URL || 'https://api.replay.labs';

interface KalshiMarketResponse {
  ticker: string;
  title: string;
  category: string;
  volume_24h: number;
  open_time: string;
  close_time?: string;
  status: string;
}

interface KalshiOrderbookResponse {
  yes: { price: number; quantity: number }[];
  no: { price: number; quantity: number }[];
}

interface OHLCVCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class ReplayLabsClient {
  private baseUrl: string;
  private apiKey?: string;
  
  constructor(config?: { baseUrl?: string; apiKey?: string }) {
    this.baseUrl = config?.baseUrl || BASE_URL;
    this.apiKey = config?.apiKey || process.env.REPLAY_LABS_API_KEY;
  }
  
  private async fetch<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });
    }
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }
    
    const response = await fetch(url.toString(), { headers });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status} ${response.statusText}`);
    }
    
    return response.json() as Promise<T>;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // KALSHI ENDPOINTS
  // ═══════════════════════════════════════════════════════════════
  
  /**
   * Get list of Kalshi markets
   */
  async getKalshiMarkets(params?: {
    status?: 'open' | 'closed' | 'settled';
    category?: string;
    limit?: number;
  }): Promise<Market[]> {
    const queryParams: Record<string, string> = {};
    if (params?.status) queryParams['status'] = params.status;
    if (params?.category) queryParams['category'] = params.category;
    if (params?.limit) queryParams['limit'] = params.limit.toString();
    
    const response = await this.fetch<{ markets: KalshiMarketResponse[] }>(
      '/api/kalshi/markets',
      queryParams
    );
    
    return response.markets.map(m => this.mapKalshiMarket(m));
  }
  
  /**
   * Get single Kalshi market
   */
  async getKalshiMarket(ticker: string): Promise<Market> {
    const response = await this.fetch<KalshiMarketResponse>(
      `/api/kalshi/markets/${ticker}`
    );
    return this.mapKalshiMarket(response);
  }
  
  /**
   * Get Kalshi orderbook
   */
  async getKalshiOrderbook(ticker: string): Promise<OrderbookSnapshot> {
    const response = await this.fetch<KalshiOrderbookResponse>(
      `/api/kalshi/markets/${ticker}/orderbook`
    );
    
    return this.parseKalshiOrderbook(response);
  }
  
  /**
   * Get Kalshi candlesticks (OHLCV)
   */
  async getKalshiCandlesticks(
    seriesTicker: string,
    ticker: string,
    params: {
      period: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
      start_ts?: number;
      end_ts?: number;
    }
  ): Promise<OHLCVCandle[]> {
    const queryParams: Record<string, string> = {
      period: params.period,
    };
    if (params.start_ts) queryParams['start_ts'] = params.start_ts.toString();
    if (params.end_ts) queryParams['end_ts'] = params.end_ts.toString();
    
    const response = await this.fetch<{ candlesticks: OHLCVCandle[] }>(
      `/api/kalshi/series/${seriesTicker}/markets/${ticker}/candlesticks`,
      queryParams
    );
    
    return response.candlesticks;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // ORDERBOOK HISTORICAL (Generic)
  // ═══════════════════════════════════════════════════════════════
  
  /**
   * Get historical orderbook snapshots
   */
  async getOrderbookHistory(
    symbolId: string,
    params?: {
      start?: string;
      end?: string;
      interval?: string;
    }
  ): Promise<OrderbookSnapshot[]> {
    const queryParams: Record<string, string> = {};
    if (params?.start) queryParams['start'] = params.start;
    if (params?.end) queryParams['end'] = params.end;
    if (params?.interval) queryParams['interval'] = params.interval;
    
    const response = await this.fetch<{ snapshots: OrderbookSnapshot[] }>(
      `/api/orderbook/${symbolId}`,
      queryParams
    );
    
    return response.snapshots;
  }
  
  // ═══════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════
  
  private mapKalshiMarket(m: KalshiMarketResponse): Market {
    return {
      id: m.ticker,
      ticker: m.ticker,
      title: m.title,
      category: this.mapCategory(m.category),
      volume_24h_usd: m.volume_24h,
      created_at: m.open_time,
      closes_at: m.close_time,
    };
  }
  
  private mapCategory(category: string): MarketCategory {
    const lower = category.toLowerCase();
    if (lower.includes('politic')) return 'politics';
    if (lower.includes('sport') || lower.includes('nba') || lower.includes('nfl')) return 'sports';
    if (lower.includes('crypto') || lower.includes('bitcoin') || lower.includes('eth')) return 'crypto';
    if (lower.includes('econ') || lower.includes('fed') || lower.includes('rate')) return 'economics';
    if (lower.includes('weather') || lower.includes('climate')) return 'weather';
    return 'other';
  }
  
  private parseKalshiOrderbook(response: KalshiOrderbookResponse): OrderbookSnapshot {
    // Calculate best bid/ask from yes side
    // Kalshi: yes price + no price = 1, so bid = 1 - best_no_ask, ask = best_yes_ask
    const yesBids = response.yes.filter(l => l.quantity > 0).sort((a, b) => b.price - a.price);
    const yesAsks = response.yes.filter(l => l.quantity > 0).sort((a, b) => a.price - b.price);
    
    const bestBid = yesBids[0]?.price ?? 0;
    const bestAsk = yesAsks[0]?.price ?? 1;
    
    const midPrice = (bestBid + bestAsk) / 2;
    const spread = bestAsk - bestBid;
    const spreadBps = midPrice > 0 ? (spread / midPrice) * 10000 : 0;
    
    const bidDepth = yesBids.reduce((sum, l) => sum + l.quantity, 0);
    const askDepth = yesAsks.reduce((sum, l) => sum + l.quantity, 0);
    const totalDepth = bidDepth + askDepth;
    const imbalance = totalDepth > 0 ? (bidDepth - askDepth) / totalDepth : 0;
    
    return {
      timestamp: new Date().toISOString(),
      mid_price: midPrice,
      spread,
      spread_bps: spreadBps,
      imbalance,
      bid_depth: bidDepth,
      ask_depth: askDepth,
    };
  }
}

// Singleton instance
let clientInstance: ReplayLabsClient | null = null;

export function getClient(config?: { baseUrl?: string; apiKey?: string }): ReplayLabsClient {
  if (!clientInstance) {
    clientInstance = new ReplayLabsClient(config);
  }
  return clientInstance;
}

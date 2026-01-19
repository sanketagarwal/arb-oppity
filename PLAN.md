# arb-oppity: Liquidity Timing Extension for Replay Labs

## Overview

**This is an extension to Replay Labs**, not a standalone project. It adds:
1. A `liquidity_regime` indicator for the `/api/indicators/` system
2. A `liquidity_window` annotation type for agent evaluation
3. Agent tools for cross-venue arbitrage execution

---

## What Replay Labs Already Provides

### Polymarket Data
```bash
# Get spreads for multiple tokens
POST /api/polymarket/clob/spreads
[{ "token_id": "0x123..." }, { "token_id": "0x456..." }]

# Get orderbook
GET /api/polymarket/clob/book?token_id=0x123...

# Get price history
GET /api/polymarket/clob/prices-history?token_id=0x123...&interval=1h
```

### Kalshi Data
```bash
# Get orderbook
GET /api/kalshi/markets/{ticker}/orderbook

# Get candlesticks
GET /api/kalshi/series/{series}/markets/{ticker}/candlesticks?period=1h

# Get market list
GET /api/kalshi/markets?status=open
```

### Indicators System
```bash
# Get candles + indicators
GET /api/indicators/COINBASE_SPOT_BTC_USD?limit=50

# Returns: candles, bbw, rsi, macd, stoch_rsi, supertrend, vwap
```

### Annotations System
```bash
# Get ground truth for agent scoring
GET /api/annotations/COINBASE_SPOT_BTC_USD?type=dump_event

# Compute on-demand
POST /api/annotations/COINBASE_SPOT_BTC_USD/compute
{ "type": "dump_event", "method": "simple-threshold", "params": {...} }
```

---

## What We're Adding

### 1. `liquidity_regime` Indicator

**Spec for Replay Labs indicator system:**

```typescript
// Indicator Definition
const liquidityRegimeIndicator = {
  type: 'liquidity_regime',
  inputs: ['spread_bps', 'bid_depth', 'ask_depth', 'hour_of_day', 'day_of_week'],
  outputs: {
    regime: 'thick' | 'normal' | 'thin' | 'very_thin',
    spread_zscore: number,
    depth_zscore: number,
    time_factor: number,  // 0-1, higher = expected thinner liquidity
    confidence: 'high' | 'medium' | 'low',
  },
  params: {
    lookback_hours: 168,  // 7 days for z-score baseline
    thin_threshold_zscore: 1.5,
    very_thin_threshold_zscore: 2.5,
  }
};
```

**Example output:**
```json
{
  "symbol_id": "KALSHI_TRUMP_2024",
  "timestamp": "2026-01-19T03:00:00Z",
  "indicators": {
    "liquidity_regime": {
      "regime": "thin",
      "spread_zscore": 1.8,
      "depth_zscore": -1.2,
      "time_factor": 0.7,
      "confidence": "high"
    }
  }
}
```

### 2. `liquidity_window` Annotation

**Spec for Replay Labs annotation system:**

```typescript
// Annotation Definition (EventSpec pattern)
const liquidityWindowAnnotator = buildEventSpec({
  type: 'liquidity_window',
  method: 'regime-transition',
  candleTimeframe: '15m',
  params: {
    min_duration_minutes: 30,
    regime_threshold: 'thin',  // or 'very_thin'
  },
  hindsight: '0m',  // No hindsight needed - based on current spread
});
```

**Example annotation:**
```json
{
  "type": "liquidity_window",
  "method": "regime-transition",
  "symbol_id": "KALSHI_TRUMP_2024",
  "start_time": "2026-01-19T02:00:00Z",
  "end_time": "2026-01-19T06:00:00Z",
  "data": {
    "regime": "thin",
    "trigger": "late_night",
    "avg_spread_bps": 420,
    "opportunities_count": 3
  }
}
```

### 3. Agent Tools

**For an agent (e.g., Mastra) to execute on this:**

```typescript
// Tool: Check Liquidity Regime
const checkLiquidityTool = createTool({
  id: 'check-liquidity-regime',
  description: 'Check current liquidity regime for a prediction market',
  inputSchema: z.object({
    market_id: z.string().describe('Kalshi ticker or Polymarket condition ID'),
    venue: z.enum(['KALSHI', 'POLYMARKET']),
  }),
  outputSchema: z.object({
    regime: z.enum(['thick', 'normal', 'thin', 'very_thin']),
    spread_bps: z.number(),
    is_favorable: z.boolean().describe('True if regime is thin/very_thin'),
    recommendation: z.string(),
  }),
  execute: async ({ context }) => {
    // Fetch from Replay Labs indicator endpoint
    const indicator = await replayLabs.getIndicator(context.market_id, 'liquidity_regime');
    return {
      regime: indicator.regime,
      spread_bps: indicator.spread_bps,
      is_favorable: ['thin', 'very_thin'].includes(indicator.regime),
      recommendation: indicator.regime === 'thin' 
        ? 'Good time for arb - spreads are wide'
        : 'Normal liquidity - wait for better entry',
    };
  },
});

// Tool: Analyze Cross-Venue Arbitrage
const analyzeArbTool = createTool({
  id: 'analyze-cross-venue-arb',
  description: 'Analyze if cross-venue arb is profitable after fees',
  inputSchema: z.object({
    kalshi_ticker: z.string(),
    polymarket_condition_id: z.string(),
    size_usd: z.number().default(1000),
  }),
  outputSchema: z.object({
    kalshi_price: z.number(),
    polymarket_price: z.number(),
    gross_spread_pct: z.number(),
    total_fees_usd: z.number(),
    net_profit_usd: z.number(),
    is_profitable: z.boolean(),
    action: z.enum(['EXECUTE', 'SKIP', 'WAIT']),
    reason: z.string(),
  }),
  execute: async ({ context }) => {
    // 1. Get prices from Replay Labs
    const kalshiBook = await replayLabs.getKalshiOrderbook(context.kalshi_ticker);
    const polyBook = await replayLabs.getPolymarketBook(context.polymarket_condition_id);
    
    // 2. Calculate spread
    const kalshiPrice = kalshiBook.mid_price;
    const polymarketPrice = polyBook.mid_price;
    const grossSpreadPct = Math.abs(kalshiPrice - polymarketPrice) * 100;
    
    // 3. Check fees via replay-fee-oracle
    const oracle = getOracle();
    const analysis = await oracle.analyzeArbitrage([
      { venue: 'KALSHI', direction: 'BUY', size_usd: context.size_usd, price: Math.min(kalshiPrice, polymarketPrice) },
      { venue: 'POLYMARKET', direction: 'SELL', size_usd: context.size_usd, price: Math.max(kalshiPrice, polymarketPrice) },
    ], context.size_usd * grossSpreadPct / 100);
    
    // 4. Decision
    let action: 'EXECUTE' | 'SKIP' | 'WAIT';
    let reason: string;
    
    if (analysis.is_profitable && grossSpreadPct > 3) {
      action = 'EXECUTE';
      reason = `Profitable arb: ${grossSpreadPct.toFixed(1)}% spread, $${analysis.net_profit_usd.toFixed(2)} net`;
    } else if (grossSpreadPct > 1.5) {
      action = 'WAIT';
      reason = `Borderline: ${grossSpreadPct.toFixed(1)}% spread, wait for wider`;
    } else {
      action = 'SKIP';
      reason = `Not profitable: ${grossSpreadPct.toFixed(1)}% spread < fees`;
    }
    
    return {
      kalshi_price: kalshiPrice,
      polymarket_price: polymarketPrice,
      gross_spread_pct: grossSpreadPct,
      total_fees_usd: analysis.total_fees_usd,
      net_profit_usd: analysis.net_profit_usd,
      is_profitable: analysis.is_profitable,
      action,
      reason,
    };
  },
});

// Tool: Get Active Liquidity Windows
const getLiquidityWindowsTool = createTool({
  id: 'get-liquidity-windows',
  description: 'Get historical thin liquidity windows for backtesting or pattern analysis',
  inputSchema: z.object({
    market_id: z.string(),
    from: z.string().describe('ISO timestamp'),
    to: z.string().describe('ISO timestamp'),
  }),
  outputSchema: z.array(z.object({
    start_time: z.string(),
    end_time: z.string(),
    regime: z.string(),
    avg_spread_bps: z.number(),
    trigger: z.string(),
  })),
  execute: async ({ context }) => {
    // Fetch from Replay Labs annotations endpoint
    const annotations = await replayLabs.getAnnotations(context.market_id, {
      type: 'liquidity_window',
      from: context.from,
      to: context.to,
    });
    return annotations;
  },
});
```

---

## Agent Workflow

```
┌─────────────────────────────────────────────────────────────────┐
│                     AGENT DECISION LOOP                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. CHECK LIQUIDITY REGIME                                      │
│     └─> GET /api/indicators/{market}?type=liquidity_regime      │
│         └─> regime: "thin" ✓                                    │
│                                                                 │
│  2. GET CROSS-VENUE PRICES                                      │
│     ├─> GET /api/kalshi/markets/{ticker}/orderbook              │
│     └─> POST /api/polymarket/clob/spreads                       │
│         └─> Kalshi: 0.52, Polymarket: 0.58 (6% spread)          │
│                                                                 │
│  3. VALIDATE WITH FEE ORACLE                                    │
│     └─> oracle.analyzeArbitrage([...])                          │
│         └─> Net profit: $23.49 ✓                                │
│                                                                 │
│  4. EXECUTE OR SKIP                                             │
│     └─> is_profitable: true → EXECUTE                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Analysis (understand the data)

Use existing Replay Labs endpoints to:
1. Fetch Kalshi orderbook data for 50+ markets
2. Fetch Polymarket spreads for matching markets
3. Compute spread statistics by hour/dow/category
4. Validate hypotheses H1-H6

**Output:** `results/spread_analysis.json` with thresholds for indicator

### Phase 2: Indicator Spec

Write the `liquidity_regime` indicator specification:
1. Define computation logic
2. Define thresholds from Phase 1 analysis
3. Document for Replay Labs integration

**Output:** `specs/liquidity_regime_indicator.ts`

### Phase 3: Annotation Spec

Write the `liquidity_window` annotation specification:
1. Define window detection logic
2. Include fee-adjusted opportunity count
3. Document for Replay Labs integration

**Output:** `specs/liquidity_window_annotator.ts`

### Phase 4: Agent Tools

Create Mastra-compatible tools:
1. `check-liquidity-regime` - Query indicator
2. `analyze-cross-venue-arb` - Full analysis with fees
3. `get-liquidity-windows` - Historical windows

**Output:** `src/tools/` ready for agent integration

---

## Project Structure

```
arb-oppity/
├── src/
│   ├── tools/                      # Agent tools (Mastra-compatible)
│   │   ├── check-liquidity.ts
│   │   ├── analyze-arb.ts
│   │   └── index.ts
│   ├── specs/                      # Replay Labs extension specs
│   │   ├── liquidity-regime-indicator.ts
│   │   └── liquidity-window-annotator.ts
│   └── index.ts
├── scripts/
│   ├── analyze-spreads.ts          # Phase 1 analysis
│   └── validate-hypotheses.ts
├── results/
│   └── spread_analysis.json
├── package.json
└── PLAN.md
```

---

## Dependencies

```json
{
  "dependencies": {
    "replay-fee-oracle": "file:../replay-fee-oracle",
    "@mastra/core": "^0.1.0",
    "zod": "^3.0.0"
  }
}
```

---

## Success Criteria

1. **Indicator works:** `liquidity_regime` correctly identifies thin liquidity periods
2. **Agent can use it:** Tools are callable from Mastra agent
3. **Fee-aware decisions:** Agent only executes profitable arbs after fees
4. **Replay Labs compatible:** Specs ready for integration into Replay Labs codebase

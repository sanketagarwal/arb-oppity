# Liquidity Timing Signal — Replay Labs API Contribution

## Philosophy

This is **not** an agent — it's a **signal layer** for the Replay Labs API. Any agent (Mastra, LangChain, custom) can consume these indicators and annotations. We're building infrastructure, not a trading bot.

---

## Overview

Build indicators and annotations that identify when prediction market spreads are historically wide (thin liquidity windows). This enables:
- Entry when spreads are fat
- Exit when liquidity returns
- Any downstream agent/bot can consume this signal

---

## V1: Analysis + Indicator + Annotations

### Phase 1: Pattern Discovery

**Goal:** Validate that thin liquidity patterns exist and quantify them.

#### Market Selection (Reasoning)

**Criteria for "good" markets to analyze:**

| Criterion | Why It Matters |
|-----------|----------------|
| **Volume** | Need enough trades to have meaningful spread data; low-volume markets have noisy spreads |
| **Longevity** | Markets that have been open 30+ days give us enough historical data |
| **Category diversity** | Different categories (sports, politics, crypto) may have different patterns |
| **Active order book** | Markets with consistent bid/ask activity, not stale books |

**Selection approach:**

```typescript
// Query Kalshi for markets matching criteria
const marketFilter = {
  status: 'open',
  min_volume_24h: 1000,          // At least $1k daily volume
  min_open_interest: 5000,       // Meaningful position sizes
  min_age_days: 30,              // Enough history
  categories: ['politics', 'economics', 'sports', 'crypto', 'weather'],
};
```

**Why these categories:**
- **Politics** — High volume, long-dated, likely to show overnight patterns (US traders dominate)
- **Economics** — Fed meetings, jobs reports; event-driven but predictable timing
- **Sports** — Game-based resolution; spreads likely widen between games
- **Crypto** — 24/7 underlying but prediction market liquidity may still follow US hours
- **Weather** — Daily resolution; interesting control group

**Target: 50-100 markets across categories** to ensure statistical significance.

#### Timeframe Selection (Reasoning)

**Why multiple timeframes matter:**

| Timeframe | What It Captures | Risk of Missing |
|-----------|------------------|-----------------|
| **5m** | Micro patterns, rapid spread changes | Too noisy for daily patterns |
| **15m** | Intraday patterns, event reactions | Good balance |
| **1h** | Hourly patterns, overnight effects | Primary for this study |
| **4h** | Session patterns (Asia/Europe/US) | Smooths noise, may miss spikes |

**Our approach:**
- **Primary analysis:** 1h candles (balance of signal vs noise)
- **Validation:** 15m candles (confirm patterns aren't artifacts of aggregation)
- **Macro view:** 4h candles (session-level patterns)

**Data requirements:**

| Timeframe | Candles per Day | 30 Days | 90 Days |
|-----------|-----------------|---------|---------|
| 5m | 288 | 8,640 | 25,920 |
| 15m | 96 | 2,880 | 8,640 |
| 1h | 24 | 720 | 2,160 |
| 4h | 6 | 180 | 540 |

**Start with 1h for 90 days, then validate with 15m.**

---

### Data Source: Replay Labs API

**Kalshi Candlesticks** (primary — has bid/ask OHLC):
```
GET /api/kalshi/series/{seriesTicker}/markets/{ticker}/candlesticks
  ?period_interval={1h|4h|1d}
  &start_ts={unix_timestamp}
  &end_ts={unix_timestamp}
```

Response includes:
- `yes_bid.open`, `yes_bid.high`, `yes_bid.low`, `yes_bid.close`
- `yes_ask.open`, `yes_ask.high`, `yes_ask.low`, `yes_ask.close`
- `volume`, `open_interest`

**Polymarket** (secondary — CLOB data):
```
GET /api/polymarket/clob/prices-history
POST /api/polymarket/clob/spreads
```

---

### Analysis Pipeline

```
┌─────────────────┐
│ 1. Fetch Data   │  Kalshi candlesticks for 50-100 markets
└────────┬────────┘  90 days, 1h timeframe
         │
         ▼
┌─────────────────┐
│ 2. Compute      │  spread = yes_ask - yes_bid
│    Spreads      │  spread_pct = spread / mid_price
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 3. Bucket       │  By hour_utc (0-23)
│    Aggregate    │  By day_of_week (0-6)
└────────┬────────┘  By category
         │
         ▼
┌─────────────────┐
│ 4. Statistics   │  median, p75, p90, p95 per bucket
│                 │  Compare buckets to find patterns
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ 5. Outcomes     │  For each "thin" window:
│    Analysis     │  - What happened next?
└────────┬────────┘  - Spread compression? Price drift?
         │
         ▼
┌─────────────────┐
│ 6. Report       │  Heatmap, hypothesis verdicts
└─────────────────┘
```

---

### Hypotheses

| Code | Hypothesis | Test | Accept If |
|------|-----------|------|-----------|
| **H1** | Spreads are wider during overnight US (0-6 UTC) | Compare median spread: overnight vs daytime | overnight > daytime by ≥20% |
| **H2** | Spreads are wider on weekends | Compare median spread: Sat+Sun vs weekdays | weekend > weekday by ≥15% |
| **H3** | Thin windows predict spread compression | After thin window (>p75), measure spread 8h later | compression ≥30% in ≥60% of cases |
| **H4** | Thin windows correlate with price drift | Measure abs(price_move) after thin window | drift > baseline by ≥25% |
| **H5** | Pattern varies by category | Compare H1-H4 across categories | At least one category differs significantly |

---

### Phase 2: New Replay Labs Indicator

**`liquidity_regime` indicator**

Framework-agnostic signal that any agent can query.

```typescript
// GET /api/indicators/kalshi/{ticker}?indicators=liquidity_regime

interface LiquidityRegimeIndicator {
  // Current state
  current_spread: number;              // ask - bid (in dollars)
  current_spread_pct: number;          // spread / mid_price
  
  // Percentile ranking
  spread_percentile_hour: number;      // vs same hour historically (0-1)
  spread_percentile_dow: number;       // vs same day-of-week (0-1)
  spread_percentile_global: number;    // vs all data (0-1)
  
  // Classification
  regime: 'thin' | 'normal' | 'deep';  // thin = >p75, deep = <p25
  window_type: 'overnight_us' | 'overnight_eu' | 'weekend' | 'holiday' | 'normal';
  
  // Historical baselines
  hour_baseline: {
    median: number;
    p75: number;
    p90: number;
    sample_size: number;
  };
  
  // Predictive (from historical analysis)
  expected_compression: {
    hours_to_normal: number;           // Expected time for spread to normalize
    compression_pct: number;           // Expected % spread reduction
    confidence: number;                // Based on historical accuracy
  };
  
  // Multi-timeframe confirmation
  confirmation: {
    tf_15m: 'thin' | 'normal' | 'deep';
    tf_1h: 'thin' | 'normal' | 'deep';
    tf_4h: 'thin' | 'normal' | 'deep';
    agreement: number;                 // 0-1, how many timeframes agree
  };
}
```

**Why this design:**
- **Percentiles** are more robust than absolute thresholds (adapts per market)
- **Multi-timeframe confirmation** reduces false positives
- **Window classification** helps agents reason about cause
- **Expected compression** gives actionable prediction

---

### Phase 3: New Replay Labs Annotation

**`liquidity_window` annotation**

Ground truth labels for historical analysis and model training.

```typescript
// GET /api/annotations/kalshi/{ticker}?type=liquidity_window

interface LiquidityWindowAnnotation {
  // Identification
  timestamp: string;                   // ISO 8601
  type: 'liquidity_window';
  
  // Entry state
  entry: {
    spread: number;
    spread_pct: number;
    spread_percentile: number;
    regime: 'thin' | 'normal' | 'deep';
    window_type: string;
  };
  
  // Exit state (8 hours later, or configurable)
  exit: {
    timestamp: string;
    spread: number;
    spread_pct: number;
  };
  
  // Outcome metrics
  outcome: {
    spread_compression_pct: number;    // (entry_spread - exit_spread) / entry_spread
    price_drift: number;               // exit_mid - entry_mid
    price_drift_pct: number;
    hours_to_compression: number;      // How long until spread < p50
  };
  
  // Labels (for ML training)
  labels: {
    was_thin: boolean;                 // entry.spread_percentile > 0.75
    did_compress: boolean;             // spread_compression_pct > 0.30
    was_profitable: boolean;           // Based on strategy simulation
    quality: 'high' | 'medium' | 'low'; // Based on volume, confidence
  };
  
  // Metadata
  metadata: {
    market_category: string;
    market_age_days: number;
    volume_at_entry: number;
    open_interest_at_entry: number;
  };
}
```

**Why this design:**
- **Entry/exit pairs** make it easy to backtest
- **Outcome metrics** enable supervised learning
- **Labels** are pre-computed for ML pipelines
- **Metadata** enables filtering by market characteristics

---

## V2: ICL Learning (Future)

Once we have labeled annotations:

### 1. Build Correction Examples

```json
{
  "id": "liq-correction-001",
  "scenario": {
    "market_category": "sports",
    "window_type": "overnight_us",
    "spread_percentile": 0.91
  },
  "expected_outcome": "spread_compression",
  "actual_outcome": "spread_widened",
  "reason": "NBA playoffs game started at 3am UTC — atypical sports activity",
  "correction": "For sports markets, check game schedules before assuming overnight = thin",
  "key_insight": "Sports liquidity follows game times, not US business hours"
}
```

### 2. Train Specialized Models

| Model | Input | Output | Use Case |
|-------|-------|--------|----------|
| **Compression Classifier** | spread_percentile, window_type, category | will_compress (bool) | Filter low-confidence windows |
| **Timing Regressor** | current state | hours_to_compression | Optimize entry timing |
| **Category Router** | market metadata | category-specific thresholds | Per-category signal calibration |

### 3. Continuous Learning Loop

```
Annotation generated → Outcome measured → 
  If outcome != expected → Create correction →
    Add to ICL prompt → Improved predictions
```

---

## Implementation Plan

### File Structure

```
arb-oppity/
├── README.md
├── package.json
├── tsconfig.json
├── .env.example
│
├── src/
│   ├── analysis/                      # Pattern discovery scripts
│   │   ├── fetch-kalshi-candles.ts    # Pull historical data
│   │   ├── compute-spread-stats.ts    # Bucket and aggregate
│   │   ├── validate-hypotheses.ts     # Test H1-H5
│   │   └── generate-report.ts         # Heatmap + summary
│   │
│   ├── indicators/                    # Replay Labs indicator implementations
│   │   ├── liquidity-regime.ts        # Main indicator logic
│   │   └── types.ts                   # LiquidityRegimeIndicator interface
│   │
│   ├── annotations/                   # Replay Labs annotation implementations
│   │   ├── liquidity-window.ts        # Annotation generator
│   │   └── types.ts                   # LiquidityWindowAnnotation interface
│   │
│   ├── replay-lab-client/             # API client (extend from agent-eval)
│   │   ├── client.ts
│   │   └── types.ts
│   │
│   └── utils/
│       ├── statistics.ts              # percentile, median, etc.
│       └── time.ts                    # UTC handling, window classification
│
├── data/                              # Gitignored, large files
│   ├── raw/                           # Fetched candlesticks
│   └── processed/                     # Computed stats
│
├── output/                            # Analysis results
│   ├── spread-by-hour.json
│   ├── spread-by-dow.json
│   ├── hypotheses-results.json
│   └── heatmap.html                   # Visualization
│
└── docs/
    ├── indicator-spec.md              # API spec for liquidity_regime
    └── annotation-spec.md             # API spec for liquidity_window
```

### Execution Order

| Step | Task | Output |
|------|------|--------|
| **1** | Set up repo structure + deps | `package.json`, `tsconfig.json` |
| **2** | Build replay-lab-client for Kalshi candlesticks | `src/replay-lab-client/` |
| **3** | Fetch 90 days of 1h candles for 50+ markets | `data/raw/` |
| **4** | Compute spread stats by hour/dow/category | `data/processed/` |
| **5** | Generate heatmap visualization | `output/heatmap.html` |
| **6** | Validate hypotheses H1-H5 | `output/hypotheses-results.json` |
| **7** | Write indicator spec | `docs/indicator-spec.md` |
| **8** | Write annotation spec | `docs/annotation-spec.md` |
| **9** | Implement indicator computation | `src/indicators/` |
| **10** | Implement annotation generation | `src/annotations/` |

---

## Night-1 Demo Target

**Deliverable:** Analysis report answering "Does the thin liquidity pattern exist?"

1. Fetch data for 50 Kalshi markets (90 days, 1h candles)
2. Compute spread percentiles by hour (0-23 UTC)
3. Compute spread percentiles by day-of-week
4. Generate heatmap visualization
5. Output hypothesis verdicts (H1-H5)

**Demo output:**
```
=== Liquidity Timing Pattern Analysis ===

Markets analyzed: 52
Data range: 2024-10-20 to 2026-01-19 (91 days)
Candles processed: 112,320

HYPOTHESIS RESULTS:

H1: Overnight spreads wider than daytime
    Overnight (0-6 UTC) median spread: 4.2%
    Daytime (12-18 UTC) median spread: 2.8%
    Difference: +50%
    VERDICT: ✅ SUPPORTED (threshold: ≥20%)

H2: Weekend spreads wider than weekdays
    Weekend median spread: 3.9%
    Weekday median spread: 3.1%
    Difference: +26%
    VERDICT: ✅ SUPPORTED (threshold: ≥15%)

H3: Thin windows predict spread compression
    Thin windows (>p75) that compressed within 8h: 68%
    Average compression: 38%
    VERDICT: ✅ SUPPORTED (threshold: ≥60% at ≥30%)

H4: Thin windows correlate with price drift
    Average abs(price_move) after thin: 2.1%
    Baseline abs(price_move): 1.4%
    Difference: +50%
    VERDICT: ✅ SUPPORTED (threshold: ≥25%)

H5: Pattern varies by category
    Politics: overnight +62% wider
    Sports: overnight +28% wider
    Crypto: overnight +18% wider (weakest)
    VERDICT: ✅ SUPPORTED (categories differ)

CONCLUSION: Pattern exists and is actionable.
Recommended next step: Implement liquidity_regime indicator.
```

---

## Success Criteria

| Metric | Target |
|--------|--------|
| Pattern strength | Overnight spreads > daytime by ≥20% |
| Pattern consistency | Holds for ≥70% of markets |
| Compression rate | ≥60% of thin windows compress ≥30% within 8h |
| Actionability | Backtest shows positive edge after 1% fee |
| API contribution | Indicator + annotation specs ready for Replay Labs PR |

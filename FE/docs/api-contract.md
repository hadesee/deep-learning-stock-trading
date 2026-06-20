# Frontend API Contract

This contract maps the Python pipeline outputs to frontend-facing landing and dashboard data.

## Source Files

The current Python project writes final analysis results to:

- `outputs/final_stock_lstm_news_llm_result.json`
- `outputs/final_stock_lstm_news_llm_result.csv`

The JSON output is preferred because it preserves nested LLM result, original input row, and news items.

```ts
type PipelineOutput = Array<{
  result: PipelineAnalysisResult;
  input_row: PipelineInputRow;
  news: PipelineNewsItem[];
}>;
```

## Pipeline Result Shape

```ts
type PipelineAnalysisResult = {
  ticker: string;
  company_name: string;
  label: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | string;
  label_ko: string;
  sentiment_score: number;
  confidence: number;
  summary: string;
  positive_factors: string[];
  negative_factors: string[];
  key_data_points: string[];
  used_news_indices: number[];
  caution: string;
};

type PipelineInputRow = {
  ticker?: string;
  company_name?: string;
  lstm_status?: string;
  lstm_pred_return?: number;
  ensemble_pred_return?: number;
  lstm_base_date?: string;
  [key: string]: unknown;
};

type PipelineNewsItem = {
  index: number;
  pub_date: string;
  source: string;
  title: string;
  url?: string;
};
```

## Proposed Frontend Endpoints

### `GET /api/market-summary`

Returns a compact summary for the landing hero dashboard.

```ts
type MarketSummaryResponse = {
  generatedAt: string;
  marketState: "강세 우위" | "중립 우위" | "약세 경계" | string;
  candidateCount: number;
  riskState: "Low" | "Normal" | "Elevated" | "High";
  strategySlots: number;
  averageConfidence: number;
  averagePredictedReturn: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};
```

### `GET /api/candidates`

Returns ranked candidates derived from the final pipeline result.

```ts
type CandidateResponse = {
  ticker: string;
  companyName: string;
  sentimentLabel: string;
  sentimentLabelKo: string;
  sentimentScore: number;
  confidence: number;
  predictedReturn: number | null;
  lstmStatus: string;
  summary: string;
  positiveFactors: string[];
  negativeFactors: string[];
  newsCount: number;
  latestNewsTitle?: string;
};
```

### `GET /api/reports/latest`

Returns latest report metadata and top candidate summaries.

```ts
type LatestReportResponse = {
  generatedAt: string;
  source: "pipeline";
  candidates: CandidateResponse[];
  warnings: string[];
};
```

## Current Frontend Implementation

Until a backend HTTP server is added, `src/services/tradingData.ts` uses `src/data/mockPipelineResults.ts`, which matches the JSON structure above, then normalizes it into frontend display data.

When the backend is ready, replace the mock import in `getLandingData()` with `fetch("/api/market-summary")` and `fetch("/api/candidates")`.

## Korean Market Board Contract

The market board screen is Korea-only. It should not fetch overseas markets, FX, US ETFs, or global futures.

The browser must not call Korea Investment Open API directly because API keys, app secrets, OAuth tokens, and account-related credentials must stay on the backend. A thin Python API server should wrap KIS responses and normalize them for the frontend.

### `GET /api/korean-market/dashboard`

Returns the full initial screen payload.

```ts
type MarketDashboardResponse = {
  generatedAt: string;
  sessionLabel: string;
  indices: MarketIndexSnapshot[];
  stocks: StockQuote[];
  watchlist: StockQuote[];
  focusedStockCode: string;
  events: MarketEvent[];
};
```

### `GET /api/korean-market/stocks?market=KOSPI&sort=tradingValue`

Returns quote rows for the stock table.

```ts
type StockQuote = {
  code: string;
  name: string;
  market: "KOSPI" | "KOSDAQ";
  isKospi200?: boolean; // KOSPI200 membership; backend sets true for its pool
  currentPrice: number;
  change: number;
  changeRate: number;
  direction: "up" | "down" | "flat";
  accumulatedVolume: number;
  tradingValue: number;
  tradingValueRank: number;
  investorFlow: {
    personal: number;
    foreign: number;
    institution: number;
  };
  aiSummary: string;
  sentimentLabel: "POSITIVE" | "NEUTRAL" | "NEGATIVE" | string;
  confidence: number;
  predictedReturn: number | null;
  miniSeries: number[];
};
```

### `GET /api/korean-market/stocks/{code}`

Returns one stock detail payload for the side panel.

```ts
type StockDetailResponse = StockQuote & {
  reasons: string[];
  latestNews: Array<{
    title: string;
    source: string;
    publishedAt: string;
    url?: string;
  }>;
};
```

### `GET /api/korean-market/stock-chart?symbol={code}&range={range}`

Returns one KOSPI stock chart payload for the detail chart panel. The browser
must call this backend endpoint, not Korea Investment Open API directly. `range`
is optional and defaults to `1D`. The backend fetches only the requested range
to keep the first detail-chart render from waiting on all chart periods.

```ts
type StockChartResponse = {
  chartData: {
    symbol: string;
    name: string;
    code: string;
    currentPrice: number;
    averageBuyPrice?: number;
    ranges: Record<"1D" | "1M" | "3M" | "1Y" | "3Y" | "5Y", {
      prices: Array<{ date: string; price: number }>;
      candles: Array<{
        time: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume?: number;
      }>;
    }>;
  };
  summary: {
    dayChangeAmount: number;
    dayChangeRate: number;
    previousClose: number;
    openingPrice: number;
    previousVolume: number;
    marketCap: number;
    dividendYield: number;
  };
};
```

### KIS Field Mapping

The current `main.py` already wraps the KIS current price endpoint and extracts core quote fields:

| Frontend field | KIS/current backend source |
| --- | --- |
| `code` | stock code used as `FID_INPUT_ISCD` |
| `name` | `hts_kor_isnm` or static KOSPI pool name |
| `currentPrice` | `stck_prpr` |
| `changeRate` | `prdy_ctrt` |
| `dayChangeAmount` | `prdy_vrss` + `prdy_vrss_sign` |
| `openingPrice` | `stck_oprc` |
| `previousVolume` | previous-volume quote field, or latest completed daily OHLCV volume fallback |
| `accumulatedVolume` | `acml_vol` |
| `tradingValue` | `acml_tr_pbmn` |

Investor flow fields should be provided by a backend KIS investor-trend wrapper and normalized to:

```ts
{
  personal: number;
  foreign: number;
  institution: number;
}
```

Values should be signed numbers. Positive means net buying, negative means net selling.

### Current Mock Data

The screen currently uses:

- `src/data/mockMarketDashboard.ts`
- `src/services/tradingData.ts#getMarketDashboardData`

Replace `getMarketDashboardData()` with a real fetch when the backend endpoint exists:

```ts
export async function fetchMarketDashboardData() {
  const response = await fetch("/api/korean-market/dashboard");
  if (!response.ok) throw new Error("Failed to load Korean market dashboard");
  return response.json();
}
```

## Implemented Backend (server/ + api/)

The contract above is now wired up in `FE/server` (vite dev middleware) and
`FE/api` (Vercel serverless functions):

- `GET /api/korean-market/dashboard` — serves the cached snapshot when fresh,
  otherwise builds a small inline slice live and caches it.
- `POST /api/korean-market/refresh` — batch job that fetches the full configured
  KOSPI200 universe **with investor flow** and writes the snapshot. Gate it with
  `SNAPSHOT_REFRESH_KEY` in production and drive it from a scheduler.
- `GET /api/korean-market/stock-chart?symbol=000660&range=1D` — fetches the
  requested selected-stock OHLCV range and quote summary from KIS for the detail
  chart. Range responses are cached by `symbol+range`.
- `GET /api/candidates` — returns the Python pipeline rows from
  `outputs/final_stock_lstm_news_llm_result.json` (empty array when absent; the
  frontend then falls back to bundled mock).
- `POST /api/candidates/run` — starts `integrated_pipeline.py`, writes
  `outputs/final_stock_lstm_news_llm_result.json`, then merges the generated AI
  fields into the cached dashboard snapshot so the dashboard reload can show the
  new candidate analysis immediately.

### AI / investor field sources

`buildKisDashboard` merges KIS quotes with pipeline output by 6-digit ticker:

| `StockQuote` field | Source |
| --- | --- |
| `currentPrice` / `changeRate` / `accumulatedVolume` / `tradingValue` | KIS `inquire-price` (`FHKST01010100`) |
| `investorFlow.{personal,foreign,institution}` | KIS `inquire-investor` (`FHKST01010900`) → `prsn_ntby_qty` / `frgn_ntby_qty` / `orgn_ntby_qty`, most recent non-empty daily row |
| `aiSummary` | pipeline `result.summary` |
| `confidence` | pipeline `result.confidence` |
| `predictedReturn` | pipeline `input_row.ensemble_pred_return ?? lstm_pred_return` |
| `sentimentLabel` | pipeline `result.label` (falls back to a direction-based guess) |

When a stock has no matching pipeline row, the AI fields stay empty
(`confidence: 0`, `predictedReturn: null`) and the UI renders "—" rather than a
misleading zero. Investor flow is only reliably populated in the **real** KIS
environment; the mock (VTS) environment frequently returns empty net-buy figures.

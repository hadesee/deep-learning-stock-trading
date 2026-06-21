// Maps a LIVE pipeline row (what /api/candidates and /api/stock-analysis return
// after integrated_pipeline.py runs) into the AiCandidate shape the detail
// dashboard renders. This is the bridge between the real backend output and the
// "why we picked this" UI, so a real run shows real evidence.
import type { AiCandidate, AiNews } from "./aiCandidates";
import type { MarketDashboardData, PipelineOutputRow, StockQuote } from "../types/trading";

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function pick(points: string[], regex: RegExp): number | null {
  for (const point of points) {
    const match = point.match(regex);
    if (match) {
      const parsed = Number(match[1]);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  return null;
}

function findTally(points: string[]): string {
  return points.find((p) => /(긍정|부정|중립)\s*\d+\s*건/.test(p)) ?? "";
}

function sentimentKo(label: string): string {
  const upper = String(label).toUpperCase();
  if (upper === "POSITIVE") return "상승 우위";
  if (upper === "NEGATIVE") return "하락 우위";
  return "중립";
}

/** Converts one live PipelineOutputRow into the AiCandidate the detail UI renders. */
export function rowToCandidate(row: PipelineOutputRow): AiCandidate {
  const input = row.input_row ?? {};
  const result = row.result ?? ({} as PipelineOutputRow["result"]);
  const points = result.key_data_points ?? [];

  const pUp = num(input.p_up);
  const combined =
    pick(points, /결합\s*점수:\s*([\d.]+)\s*\/\s*100/) ??
    (result.confidence ? Math.round(result.confidence * 100) : Math.round(((result.sentiment_score ?? 0) + 1) * 50));
  const newsScore = pick(points, /뉴스\s*종합\s*점수:\s*([\d.]+)\s*\/\s*10/);

  const news: AiNews[] = (row.news ?? []).map((item, index) => ({
    title: item.title,
    url: item.url ?? "",
    source: item.source,
    pubDate: item.pub_date,
    description: item.description ?? "",
    index: item.index ?? index + 1,
    sentiment: item.sentiment,
    sentimentKo: item.sentiment_ko,
    sentimentReason: item.sentiment_reason,
  }));

  return {
    ticker: String(result.ticker ?? input.ticker ?? "").padStart(6, "0"),
    companyName: result.company_name ?? String(input.company_name ?? ""),
    rank: Math.round(num(input.pred_rank)) || 0,
    poolSize: Math.round(num(input.pred_pool_size)) || 0,
    pUp,
    baseDate: String(input.transformer_base_date ?? input.lstm_base_date ?? ""),
    ensemblePredReturn: num(input.ensemble_pred_return),
    foreignNetBuy: num(input.foreign_net_buy_sum),
    instNetBuy: num(input.inst_net_buy_sum),
    totalSupplyNetBuy: num(input.total_supply_net_buy),
    foreignPositiveDays: Math.round(num(input.foreign_positive_days)),
    instPositiveDays: Math.round(num(input.inst_positive_days)),
    supplyWindow: Math.round(num(input.supply_window)) || 5,
    newsCount: news.length,
    newsOverallScore: newsScore ?? 0,
    newsSentimentTally: findTally(points),
    finalSentiment: result.label ?? "NEUTRAL",
    finalSentimentKo: sentimentKo(result.label ?? "NEUTRAL"),
    finalCombinedScore: Math.max(0, Math.min(100, combined)),
    summary: result.summary ?? "",
    tradingInsight: result.trading_insight ?? "",
    news,
  };
}

/**
 * Minimal StockQuote for an AI candidate whose KIS quote isn't available yet
 * (missing from the base dashboard and not in the fetched quotes). Carries the
 * real ticker/name from the pipeline row; price fields are 0 so the UI renders
 * "—" until a live quote hydrates. Keeps the candidate visible instead of
 * dropping it from the list.
 */
function placeholderQuote(code: string, row: PipelineOutputRow): StockQuote {
  return {
    code,
    name: row.result?.company_name ?? String(row.input_row?.company_name ?? code),
    market: "KOSPI",
    isKospi200: true,
    currentPrice: 0,
    change: 0,
    changeRate: 0,
    direction: "flat",
    accumulatedVolume: 0,
    tradingValue: 0,
    tradingValueRank: 0,
    investorFlow: { foreign: 0, institution: 0, personal: 0 },
    aiSummary: "",
    sentimentLabel: row.result?.label ?? "NEUTRAL",
    confidence: 0,
    predictedReturn: null,
    upProbability: null,
    miniSeries: [],
  };
}

/**
 * Overlays live pipeline analysis onto a base dashboard so the board reflects a
 * fresh run: matching tickers get the real sentiment/summary/confidence, and the
 * list keeps the backend's final score order.
 *
 * Prices come from real KIS quotes when a `quotes` map is supplied (keyed by
 * 6-digit code, e.g. from {@link fetchCandidateQuotes}); otherwise they fall
 * back to the base dashboard entry so the row still renders before quotes
 * hydrate. A candidate with a live quote is shown even when the base dashboard
 * (mock/cached) doesn't contain it.
 */
export function overlayLiveAnalysis(
  base: MarketDashboardData,
  rows: PipelineOutputRow[],
  quotes?: Map<string, StockQuote>,
): MarketDashboardData {
  const baseByCode = new Map(base.stocks.map((stock) => [stock.code, stock]));
  const seen = new Set<string>();
  const stocks: StockQuote[] = [];

  for (const row of rows) {
    const code = String(row.result?.ticker ?? row.input_row?.ticker ?? "").padStart(6, "0");
    if (!code || seen.has(code)) {
      continue;
    }

    // Prefer the real KIS quote (live price); fall back to the base entry, then to
    // a price-less placeholder so an AI-selected candidate is NEVER dropped just
    // because its quote hasn't hydrated yet (price renders as "—" until it does).
    const source = quotes?.get(code) ?? baseByCode.get(code) ?? placeholderQuote(code, row);

    seen.add(code);
    const result = row.result;
    stocks.push({
      ...source,
      aiSummary: result.summary || source.aiSummary,
      sentimentLabel: result.label ?? source.sentimentLabel,
      confidence: result.confidence || source.confidence,
      upProbability: num(row.input_row?.p_up) || source.upProbability,
    });
  }

  return {
    ...base,
    stocks,
    watchlist: stocks.length > 0 ? stocks.slice(0, 8) : base.watchlist,
    focusedStockCode: stocks[0]?.code ?? base.watchlist[0]?.code ?? base.focusedStockCode,
    generatedAt: new Date().toISOString(),
  };
}

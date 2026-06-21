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
 * Overlays live pipeline analysis onto a base dashboard so the board reflects a
 * fresh run: matching tickers get the real sentiment/summary/confidence, and the
 * list keeps the backend's final score order. Prices stay from the base
 * (placeholder until the KIS bridge is connected).
 */
export function overlayLiveAnalysis(base: MarketDashboardData, rows: PipelineOutputRow[]): MarketDashboardData {
  const byTicker = new Map<string, PipelineOutputRow>();
  const orderByTicker = new Map<string, number>();
  for (const row of rows) {
    const code = String(row.result?.ticker ?? row.input_row?.ticker ?? "").padStart(6, "0");
    if (code) {
      byTicker.set(code, row);
      if (!orderByTicker.has(code)) {
        orderByTicker.set(code, orderByTicker.size);
      }
    }
  }

  const orderOf = (code: string) => {
    return orderByTicker.get(code) ?? Number.MAX_SAFE_INTEGER;
  };

  const stocks: StockQuote[] = base.stocks
    .filter((stock) => byTicker.has(stock.code))
    .map((stock) => {
      const row = byTicker.get(stock.code);
      if (!row) {
        return stock;
      }
      const result = row.result;
      return {
        ...stock,
        aiSummary: result.summary || stock.aiSummary,
        sentimentLabel: result.label ?? stock.sentimentLabel,
        confidence: result.confidence || stock.confidence,
        upProbability: num(row.input_row?.p_up) || stock.upProbability,
      };
    })
    .sort((a, b) => orderOf(a.code) - orderOf(b.code));

  return {
    ...base,
    stocks,
    watchlist: stocks.length > 0 ? stocks.slice(0, 8) : base.watchlist,
    focusedStockCode: stocks[0]?.code ?? base.watchlist[0]?.code ?? base.focusedStockCode,
    generatedAt: new Date().toISOString(),
  };
}

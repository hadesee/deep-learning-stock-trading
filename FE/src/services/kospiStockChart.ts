import { buildMockKospiStockChartBundle } from "../data/mockStockChartData";
import type { StockQuote } from "../types/trading";
import type { CandlePoint, PricePoint, StockChartBundle, StockSummary, TimeRange } from "../types/stockChart";

export type StockChartDataSource = "kis" | "mock";

export type ResolvedStockChartBundle = StockChartBundle & {
  dataSource: StockChartDataSource;
  warning?: string;
};

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const CLIENT_CACHE_TTL_MS = 60_000;
const bundleCache = new Map<string, { bundle: StockChartBundle; cachedAt: number }>();

function apiUrl(path: string): string {
  return `${API_BASE_URL}${path}`;
}

function toFallbackBundle(symbol: string, source: StockQuote | undefined, warning?: string): ResolvedStockChartBundle {
  return {
    ...buildMockKospiStockChartBundle(symbol, source),
    dataSource: "mock",
    warning,
  };
}

function isStockChartBundle(value: unknown): value is StockChartBundle {
  const bundle = value as StockChartBundle;
  return (
    typeof bundle === "object" &&
    bundle !== null &&
    typeof bundle.chartData === "object" &&
    bundle.chartData !== null &&
    typeof bundle.summary === "object" &&
    bundle.summary !== null
  );
}

async function fetchKisStockChartBundle(symbol: string, signal?: AbortSignal): Promise<StockChartBundle> {
  const cacheKey = symbol;
  const cached = bundleCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CLIENT_CACHE_TTL_MS) {
    return cached.bundle;
  }

  // The bundle carries every time range, so a single fetch covers 1D…5Y and
  // range switching is instant (no refetch).
  const response = await fetch(apiUrl(`/api/korean-market/stock-chart?symbol=${encodeURIComponent(symbol)}`), {
    headers: { Accept: "application/json" },
    signal,
  });

  if (!response.ok) {
    let message = `KIS chart request failed (${response.status}).`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Keep the status-based message.
    }
    throw new Error(message);
  }

  const payload = (await response.json()) as unknown;
  if (!isStockChartBundle(payload)) {
    throw new Error("KIS chart response shape is invalid.");
  }

  bundleCache.set(cacheKey, { bundle: payload, cachedAt: Date.now() });
  return payload;
}

export async function getKospiStockChartBundle(
  symbol: string,
  source?: StockQuote,
  signal?: AbortSignal,
): Promise<ResolvedStockChartBundle> {
  try {
    return {
      ...(await fetchKisStockChartBundle(symbol, signal)),
      dataSource: "kis",
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    const warning = error instanceof Error ? error.message : "KIS chart request failed.";
    if (import.meta.env.DEV) {
      console.warn("KIS stock chart API unavailable. Falling back to mock chart data.", error);
    }

    return toFallbackBundle(symbol, source, warning);
  }
}

export async function getKospiStockChart(
  symbol: string,
  range: TimeRange,
  source?: StockQuote,
  signal?: AbortSignal,
): Promise<PricePoint[]> {
  return (await getKospiStockChartBundle(symbol, source, signal)).chartData.ranges[range].prices;
}

export async function getKospiStockCandles(
  symbol: string,
  range: TimeRange,
  source?: StockQuote,
  signal?: AbortSignal,
): Promise<CandlePoint[]> {
  return (await getKospiStockChartBundle(symbol, source, signal)).chartData.ranges[range].candles;
}

export async function getKospiStockSummary(
  symbol: string,
  source?: StockQuote,
  signal?: AbortSignal,
): Promise<StockSummary> {
  return (await getKospiStockChartBundle(symbol, source, signal)).summary;
}

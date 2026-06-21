import type { Candle, StockQuote } from "../types/trading";

/** Chart timeframe for existing candle aggregation: 일/주/월/년. */
export type ChartTimeframe = "D" | "W" | "M" | "Y";

export const CHART_TIMEFRAMES: Array<{ value: ChartTimeframe; label: string }> = [
  { value: "D", label: "일" },
  { value: "W", label: "주" },
  { value: "M", label: "월" },
  { value: "Y", label: "년" },
];

/** Trading sessions per aggregated bucket (≈5/week, 21/month, 252/year). */
const BUCKET_SESSIONS: Record<ChartTimeframe, number> = { D: 1, W: 5, M: 21, Y: 252 };

/** How many aggregated candles to display per timeframe. */
const DISPLAY_COUNT: Record<ChartTimeframe, number> = { D: 120, W: 90, M: 48, Y: 12 };

/** Length of the generated daily base series (~3.5 trading years). */
const BASE_DAILY_SESSIONS = 880;

/** Small deterministic PRNG so generated candles are stable across renders. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFromCode(code: string): number {
  let hash = 2166136261;
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Business-day dates (skipping weekends) ending today, oldest first. */
function businessDays(count: number): Date[] {
  const dates: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);

  while (dates.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  return dates.reverse();
}

/**
 * Builds a deterministic daily OHLC series ending exactly at `lastClose`.
 * Used only as a placeholder until the backend supplies real candles; the shape
 * is identical (daily candles) so swapping in live data needs no UI change.
 */
function generateDailyBase(seed: number, lastClose: number, count: number): Candle[] {
  const random = mulberry32(seed);
  const closes: number[] = [];
  let price = lastClose;

  // Walk backwards from the real close so the latest candle is accurate.
  for (let i = 0; i < count; i += 1) {
    closes.push(price);
    const drift = (random() - 0.5) * 0.04 + 0.0012;
    price = price / (1 + drift);
  }
  closes.reverse();

  const dates = businessDays(count);
  const candles: Candle[] = [];

  for (let i = 0; i < count; i += 1) {
    const close = closes[i];
    const open = i === 0 ? close * (1 + (random() - 0.5) * 0.02) : closes[i - 1];
    const body = Math.abs(close - open);
    const high = Math.max(open, close) + body * random() + close * random() * 0.01;
    const low = Math.min(open, close) - body * random() - close * random() * 0.01;
    const volume = Math.round((0.6 + random() * 0.9) * 1_000_000);

    candles.push({
      date: formatDate(dates[i]),
      open: Math.round(open),
      high: Math.round(high),
      low: Math.round(Math.max(low, 1)),
      close: Math.round(close),
      volume,
    });
  }

  return candles;
}

/**
 * Aggregates a daily series into fixed-size buckets (weekly/monthly/yearly),
 * grouping from the most recent session so the latest bucket always ends on the
 * newest close. open = first.open, close = last.close, high/low = extremes,
 * volume = sum.
 */
function aggregate(daily: Candle[], bucketSessions: number): Candle[] {
  if (bucketSessions <= 1) {
    return daily;
  }

  const buckets: Candle[] = [];

  for (let end = daily.length; end > 0; end -= bucketSessions) {
    const group = daily.slice(Math.max(0, end - bucketSessions), end);
    buckets.push({
      date: group[group.length - 1].date,
      open: group[0].open,
      close: group[group.length - 1].close,
      high: Math.max(...group.map((candle) => candle.high)),
      low: Math.min(...group.map((candle) => candle.low)),
      volume: group.reduce((sum, candle) => sum + candle.volume, 0),
    });
  }

  return buckets.reverse();
}

/** Cached daily base series per stock code. */
const cache = new Map<string, Candle[]>();

/**
 * Returns the candle slice for a stock and timeframe. Prefers backend-supplied
 * `stock.candles` (assumed daily); otherwise lazily generates (and caches) a
 * deterministic placeholder daily series, then aggregates it to the timeframe.
 */
export function getStockCandles(stock: StockQuote, timeframe: ChartTimeframe): Candle[] {
  const base = stock.candles?.length
    ? stock.candles
    : cache.get(stock.code) ??
      (() => {
        const generated = generateDailyBase(seedFromCode(stock.code), stock.currentPrice, BASE_DAILY_SESSIONS);
        cache.set(stock.code, generated);
        return generated;
      })();

  const aggregated = aggregate(base, BUCKET_SESSIONS[timeframe]);
  return aggregated.slice(Math.max(0, aggregated.length - DISPLAY_COUNT[timeframe]));
}

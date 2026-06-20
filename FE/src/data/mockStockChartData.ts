import type { StockQuote } from "../types/trading";
import type { CandlePoint, PricePoint, StockChartBundle, StockChartData, StockSummary, TimeRange } from "../types/stockChart";
import { TIME_RANGES } from "../types/stockChart";

type RangeConfig = {
  count: number;
  longAcceleration?: boolean;
  volatility: number;
};

const RANGE_CONFIG: Record<TimeRange, RangeConfig> = {
  "1D": { count: 72, volatility: 0.006 },
  "1M": { count: 24, volatility: 0.018 },
  "3M": { count: 62, volatility: 0.026 },
  "1Y": { count: 120, volatility: 0.04 },
  "3Y": { count: 156, volatility: 0.055, longAcceleration: true },
  "5Y": { count: 180, volatility: 0.065, longAcceleration: true },
};

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

function seedFromText(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Returns `count` weekday dates, picking every `step`-th business day going
 * backwards from today. Walks one calendar day at a time (never jumps by a fixed
 * day count) so a `step` that is a multiple of 7 can't land on the same weekday
 * forever — the previous fixed-jump version ran away into Invalid Dates when
 * today fell on a weekend.
 */
function businessDays(count: number, step: number): Date[] {
  const stride = Math.max(1, Math.floor(step));
  const dates: Date[] = [];
  const cursor = new Date();
  cursor.setHours(0, 0, 0, 0);
  let businessSeen = 0;

  while (dates.length < count) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      if (businessSeen % stride === 0) {
        dates.push(new Date(cursor));
      }
      businessSeen += 1;
    }
    cursor.setDate(cursor.getDate() - 1);
  }

  return dates.reverse();
}

function intradayTimes(count: number): string[] {
  const date = formatDate(new Date());
  return Array.from({ length: count }, (_, index) => {
    const minutesFromOpen = Math.round((index / Math.max(count - 1, 1)) * 390);
    const hour = 9 + Math.floor(minutesFromOpen / 60);
    const minute = minutesFromOpen % 60;
    return `${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00+09:00`;
  });
}

function timeLabelsForRange(range: TimeRange, count: number): string[] {
  if (range === "1D") {
    return intradayTimes(count);
  }

  const stepDays: Record<Exclude<TimeRange, "1D">, number> = {
    "1M": 1,
    "3M": 2,
    "1Y": 3,
    "3Y": 7,
    "5Y": 10,
  };

  return businessDays(count, stepDays[range]).map(formatDate);
}

function smoothStep(value: number): number {
  return value * value * (3 - 2 * value);
}

function startFactorForRange(stock: StockQuote, range: TimeRange, seed: number): number {
  if (range === "1D") {
    if (stock.direction === "down") {
      return 1.028;
    }
    if (stock.direction === "up") {
      return 0.985;
    }
    return 0.998;
  }

  if (range === "1M") {
    return stock.direction === "down" ? 1.06 : 0.91;
  }

  if (range === "3M") {
    return stock.direction === "down" ? 1.12 : 0.86;
  }

  if (range === "1Y") {
    return seed % 5 === 0 ? 1.16 : 0.72;
  }

  if (range === "3Y") {
    return seed % 4 === 0 ? 1.28 : 0.48;
  }

  return seed % 3 === 0 ? 1.42 : 0.22;
}

function buildPriceSeries(stock: StockQuote, range: TimeRange, seed: number): PricePoint[] {
  const config = RANGE_CONFIG[range];
  const random = mulberry32(seed + TIME_RANGES.indexOf(range) * 997);
  const labels = timeLabelsForRange(range, config.count);
  const endPrice = Math.max(stock.currentPrice, 1);
  const startPrice = endPrice * startFactorForRange(stock, range, seed);
  const direction = endPrice >= startPrice ? 1 : -1;

  return labels.map((date, index) => {
    const ratio = index / Math.max(config.count - 1, 1);
    const trendRatio = config.longAcceleration && direction > 0 ? Math.pow(ratio, 2.9) : smoothStep(ratio);
    const wave = Math.sin(ratio * Math.PI * (range === "1D" ? 5 : 4)) * config.volatility * endPrice;
    const noise = (random() - 0.5) * config.volatility * endPrice;
    const trend = startPrice + (endPrice - startPrice) * trendRatio;
    const price = index === config.count - 1 ? endPrice : Math.max(1, trend + wave + noise);

    return {
      date,
      price: Math.round(price),
    };
  });
}

function buildCandles(prices: PricePoint[], seed: number, baseVolume: number): CandlePoint[] {
  const random = mulberry32(seed);

  return prices.map((point, index) => {
    const previousClose = prices[index - 1]?.price ?? point.price * (1 + (random() - 0.5) * 0.01);
    const open = Math.round(previousClose);
    const close = point.price;
    const body = Math.abs(close - open);
    const spread = Math.max(body * (0.35 + random() * 0.7), close * (0.002 + random() * 0.006));
    const high = Math.round(Math.max(open, close) + spread);
    const low = Math.round(Math.max(1, Math.min(open, close) - spread));
    const volume = Math.round(baseVolume * (0.35 + random() * 0.9) * (1 + index / Math.max(prices.length - 1, 1)));

    return {
      time: point.date,
      open,
      high,
      low,
      close,
      volume,
    };
  });
}

function buildFallbackStock(symbol: string): StockQuote {
  return {
    accumulatedVolume: 1_200_000,
    aiSummary: "차트 프리뷰용 KOSPI 종목입니다.",
    change: 0,
    changeRate: 0,
    code: symbol,
    confidence: 0,
    currentPrice: 100_000,
    direction: "flat",
    investorFlow: {
      foreign: 0,
      institution: 0,
      personal: 0,
    },
    market: "KOSPI",
    miniSeries: [98, 99, 100],
    name: "KOSPI 종목",
    predictedReturn: null,
    sentimentLabel: "NEUTRAL",
    tradingValue: 120_000_000_000,
    tradingValueRank: 0,
  };
}

function estimateListedShares(stock: StockQuote, seed: number): number {
  if (stock.code === "005930") {
    return 5_960_000_000;
  }

  if (stock.code === "000660") {
    return 728_000_000;
  }

  if (stock.code === "207940") {
    return 71_000_000;
  }

  return 60_000_000 + (seed % 720_000_000);
}

function buildSummary(stock: StockQuote, chartData: StockChartData, seed: number): StockSummary {
  const oneDay = chartData.ranges["1D"].prices;
  const openingPrice = oneDay[0]?.price ?? stock.currentPrice;
  const previousVolume = Math.max(1, Math.round(stock.accumulatedVolume * (0.72 + (seed % 41) / 100)));
  const marketCap = Math.round(stock.currentPrice * estimateListedShares(stock, seed));
  const dividendYield = Math.round(((seed % 240) / 100 + 0.1) * 100) / 100;
  const dayChangeAmount = stock.change;
  const dayChangeRate = stock.changeRate;

  return {
    dayChangeAmount,
    dayChangeRate,
    dividendYield,
    marketCap,
    openingPrice,
    previousClose: stock.currentPrice - dayChangeAmount,
    previousVolume,
  };
}

export function buildMockKospiStockChartBundle(symbol: string, source?: StockQuote): StockChartBundle {
  const stock = source ?? buildFallbackStock(symbol);
  const seed = seedFromText(`${stock.code}:${stock.name}`);
  const ranges = TIME_RANGES.reduce<StockChartData["ranges"]>((result, range) => {
    const prices = buildPriceSeries(stock, range, seed);
    result[range] = {
      candles: buildCandles(prices, seed + TIME_RANGES.indexOf(range) * 2039, Math.max(stock.accumulatedVolume / prices.length, 1)),
      prices,
    };
    return result;
  }, {} as StockChartData["ranges"]);

  const oneMonthPrices = ranges["1M"].prices.map((point) => point.price);
  const minMonth = Math.min(...oneMonthPrices);
  const maxMonth = Math.max(...oneMonthPrices);
  const averageBuyPrice = Math.round(minMonth + (maxMonth - minMonth) * 0.48);

  const chartData: StockChartData = {
    averageBuyPrice,
    code: stock.code,
    currentPrice: stock.currentPrice,
    name: stock.name,
    ranges,
    symbol: stock.code,
  };

  return {
    chartData,
    sourceStock: stock,
    summary: buildSummary(stock, chartData, seed),
  };
}

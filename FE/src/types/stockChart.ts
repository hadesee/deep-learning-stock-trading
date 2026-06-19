import type { StockQuote } from "./trading";

export const TIME_RANGES = ["1D", "1M", "3M", "1Y", "3Y", "5Y"] as const;

export type TimeRange = (typeof TIME_RANGES)[number];

export type ChartMode = "area" | "candle";

export type PricePoint = {
  date: string;
  price: number;
};

export type CandlePoint = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
};

export type StockChartData = {
  symbol: string;
  name: string;
  code: string;
  currentPrice: number;
  averageBuyPrice?: number;
  ranges: Record<
    TimeRange,
    {
      prices: PricePoint[];
      candles: CandlePoint[];
    }
  >;
};

export type StockSummary = {
  dayChangeAmount: number;
  dayChangeRate: number;
  previousClose: number;
  openingPrice: number;
  previousVolume: number;
  marketCap: number;
  dividendYield: number;
};

export type StockChartBundle = {
  chartData: StockChartData;
  sourceStock: StockQuote;
  summary: StockSummary;
};

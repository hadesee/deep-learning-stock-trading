export type PipelineSentimentLabel = "POSITIVE" | "NEUTRAL" | "NEGATIVE" | string;

export type PipelineAnalysisResult = {
  ticker: string;
  company_name: string;
  label: PipelineSentimentLabel;
  label_ko: string;
  sentiment_score: number;
  confidence: number;
  summary: string;
  positive_factors: string[];
  negative_factors: string[];
  key_data_points: string[];
  used_news_indices: number[];
  caution: string;
  /** Gemini news step: actionable position/risk note for the stock. */
  trading_insight?: string;
};

export type PipelineInputRow = {
  ticker?: string;
  company_name?: string;
  lstm_status?: string;
  lstm_pred_return?: number;
  ensemble_pred_return?: number;
  lstm_base_date?: string;
  p_up?: number;
  pred_rank?: number;
  prediction_status?: string;
  transformer_base_date?: string;
  [key: string]: unknown;
};

export type PipelineNewsItem = {
  index: number;
  pub_date: string;
  source: string;
  title: string;
  url?: string;
};

export type PipelineOutputRow = {
  result: PipelineAnalysisResult;
  input_row: PipelineInputRow;
  news: PipelineNewsItem[];
};

export type RiskState = "Low" | "Normal" | "Elevated" | "High";

export type MarketSummary = {
  generatedAt: string;
  marketState: string;
  candidateCount: number;
  riskState: RiskState;
  strategySlots: number;
  averageConfidence: number;
  averagePredictedReturn: number;
  positiveCount: number;
  neutralCount: number;
  negativeCount: number;
};

export type Candidate = {
  ticker: string;
  companyName: string;
  sentimentLabel: PipelineSentimentLabel;
  sentimentLabelKo: string;
  sentimentScore: number;
  confidence: number;
  predictedReturn: number | null;
  upProbability?: number | null;
  lstmStatus: string;
  summary: string;
  positiveFactors: string[];
  negativeFactors: string[];
  newsCount: number;
  latestNewsTitle?: string;
};

export type LandingData = {
  marketSummary: MarketSummary;
  candidates: Candidate[];
};

export type MarketDirection = "up" | "down" | "flat";

export type MarketIndexSnapshot = {
  symbol: string;
  name: string;
  value: number;
  change: number;
  changeRate: number;
  direction: MarketDirection;
  miniSeries: number[];
};

export type InvestorFlow = {
  personal: number;
  foreign: number;
  institution: number;
};

/**
 * One daily OHLC candle. Mirrors the shape a KIS daily-chart wrapper
 * (`FHKST03010100`) returns, so backend data can flow in unchanged.
 */
export type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type StockQuote = {
  code: string;
  name: string;
  market: "KOSPI" | "KOSDAQ";
  /**
   * KOSPI200 membership. Set by the backend (its universe is the KOSPI200
   * pool); when absent the UI falls back to a small bundled code set so mock
   * data still filters sensibly.
   */
  isKospi200?: boolean;
  currentPrice: number;
  change: number;
  changeRate: number;
  direction: MarketDirection;
  accumulatedVolume: number;
  tradingValue: number;
  tradingValueRank: number;
  investorFlow: InvestorFlow;
  aiSummary: string;
  sentimentLabel: PipelineSentimentLabel;
  confidence: number;
  predictedReturn: number | null;
  upProbability?: number | null;
  miniSeries: number[];
  /**
   * Daily OHLC history, oldest first. Supplied by the backend daily-chart
   * endpoint; when absent the UI derives a deterministic placeholder anchored
   * to `currentPrice` so the candle chart still renders.
   */
  candles?: Candle[];
};

export type MarketEvent = {
  timeLabel: string;
  title: string;
};

export type MarketDashboardData = {
  generatedAt: string;
  sessionLabel: string;
  indices: MarketIndexSnapshot[];
  stocks: StockQuote[];
  watchlist: StockQuote[];
  focusedStockCode: string;
  events: MarketEvent[];
};

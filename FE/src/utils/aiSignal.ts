import type { PipelineOutputRow, StockQuote } from "../types/trading";

/**
 * A validated OpenAI news-sentiment result always carries a positive
 * confidence. The Python pipeline writes confidence 0 when the LLM step is
 * skipped (no `OPENAI_API_KEY`, package missing, or an API error) and falls
 * back to an LSTM-direction-only label — so confidence is the honest signal for
 * "is there a real LLM analysis here".
 */
export function hasLlmSentiment(stock: Pick<StockQuote, "confidence">): boolean {
  return stock.confidence > 0;
}

/** Whether the LSTM model produced a next-day return prediction for this stock. */
export function hasLstmPrediction(stock: Pick<StockQuote, "predictedReturn">): boolean {
  return stock.predictedReturn !== null;
}

/**
 * User-facing AI summary text. The pipeline's fallback rows carry an internal
 * diagnostic string (e.g. "LLM analysis fallback: OPENAI_API_KEY is not
 * configured") that must never reach the UI, so we render an honest Korean note
 * based on which signals are actually present instead of the raw summary.
 */
export function describeAiSummary(stock: Pick<StockQuote, "aiSummary" | "confidence" | "predictedReturn">): string {
  if (hasLlmSentiment(stock)) {
    return stock.aiSummary;
  }

  if (hasLstmPrediction(stock)) {
    return "OpenAI 뉴스 감성 분석이 연결되지 않아 LSTM 예측 방향만 반영한 결과입니다. (OPENAI_API_KEY 설정 시 뉴스 기반 감성 분석이 추가됩니다.)";
  }

  return "AI 분석이 아직 연결되지 않았습니다.";
}

/** The 6-digit ticker a pipeline row analyzed (top-level `ticker` is null; it lives in `result`). */
export function pipelineRowTicker(row: PipelineOutputRow): string {
  return String(row.result?.ticker ?? row.input_row?.ticker ?? "").padStart(6, "0");
}

/** Finds the pipeline analysis row for a stock code, if the pipeline covered it. */
export function findPipelineRow(rows: PipelineOutputRow[], code: string): PipelineOutputRow | undefined {
  const target = code.padStart(6, "0");
  return rows.find((row) => pipelineRowTicker(row) === target);
}

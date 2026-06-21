import type { PipelineOutputRow, StockQuote } from "../types/trading";

/**
 * A validated OpenAI news-sentiment result carries positive confidence. The
 * default Transformer-only run writes confidence 0, which is intentionally not
 * treated as an LLM analysis.
 */
export function hasLlmSentiment(stock: Pick<StockQuote, "confidence">): boolean {
  return stock.confidence > 0;
}

/** Whether a model-only signal exists for this stock. */
export function hasLstmPrediction(stock: Pick<StockQuote, "predictedReturn" | "upProbability">): boolean {
  return stock.predictedReturn !== null || (stock.upProbability !== undefined && stock.upProbability !== null);
}

function isInternalDiagnostic(summary: string): boolean {
  return /OPENAI_API_KEY|OPEN_AI_KEY|LLM analysis fallback|API key/i.test(summary);
}

/**
 * User-facing AI summary text. Internal diagnostics must not leak to the UI,
 * but Transformer-only summaries are valid evidence and should be shown.
 */
export function describeAiSummary(
  stock: Pick<StockQuote, "aiSummary" | "confidence" | "predictedReturn" | "upProbability">,
): string {
  if (hasLlmSentiment(stock)) {
    return stock.aiSummary;
  }

  const summary = stock.aiSummary.trim();
  if (summary && !isInternalDiagnostic(summary)) {
    return summary;
  }

  if (hasLstmPrediction(stock)) {
    return "OpenAI 뉴스 감성 분석은 실행되지 않았고, 현재는 모델 예측 신호만 반영한 결과입니다.";
  }

  return "AI 분석이 아직 연결되지 않았습니다.";
}

/** The 6-digit ticker a pipeline row analyzed. */
export function pipelineRowTicker(row: PipelineOutputRow): string {
  return String(row.result?.ticker ?? row.input_row?.ticker ?? "").padStart(6, "0");
}

/** Finds the pipeline analysis row for a stock code, if the pipeline covered it. */
export function findPipelineRow(rows: PipelineOutputRow[], code: string): PipelineOutputRow | undefined {
  const target = code.padStart(6, "0");
  return rows.find((row) => pipelineRowTicker(row) === target);
}

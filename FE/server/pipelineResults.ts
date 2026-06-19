import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineOutputRow, StockQuote } from "../src/types/trading";
import { readLastSnapshot, writeDashboardSnapshot } from "./dashboardCache";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

/**
 * The Python pipeline writes its final analysis here (see docs/api-contract.md).
 * The dev server's cwd is `FE/`, so the file usually lives one level up; we also
 * probe a couple of common alternatives so the loader works regardless of where
 * the process is started from.
 */
function candidatePaths(): string[] {
  const fileName = "final_stock_lstm_news_llm_result.json";
  const override = process.env.PIPELINE_RESULT_PATH;
  const outputDir = process.env.PIPELINE_OUTPUT_DIR;
  const cwd = process.cwd();

  return [
    ...(override ? [override] : []),
    ...(outputDir ? [join(outputDir, fileName)] : []),
    join(cwd, "outputs", fileName),
    join(cwd, "..", "outputs", fileName),
    join(cwd, "..", "..", "outputs", fileName),
  ];
}

function isPipelineRows(value: unknown): value is PipelineOutputRow[] {
  return (
    Array.isArray(value) &&
    value.every((row) => row !== null && typeof row === "object" && "result" in row && "input_row" in row)
  );
}

/**
 * Loads the pipeline analysis rows from disk. Returns `null` (not an empty
 * array) when no output file is present yet, so callers can distinguish
 * "pipeline hasn't run" from "pipeline ran and found nothing" and fall back to
 * bundled mock data accordingly.
 */
export async function loadPipelineRows(): Promise<PipelineOutputRow[] | null> {
  for (const path of candidatePaths()) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isPipelineRows(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return null;
}

/**
 * Payload for `GET /api/candidates`: the real pipeline output when present,
 * otherwise an empty array. The frontend substitutes bundled mock data on an
 * empty/failed response, so mock data stays out of the server bundle.
 */
export async function getCandidatesPayload(): Promise<PipelineOutputRow[]> {
  return (await loadPipelineRows()) ?? [];
}

/**
 * Indexes pipeline rows by 6-digit ticker code for quick merge into KIS quotes.
 */
export function indexPipelineByTicker(rows: PipelineOutputRow[]): Map<string, PipelineOutputRow> {
  const map = new Map<string, PipelineOutputRow>();

  for (const row of rows) {
    const ticker = String(row.result?.ticker ?? row.input_row?.ticker ?? "").padStart(6, "0");
    if (ticker && ticker !== "000000") {
      map.set(ticker, row);
    }
  }

  return map;
}

function toFiniteOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function applyPipelineRow(stock: StockQuote, row: PipelineOutputRow | undefined): StockQuote {
  if (!row) {
    return stock;
  }

  const predictedReturn =
    toFiniteOrNull(row.input_row?.ensemble_pred_return) ?? toFiniteOrNull(row.input_row?.lstm_pred_return);

  return {
    ...stock,
    aiSummary: row.result?.summary?.trim() ? row.result.summary : stock.aiSummary,
    confidence: toFiniteOrNull(row.result?.confidence) ?? stock.confidence,
    predictedReturn,
    sentimentLabel: row.result?.label ?? stock.sentimentLabel,
  };
}

/**
 * After the Python analysis writes its JSON output, refresh the cached dashboard
 * in place so the next dashboard reload immediately shows AI fields without
 * rebuilding every KIS quote.
 */
export async function refreshDashboardAiFieldsFromPipelineOutput(): Promise<boolean> {
  const rows = await loadPipelineRows();
  const snapshot = await readLastSnapshot();
  if (!rows || !snapshot) {
    return false;
  }

  const byTicker = indexPipelineByTicker(rows);
  const data = {
    ...snapshot,
    stocks: snapshot.stocks.map((stock) => applyPipelineRow(stock, byTicker.get(stock.code))),
    watchlist: snapshot.watchlist.map((stock) => applyPipelineRow(stock, byTicker.get(stock.code))),
  };

  await writeDashboardSnapshot(data);
  return true;
}

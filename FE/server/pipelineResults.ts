import { access, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PipelineInputRow, PipelineOutputRow, StockQuote } from "../src/types/trading";
import { readLastSnapshot, writeDashboardSnapshot } from "./dashboardCache";

declare const process: {
  cwd: () => string;
  env: Record<string, string | undefined>;
};

const JSON_RESULT_FILES = ["final_stock_transformer_news_llm_result.json"];
const LEGACY_JSON_RESULT_FILES = ["final_stock_lstm_news_llm_result.json"];
const CSV_RESULT_FILES = ["step2_final_top10.csv"];
const NEWS_RESULT_FILES = ["news_gemini_result.json"];

type GeminiEvaluation = {
  sentiment?: unknown;
  impact_score?: unknown;
  summary?: unknown;
  trading_insight?: unknown;
};

type GeminiNewsEntry = {
  ticker?: unknown;
  company_name?: unknown;
  news_count?: unknown;
  evaluation?: GeminiEvaluation;
  news?: unknown;
};

type LoadedRows = {
  mtimeMs: number;
  rows: PipelineOutputRow[];
};

/**
 * The dev server's cwd is usually `FE/`, so probe the root outputs folder plus
 * common alternatives. `PIPELINE_RESULT_PATH` may point to either JSON or CSV.
 */
function candidatePaths(fileNames: string[]): string[] {
  const override = process.env.PIPELINE_RESULT_PATH;
  const outputDir = process.env.PIPELINE_OUTPUT_DIR;
  const cwd = process.cwd();
  const paths = [
    ...(override ? [override] : []),
    ...(outputDir ? fileNames.map((fileName) => join(outputDir, fileName)) : []),
    ...fileNames.flatMap((fileName) => [
      join(cwd, "outputs", fileName),
      join(cwd, "..", "outputs", fileName),
      join(cwd, "..", "..", "outputs", fileName),
    ]),
  ];

  return [...new Set(paths)];
}

function isPipelineRows(value: unknown): value is PipelineOutputRow[] {
  return (
    Array.isArray(value) &&
    value.every((row) => row !== null && typeof row === "object" && "result" in row && "input_row" in row)
  );
}

function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") {
        index += 1;
      }
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) {
        rows.push(row);
      }
      row = [];
      cell = "";
      continue;
    }

    cell += char;
  }

  row.push(cell);
  if (row.some((value) => value.trim() !== "")) {
    rows.push(row);
  }

  const headers = rows[0]?.map((header) => header.replace(/^\uFEFF/, "").trim()) ?? [];
  if (headers.length === 0) {
    return [];
  }

  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
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

function boolFromCsv(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return ["1", "true", "yes", "y"].includes(String(value ?? "").trim().toLowerCase());
}

function upProbabilityFromInput(input: PipelineInputRow | undefined): number | null {
  return toFiniteOrNull(input?.p_up);
}

function modelScoreFromInput(input: PipelineInputRow | undefined): number | null {
  const pUp = upProbabilityFromInput(input);
  if (pUp !== null) {
    return null;
  }

  return toFiniteOrNull(input?.ensemble_pred_return) ?? toFiniteOrNull(input?.lstm_pred_return);
}

function stringValue(value: unknown, fallback = ""): string {
  const text = String(value ?? "").trim();
  return text || fallback;
}

function transformerCsvToPipelineRow(record: Record<string, string>): PipelineOutputRow | null {
  const ticker = stringValue(record.ticker ?? record["종목코드"]).padStart(6, "0");
  if (!ticker || ticker === "000000") {
    return null;
  }

  const companyName = stringValue(record.company_name ?? record["종목명"], ticker);
  const pUp = toFiniteOrNull(record.p_up);
  const predRank = toFiniteOrNull(record.pred_rank);
  const supplyPass = boolFromCsv(record.supply_pass);
  const label = supplyPass || (pUp !== null && pUp >= 0.5) ? "POSITIVE" : "NEGATIVE";
  const pUpPercent = pUp === null ? null : Number((pUp * 100).toFixed(2));
  const status = stringValue(record.prediction_status, "unknown");
  const keyDataPoints = [
    pUpPercent === null ? undefined : `Transformer P(up): ${pUpPercent}%`,
    predRank === null ? undefined : `Prediction rank: ${predRank}`,
    record.supply_score ? `Supply score: ${record.supply_score}` : undefined,
    record.supply_base_end_date ? `Supply base date: ${record.supply_base_end_date}` : undefined,
  ].filter((value): value is string => Boolean(value));

  const inputRow: PipelineInputRow = {
    ...record,
    company_name: companyName,
    p_up: pUp ?? undefined,
    pred_rank: predRank ?? undefined,
    prediction_status: status,
    ticker,
    // CSV columns spread above arrive as strings; the detail page calls
    // `formatRate(...).toFixed` on these, so coerce to number | undefined.
    lstm_pred_return: toFiniteOrNull(record.lstm_pred_return) ?? undefined,
    ensemble_pred_return: toFiniteOrNull(record.ensemble_pred_return) ?? undefined,
  };

  return {
    input_row: inputRow,
    news: [],
    result: {
      caution: "News and OpenAI sentiment were not run for this output.",
      company_name: companyName,
      confidence: 0,
      key_data_points: keyDataPoints,
      label,
      label_ko: label === "POSITIVE" ? "긍정" : "부정",
      negative_factors: supplyPass ? [] : ["Supply filter did not pass or was unavailable."],
      positive_factors: supplyPass ? ["Passed Transformer ranking and supply filter."] : [],
      sentiment_score: pUp === null ? 0 : Number(((pUp - 0.5) * 2).toFixed(4)),
      summary:
        pUpPercent === null
          ? `Transformer prediction status is ${status}.`
          : `Transformer P(up) ${pUpPercent}% with supply filter ${supplyPass ? "passed" : "not passed"}.`,
      ticker,
      used_news_indices: [],
    },
  };
}

async function loadJsonRows(): Promise<LoadedRows | null> {
  let latest: LoadedRows | null = null;

  for (const path of candidatePaths(JSON_RESULT_FILES)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isPipelineRows(parsed)) {
        const mtimeMs = (await stat(path)).mtimeMs;
        if (!latest || mtimeMs > latest.mtimeMs) {
          latest = { mtimeMs, rows: parsed };
        }
      }
    } catch {
      // Try the next candidate path.
    }
  }

  return latest;
}

async function loadCsvRows(): Promise<LoadedRows | null> {
  let latest: LoadedRows | null = null;

  for (const path of candidatePaths(CSV_RESULT_FILES)) {
    try {
      await access(path);
    } catch {
      continue;
    }

    try {
      const rows = parseCsv(await readFile(path, "utf8"))
        .map(transformerCsvToPipelineRow)
        .filter((row): row is PipelineOutputRow => row !== null);
      if (rows.length > 0) {
        const mtimeMs = (await stat(path)).mtimeMs;
        if (!latest || mtimeMs > latest.mtimeMs) {
          latest = { mtimeMs, rows };
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to load Transformer candidate CSV ${path}: ${message}`);
    }
  }

  return latest;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Maps Gemini's Bullish/Bearish/Neutral to the pipeline's sentiment label. */
function sentimentLabelFromGemini(sentiment: string): { label: string; label_ko: string } {
  const normalized = sentiment.toLowerCase();
  if (normalized.includes("bull") || normalized.includes("positive") || sentiment.includes("호재")) {
    return { label: "POSITIVE", label_ko: "긍정" };
  }
  if (normalized.includes("bear") || normalized.includes("negative") || sentiment.includes("악재")) {
    return { label: "NEGATIVE", label_ko: "부정" };
  }
  return { label: "NEUTRAL", label_ko: "중립" };
}

function toPipelineNews(value: unknown): PipelineOutputRow["news"] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((raw, index) => {
      const item = (raw ?? {}) as Record<string, unknown>;
      const url = stringValue(item.url);
      return {
        index: toFiniteOrNull(item.index) ?? index + 1,
        pub_date: stringValue(item.pub_date),
        source: stringValue(item.source),
        title: stringValue(item.title),
        url: url || undefined,
      };
    })
    .filter((item) => item.title !== "");
}

/**
 * Overlays one Gemini news entry onto a Transformer candidate row: attaches the
 * crawled news and, when the LLM evaluation is present, rewrites the sentiment
 * label, confidence (from `impact_score`), summary and trading insight so the
 * frontend's news-sentiment view lights up. A positive `confidence` is what
 * `hasLlmSentiment` keys on, so analyzed rows always get a non-zero floor.
 */
function applyNewsToRow(row: PipelineOutputRow, entry: GeminiNewsEntry): PipelineOutputRow {
  const evaluation = entry.evaluation ?? {};
  const impact = toFiniteOrNull(evaluation.impact_score);
  const summary = stringValue(evaluation.summary);
  const sentiment = stringValue(evaluation.sentiment);
  const tradingInsight = stringValue(evaluation.trading_insight);
  const news = toPipelineNews(entry.news);

  const hasEvaluation = sentiment !== "" || summary !== "" || impact !== null;
  if (!hasEvaluation) {
    // Gemini failed/skipped this ticker — still surface any crawled headlines.
    return news.length > 0 ? { ...row, news } : row;
  }

  const { label, label_ko } = sentimentLabelFromGemini(sentiment);
  const newsCount = toFiniteOrNull(entry.news_count) ?? news.length;
  const geminiKeyPoints = [
    impact === null ? undefined : `Gemini 영향도 점수: ${impact}/10`,
    newsCount > 0 ? `분석 뉴스 ${newsCount}건` : undefined,
  ].filter((value): value is string => Boolean(value));

  return {
    ...row,
    news,
    result: {
      ...row.result,
      label,
      label_ko,
      sentiment_score: impact === null ? 0 : clamp(impact / 10, -1, 1),
      confidence: impact === null ? 0.1 : clamp(Math.abs(impact) / 10, 0.1, 1),
      summary: summary || row.result.summary,
      trading_insight: tradingInsight || undefined,
      key_data_points: [...row.result.key_data_points, ...geminiKeyPoints],
      caution: "",
      company_name: row.result.company_name || stringValue(entry.company_name),
    },
  };
}

/** Loads the latest Gemini news result keyed by 6-digit ticker, or null if absent. */
async function loadNewsResult(): Promise<Map<string, GeminiNewsEntry> | null> {
  let latest: { mtimeMs: number; map: Map<string, GeminiNewsEntry> } | null = null;

  for (const path of candidatePaths(NEWS_RESULT_FILES)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const mtimeMs = (await stat(path)).mtimeMs;
      if (latest && mtimeMs <= latest.mtimeMs) {
        continue;
      }

      const map = new Map<string, GeminiNewsEntry>();
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === "object") {
          map.set(String(key).padStart(6, "0"), value as GeminiNewsEntry);
        }
      }
      latest = { mtimeMs, map };
    } catch {
      // Try the next candidate path.
    }
  }

  return latest?.map ?? null;
}

/** Overlays the Gemini news result onto candidate rows, matched by ticker. */
async function overlayNewsResult(rows: PipelineOutputRow[]): Promise<PipelineOutputRow[]> {
  const news = await loadNewsResult();
  if (!news) {
    return rows;
  }

  return rows.map((row) => {
    const ticker = String(row.result?.ticker ?? row.input_row?.ticker ?? "").padStart(6, "0");
    const entry = news.get(ticker);
    return entry ? applyNewsToRow(row, entry) : row;
  });
}

async function loadBaseRows(): Promise<PipelineOutputRow[] | null> {
  const csvRows = await loadCsvRows();
  if (csvRows) {
    return csvRows.rows;
  }

  const transformerJsonRows = await loadJsonRows();
  if (transformerJsonRows) {
    return transformerJsonRows.rows;
  }

  for (const path of candidatePaths(LEGACY_JSON_RESULT_FILES)) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (isPipelineRows(parsed)) {
        return parsed;
      }
    } catch {
      // Try the next legacy path.
    }
  }

  return null;
}

/**
 * Loads pipeline analysis rows from disk and overlays the Gemini news result
 * (crolling.py output) when present. Returns `null` when no candidate output
 * file exists yet, so callers can distinguish "not run" from "ran and found zero".
 */
export async function loadPipelineRows(): Promise<PipelineOutputRow[] | null> {
  const baseRows = await loadBaseRows();
  if (!baseRows) {
    return null;
  }

  return overlayNewsResult(baseRows);
}

/**
 * Payload for `GET /api/candidates`: real pipeline output when present,
 * otherwise an empty array. The frontend decides whether to fall back to mock.
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

function applyPipelineRow(stock: StockQuote, row: PipelineOutputRow | undefined): StockQuote {
  if (!row) {
    return stock;
  }

  return {
    ...stock,
    aiSummary: row.result?.summary?.trim() ? row.result.summary : stock.aiSummary,
    confidence: toFiniteOrNull(row.result?.confidence) ?? stock.confidence,
    predictedReturn: modelScoreFromInput(row.input_row),
    sentimentLabel: row.result?.label ?? stock.sentimentLabel,
    upProbability: upProbabilityFromInput(row.input_row),
  };
}

/**
 * After the Python analysis writes its output, refresh the cached dashboard in
 * place so the next dashboard reload immediately shows AI fields.
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

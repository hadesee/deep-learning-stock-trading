import { mockPipelineResults } from "../data/mockPipelineResults";
import { mockMarketDashboard } from "../data/mockMarketDashboard";
import type {
  Candidate,
  LandingData,
  MarketDashboardData,
  MarketSummary,
  PipelineOutputRow,
  RiskState,
} from "../types/trading";

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function normalizeCandidate(row: PipelineOutputRow): Candidate {
  const predictedReturn =
    toNumber(row.input_row.ensemble_pred_return) ?? toNumber(row.input_row.lstm_pred_return);

  return {
    ticker: row.result.ticker,
    companyName: row.result.company_name,
    sentimentLabel: row.result.label,
    sentimentLabelKo: row.result.label_ko,
    sentimentScore: row.result.sentiment_score,
    confidence: row.result.confidence,
    predictedReturn,
    lstmStatus: String(row.input_row.lstm_status ?? "UNKNOWN"),
    summary: row.result.summary,
    positiveFactors: row.result.positive_factors,
    negativeFactors: row.result.negative_factors,
    newsCount: row.news.length,
    latestNewsTitle: row.news[0]?.title,
  };
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function deriveRiskState(candidates: Candidate[]): RiskState {
  const negativeCount = candidates.filter((candidate) => candidate.sentimentLabel === "NEGATIVE").length;
  const averagePredictedReturn = average(
    candidates
      .map((candidate) => candidate.predictedReturn)
      .filter((value): value is number => value !== null),
  );

  if (negativeCount >= 2 || averagePredictedReturn < 0) {
    return "Elevated";
  }

  if (averagePredictedReturn > 1 && negativeCount === 0) {
    return "Low";
  }

  return "Normal";
}

function deriveMarketState(summary: Pick<MarketSummary, "positiveCount" | "negativeCount" | "averagePredictedReturn">) {
  if (summary.positiveCount > summary.negativeCount && summary.averagePredictedReturn > 0.8) {
    return "강세 우위";
  }

  if (summary.negativeCount > summary.positiveCount || summary.averagePredictedReturn < 0) {
    return "약세 경계";
  }

  return "중립 우위";
}

export function normalizePipelineResults(rows: PipelineOutputRow[]): LandingData {
  const candidates = rows.map(normalizeCandidate);
  const predictedReturns = candidates
    .map((candidate) => candidate.predictedReturn)
    .filter((value): value is number => value !== null);
  const positiveCount = candidates.filter((candidate) => candidate.sentimentLabel === "POSITIVE").length;
  const neutralCount = candidates.filter((candidate) => candidate.sentimentLabel === "NEUTRAL").length;
  const negativeCount = candidates.filter((candidate) => candidate.sentimentLabel === "NEGATIVE").length;
  const averagePredictedReturn = average(predictedReturns);

  const partialSummary = {
    positiveCount,
    negativeCount,
    averagePredictedReturn,
  };

  const marketSummary: MarketSummary = {
    generatedAt: new Date().toISOString(),
    marketState: deriveMarketState(partialSummary),
    candidateCount: candidates.length,
    riskState: deriveRiskState(candidates),
    strategySlots: candidates.filter(
      (candidate) =>
        candidate.lstmStatus === "OK" &&
        candidate.sentimentLabel !== "NEGATIVE" &&
        (candidate.predictedReturn ?? 0) > 0,
    ).length,
    averageConfidence: average(candidates.map((candidate) => candidate.confidence)),
    averagePredictedReturn,
    positiveCount,
    neutralCount,
    negativeCount,
  };

  return {
    marketSummary,
    candidates,
  };
}

export function getLandingData(): LandingData {
  return normalizePipelineResults(mockPipelineResults);
}

/**
 * localStorage key + schema version for the last successfully synced dashboard.
 * Bump the version if `MarketDashboardData` changes shape so stale payloads from
 * an older build are ignored rather than rendered with missing fields.
 */
const DASHBOARD_CACHE_KEY = "kospi-dashboard-cache.v1";

function getLocalStorage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    // Storage can throw in private mode / sandboxed iframes.
    return null;
  }
}

function isMarketDashboardData(value: unknown): value is MarketDashboardData {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as MarketDashboardData).stocks) &&
    // The workspace assumes at least one stock (focused selection, table); an
    // empty cached payload must fall through to the bundled mock instead.
    (value as MarketDashboardData).stocks.length > 0 &&
    Array.isArray((value as MarketDashboardData).indices) &&
    typeof (value as MarketDashboardData).focusedStockCode === "string"
  );
}

/**
 * The most recent successfully synced dashboard, persisted by
 * {@link fetchLiveMarketDashboardData}. Lets the next visit render the latest
 * real data immediately instead of the bundled mock while a fresh sync runs.
 */
export function readCachedMarketDashboardData(): MarketDashboardData | null {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }

  try {
    const parsed = JSON.parse(storage.getItem(DASHBOARD_CACHE_KEY) ?? "null") as unknown;
    return isMarketDashboardData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedMarketDashboardData(data: MarketDashboardData): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(DASHBOARD_CACHE_KEY, JSON.stringify(data));
  } catch {
    // Quota or serialization failure is non-fatal; the in-memory data still shows.
  }
}

/**
 * Initial dashboard to render before the first sync completes: the last synced
 * snapshot when available, otherwise the bundled mock so the board never starts
 * empty.
 */
export function getMarketDashboardData(): MarketDashboardData {
  return readCachedMarketDashboardData() ?? mockMarketDashboard;
}

/** localStorage key for the user's watchlist codes. */
const WATCHLIST_STORAGE_KEY = "kospi-watchlist.v1";

/**
 * The user's persisted watchlist (stock codes). `null` means "never saved" so
 * the caller can seed from the server's default watchlist; an empty array is a
 * deliberate "user removed everything" state and is respected as-is.
 */
export function readWatchlistCodes(): string[] | null {
  const storage = getLocalStorage();
  if (!storage) {
    return null;
  }

  try {
    const parsed = JSON.parse(storage.getItem(WATCHLIST_STORAGE_KEY) ?? "null") as unknown;
    return Array.isArray(parsed) && parsed.every((code) => typeof code === "string") ? parsed : null;
  } catch {
    return null;
  }
}

export function writeWatchlistCodes(codes: string[]): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(WATCHLIST_STORAGE_KEY, JSON.stringify(codes));
  } catch {
    // Quota failure is non-fatal; the in-memory list still works this session.
  }
}

/**
 * Base URL for the backend API. When unset (the default until the Python
 * KIS/pipeline API server is deployed) the app serves bundled mock data so the
 * site always renders. Configure via `VITE_API_BASE_URL` to enable live data.
 */
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");

export function isLiveApiEnabled(): boolean {
  return API_BASE_URL.length > 0;
}

/**
 * Hard ceiling on a single API request. Without this a slow/hung backend (e.g.
 * the KIS upstream stalling) leaves users staring at an infinite spinner. On
 * timeout the caller's fallback (mock data or error UI) kicks in instead.
 */
const REQUEST_TIMEOUT_MS = 8000;
const DASHBOARD_REQUEST_TIMEOUT_MS = 75000;
const CANDIDATE_ANALYSIS_TIMEOUT_MS = 60 * 60 * 1000;

export type CandidateAnalysisRunResult = {
  dashboardUpdated: boolean;
  elapsedMs: number;
  inputJsonPath?: string;
  outputJsonPath: string;
  rows: number;
  status: "completed";
};

/**
 * Combines the caller's abort signal with an internal timeout so the request is
 * aborted by whichever fires first. Returns a cleanup to clear the timer.
 */
function withRequestTimeout(signal: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`요청 시간이 초과되었습니다 (${timeoutMs}ms)`, "TimeoutError"));
  }, timeoutMs);

  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) {
      forwardAbort();
    } else {
      signal.addEventListener("abort", forwardAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    },
  };
}

/**
 * An aborted request (component unmount, reload, or navigation) is not a backend
 * failure — it must not be logged as "API unavailable" or swallowed into a mock
 * fallback. Re-throw it so {@link useAsyncData} ignores the discarded result.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

async function fetchJson<T>(
  path: string,
  signal?: AbortSignal,
  baseUrl = API_BASE_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const { signal: requestSignal, cleanup } = withRequestTimeout(signal, timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      signal: requestSignal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      throw new Error(`요청 실패 (${response.status}): ${path}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`JSON 응답이 아닙니다: ${path}`);
    }

    return (await response.json()) as T;
  } finally {
    cleanup();
  }
}

async function postJson<T>(
  path: string,
  signal?: AbortSignal,
  baseUrl = API_BASE_URL,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const { signal: requestSignal, cleanup } = withRequestTimeout(signal, timeoutMs);

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      signal: requestSignal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) {
      let message = `요청 실패 (${response.status}): ${path}`;
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

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new Error(`JSON 응답이 아닙니다: ${path}`);
    }

    return (await response.json()) as T;
  } finally {
    cleanup();
  }
}

/**
 * Landing summary + ranked candidates. Falls back to mock data when no backend
 * is configured. See `docs/api-contract.md` for the endpoint shapes.
 */
export async function fetchLandingData(signal?: AbortSignal): Promise<LandingData> {
  try {
    const rows = await fetchJson<PipelineOutputRow[]>("/api/candidates", signal, API_BASE_URL);
    if (Array.isArray(rows) && rows.length > 0) {
      return normalizePipelineResults(rows);
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (import.meta.env.DEV) {
      console.warn("Candidates API unavailable. Falling back to mock data.", error);
    }
  }

  return normalizePipelineResults(mockPipelineResults);
}

/**
 * Raw Python pipeline rows for the stock detail page. Unlike {@link fetchLandingData}
 * this does NOT normalize — the detail page needs the full unflattened evidence
 * (`result.positive_factors` / `negative_factors` / `key_data_points`, the
 * `input_row` model metadata, and the `news` list). Falls back to bundled mock
 * pipeline output when the backend is unavailable so the page still renders.
 */
export async function fetchPipelineCandidates(signal?: AbortSignal): Promise<PipelineOutputRow[]> {
  try {
    const rows = await fetchJson<PipelineOutputRow[]>("/api/candidates", signal, API_BASE_URL);
    if (Array.isArray(rows) && rows.length > 0) {
      return rows;
    }
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (import.meta.env.DEV) {
      console.warn("Candidates API unavailable. Falling back to mock data.", error);
    }
  }

  return mockPipelineResults;
}

export async function runCandidateAnalysis(signal?: AbortSignal): Promise<CandidateAnalysisRunResult> {
  return postJson<CandidateAnalysisRunResult>(
    "/api/candidates/run",
    signal,
    isLiveApiEnabled() ? API_BASE_URL : "",
    CANDIDATE_ANALYSIS_TIMEOUT_MS,
  );
}

/**
 * Full Korean market dashboard payload for the trading board. Falls back to
 * mock data when no backend is configured.
 */
export async function fetchMarketDashboardData(
  signal?: AbortSignal,
): Promise<MarketDashboardData> {
  try {
    return await fetchLiveMarketDashboardData(signal);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }

    if (import.meta.env.DEV) {
      console.warn("KIS dashboard API unavailable. Falling back to mock data.", error);
    }

    return mockMarketDashboard;
  }
}

export async function fetchLiveMarketDashboardData(
  signal?: AbortSignal,
): Promise<MarketDashboardData> {
  const data = await fetchJson<MarketDashboardData>(
    "/api/korean-market/dashboard",
    signal,
    isLiveApiEnabled() ? API_BASE_URL : "",
    DASHBOARD_REQUEST_TIMEOUT_MS,
  );

  // Persist each successful sync so the next pre-sync render uses the latest
  // real data instead of the stale bundled mock.
  writeCachedMarketDashboardData(data);
  return data;
}

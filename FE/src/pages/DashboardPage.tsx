import { useEffect, useRef, useState } from "react";
import { MarketWorkspace } from "../components/market/MarketWorkspace";
import { usePageTitle } from "../hooks/usePageTitle";
import {
  fetchCandidateQuotes,
  fetchMarketIndicesData,
  fetchMarketDashboardData,
  fetchPipelineCandidates,
  getMarketDashboardData,
  mergeMarketIndices,
  runCandidateAnalysis,
} from "../services/tradingData";
import { overlayLiveAnalysis } from "../data/pipelineAdapter";
import type { CandidateAnalysisStatus } from "../services/tradingData";
import type { MarketDashboardData, PipelineOutputRow, StockQuote } from "../types/trading";

type AnalysisPhase = "idle" | "restoring" | "running" | "done";

const ANALYSIS_CACHE_KEY = "kospi-dashboard-analysis.v1";

type CachedAnalysis = {
  data: MarketDashboardData | null;
  rows: PipelineOutputRow[];
};

/** Candidate price loading: retry stragglers a few times to ride out KIS rate-limit contention. */
const HYDRATE_MAX_ATTEMPTS = 3;
const HYDRATE_RETRY_DELAY_MS = 2500;

function elapsedLabel(startMs: number): string {
  return elapsedMsLabel(Date.now() - startMs);
}

function elapsedMsLabel(elapsedMs: number): string {
  const total = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return `${minutes}분 ${seconds}초 경과`;
}

function describeAnalysisStatus(status: CandidateAnalysisStatus, fallbackStartedAt: number): string {
  const elapsed = elapsedMsLabel(status.elapsedMs ?? Date.now() - fallbackStartedAt);
  if (status.progress) {
    return `${status.progress.message} · ${status.progress.progressPercent}% · ${elapsed}`;
  }

  return `integrated_pipeline.py 실행 중… ${elapsed}`;
}

/** A pipeline row is "real" output (vs the bundled fallback) when it carries a transformer rank. */
function looksLikeLiveRows(rows: PipelineOutputRow[]): boolean {
  if (rows.length === 0) {
    return true;
  }

  return rows.some((row) => row.input_row && row.input_row.pred_rank !== undefined && row.input_row.pred_rank !== null);
}

function looksLikeDashboardData(value: unknown): value is MarketDashboardData {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<MarketDashboardData>;
  return Array.isArray(candidate.indices) && Array.isArray(candidate.stocks) && Array.isArray(candidate.watchlist);
}

function readCachedAnalysis(): CachedAnalysis | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(ANALYSIS_CACHE_KEY) ?? "null") as unknown;
    // Migrate the previous rows-only cache shape. It remains a network fallback,
    // but cannot skip the first quote hydration because it has no rendered data.
    if (Array.isArray(parsed)) {
      return looksLikeLiveRows(parsed as PipelineOutputRow[]) ? { data: null, rows: parsed as PipelineOutputRow[] } : null;
    }
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const cache = parsed as Partial<CachedAnalysis>;
    if (!Array.isArray(cache.rows) || !looksLikeLiveRows(cache.rows as PipelineOutputRow[])) {
      return null;
    }
    return {
      data: looksLikeDashboardData(cache.data) ? cache.data : null,
      rows: cache.rows as PipelineOutputRow[],
    };
  } catch {
    return null;
  }
}

function writeCachedAnalysis(rows: PipelineOutputRow[], data: MarketDashboardData | null): void {
  try {
    window.sessionStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify({ data, rows } satisfies CachedAnalysis));
  } catch {
    // Session storage is a convenience for back/forward navigation; rendering still works without it.
  }
}

function clearCachedAnalysisRows(): void {
  try {
    window.sessionStorage.removeItem(ANALYSIS_CACHE_KEY);
  } catch {
    // Ignore storage failures; this only affects navigation convenience.
  }
}

export function DashboardPage() {
  usePageTitle("실시간 대시보드");

  const [cachedAnalysis] = useState<CachedAnalysis | null>(() => readCachedAnalysis());
  const cachedRows = cachedAnalysis?.rows ?? null;
  const cachedData = cachedAnalysis?.data ?? null;
  const canRestoreImmediately = cachedRows !== null && cachedData !== null;
  const [data, setData] = useState<MarketDashboardData>(() => cachedData ?? getMarketDashboardData());
  // Probe reusable server outputs before showing the empty analysis gate. This
  // avoids asking for a new paid API run when a completed output already exists.
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>(canRestoreImmediately ? "done" : "restoring");
  const [isAnalysisRunning, setAnalysisRunning] = useState(!canRestoreImmediately);
  const [analysisMessage, setAnalysisMessage] = useState<string | undefined>(
    canRestoreImmediately
      ? `기존 분석 산출물 재사용 · 후보 ${cachedRows.length}종목`
      : cachedRows
        ? `저장된 후보 ${cachedRows.length}종목을 복원하는 중입니다.`
        : "기존 AI 분석 산출물을 확인하는 중입니다.",
  );
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState<string | undefined>();
  const [analysisStatus, setAnalysisStatus] = useState<CandidateAnalysisStatus | undefined>();
  const [isRefreshing, setRefreshing] = useState(false);
  const [refreshErrorMessage, setRefreshErrorMessage] = useState<string | undefined>();
  const analysisRunRef = useRef(0);
  const analysisRowsRef = useRef<PipelineOutputRow[] | null>(cachedRows);

  useEffect(() => {
    const controller = new AbortController();

    fetchMarketIndicesData(controller.signal)
      .then((indices) => {
        setData((current) => mergeMarketIndices(current, indices));
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (import.meta.env.DEV) {
          console.warn("KIS index API unavailable. Keeping current dashboard indices.", error);
        }
      });

    return () => controller.abort();
  }, []);

  // Treat the completed/validated pipeline output served from outputs/ as the
  // source of truth. The in-tab cache is only a network-failure fallback; using
  // it first could hide a newer run produced in another tab or process.
  useEffect(() => {
    const controller = new AbortController();
    const runId = analysisRunRef.current;
    void (async () => {
      let rows: PipelineOutputRow[];
      try {
        rows = await fetchPipelineCandidates(controller.signal, { fallbackToMock: false });
      } catch (cause) {
        if (!cachedRows) {
          throw cause;
        }
        rows = cachedRows;
      }
      if (analysisRunRef.current !== runId) {
        return;
      }
      if (rows.length === 0 || !looksLikeLiveRows(rows)) {
        // A successful empty response is authoritative: outputs were removed or
        // no completed run exists. Do not keep showing stale session candidates.
        // Network failures take the catch path above and may still reuse cache.
        analysisRowsRef.current = null;
        clearCachedAnalysisRows();
        setData(getMarketDashboardData());
        setAnalysisMessage(undefined);
        setAnalysisPhase("idle");
        return;
      }

      // Back/forward navigation already has a complete rows+quotes snapshot.
      // Keep it visible and skip another KIS quote hydration when the server is
      // serving the same analysis payload. A genuinely newer output is updated
      // in the background without replacing the board with a loading gate.
      if (canRestoreImmediately && JSON.stringify(rows) === JSON.stringify(cachedRows)) {
        analysisRowsRef.current = rows;
        writeCachedAnalysis(rows, cachedData);
        return;
      }

      await publishResults(rows, `기존 분석 산출물 재사용 · 후보 ${rows.length}종목`);
    })()
      .catch((cause) => {
        if (analysisRunRef.current !== runId) {
          return;
        }
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setAnalysisMessage(undefined);
        setAnalysisErrorMessage(cause instanceof Error ? cause.message : "기존 분석 산출물을 불러오지 못했습니다.");
        setAnalysisPhase("idle");
      })
      .finally(() => {
        if (analysisRunRef.current === runId) {
          setAnalysisRunning(false);
        }
      });
    return () => {
      controller.abort();
      if (analysisRunRef.current === runId) {
        analysisRunRef.current += 1;
      }
    };
    // Run once on mount for cached or server-side outputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Loads a complete quote set before the candidate list is allowed to render.
   * KIS requests remain batched/rate-limit aware server-side; only unresolved
   * tickers are retried. A partial map is never published to the UI.
   */
  async function loadCompleteCandidateQuotes(
    rows: PipelineOutputRow[],
    runId: number,
  ): Promise<Map<string, StockQuote> | null> {
    const codes = Array.from(new Set(
      rows
        .map((row) => String(row.result?.ticker ?? row.input_row?.ticker ?? "").replace(/\D/g, "").padStart(6, "0").slice(-6))
        .filter((code) => /^\d{6}$/.test(code) && code !== "000000"),
    ));
    if (codes.length === 0) {
      return new Map();
    }

    const merged = new Map<string, StockQuote>();
    let lastError: unknown;
    for (let attempt = 0; attempt < HYDRATE_MAX_ATTEMPTS; attempt += 1) {
      const missing = codes.filter((code) => !merged.has(code));
      if (missing.length === 0) {
        break;
      }

      try {
        const quotes = await fetchCandidateQuotes(missing);
        if (analysisRunRef.current !== runId) {
          return null;
        }
        for (const [code, quote] of quotes) {
          if (quote.currentPrice > 0) {
            merged.set(code, quote);
          }
        }
      } catch (cause) {
        lastError = cause;
      }

      if (attempt < HYDRATE_MAX_ATTEMPTS - 1 && merged.size < codes.length) {
        await new Promise((resolve) => setTimeout(resolve, HYDRATE_RETRY_DELAY_MS));
        if (analysisRunRef.current !== runId) {
          return null;
        }
      }
    }

    const missing = codes.filter((code) => !merged.has(code));
    if (missing.length > 0) {
      const detail = lastError instanceof Error ? ` (${lastError.message})` : "";
      throw new Error(`후보 ${codes.length}종목 중 ${missing.length}종목의 현재가를 확보하지 못했습니다: ${missing.join(", ")}${detail}`);
    }

    return merged;
  }

  async function publishResults(
    rows: PipelineOutputRow[],
    note: string,
    baseData?: MarketDashboardData,
  ): Promise<boolean> {
    const runId = analysisRunRef.current;
    analysisRowsRef.current = rows;
    setAnalysisMessage(`AI 분석 완료 · 후보 ${rows.length}종목의 현재가를 확인하는 중입니다.`);

    const quotes = await loadCompleteCandidateQuotes(rows, runId);
    if (!quotes || analysisRunRef.current !== runId) {
      return false;
    }

    setData((base) => {
      const next = overlayLiveAnalysis(baseData ?? base, rows, quotes);
      writeCachedAnalysis(rows, next);
      return next;
    });
    setAnalysisMessage(note);
    setAnalysisPhase("done");
    return true;
  }

  /** Loads the freshly generated outputs and reveals the board. Returns true on success. */
  async function revealResults(note: string): Promise<boolean> {
    const rows = await fetchPipelineCandidates(undefined, { fallbackToMock: false });
    if (!looksLikeLiveRows(rows)) {
      return false;
    }
    return publishResults(rows, note);
  }

  async function handleRefreshDashboard() {
    if (isRefreshing) {
      return;
    }

    const refreshRunId = analysisRunRef.current + 1;
    analysisRunRef.current = refreshRunId;
    const rows = analysisRowsRef.current;
    setAnalysisRunning(Boolean(rows));
    setAnalysisMessage(rows ? "기존 AI 후보를 유지한 채 시세를 갱신하는 중입니다." : undefined);
    setAnalysisErrorMessage(undefined);
    setAnalysisStatus(undefined);
    if (!rows) {
      setAnalysisPhase("idle");
      setData(getMarketDashboardData());
    }

    setRefreshing(true);
    setRefreshErrorMessage(undefined);
    try {
      const refreshed = await fetchMarketDashboardData();
      if (rows) {
        await publishResults(rows, `기존 분석 산출물 유지 · 후보 ${rows.length}종목`, refreshed);
      } else {
        setData(refreshed);
      }
    } catch (cause) {
      if (analysisRunRef.current !== refreshRunId) {
        return;
      }
      setRefreshErrorMessage(cause instanceof Error ? cause.message : "대시보드 새로고침에 실패했습니다.");
    } finally {
      setRefreshing(false);
      if (analysisRunRef.current === refreshRunId) {
        setAnalysisRunning(false);
      }
    }
  }

  async function handleRunCandidateAnalysis() {
    if (isAnalysisRunning) {
      return;
    }

    const runId = analysisRunRef.current + 1;
    analysisRunRef.current = runId;
    analysisRowsRef.current = null;
    clearCachedAnalysisRows();
    setData(getMarketDashboardData());
    setAnalysisRunning(true);
    setAnalysisPhase("running");
    setAnalysisErrorMessage(undefined);
    setAnalysisStatus(undefined);

    const startedAt = Date.now();
    setAnalysisMessage(`integrated_pipeline.py 실행 중… ${elapsedLabel(startedAt)}`);

    try {
      const result = await runCandidateAnalysis(undefined, (status) => {
        if (analysisRunRef.current !== runId) {
          return;
        }
        setAnalysisStatus(status);
        setAnalysisMessage(describeAnalysisStatus(status, startedAt));
      });
      if (analysisRunRef.current !== runId) {
        return;
      }
      const newsNote = result.newsRows && result.newsRows > 0 ? ` · 뉴스 ${result.newsRows}종목` : "";
      await revealResults(`분석 완료 — 후보 ${result.rows}개${newsNote}. (소요 ${elapsedLabel(startedAt)})`);
    } catch (cause) {
      if (analysisRunRef.current !== runId) {
        return;
      }
      // The status stream can drop mid-run (e.g. the dev server restarts) even
      // though the pipeline finished and wrote outputs. Don't give up — try to
      // load the results from disk before showing an error.
      try {
        const recovered = await revealResults("분석 결과를 불러왔습니다.");
        if (!recovered) {
          throw cause;
        }
      } catch {
        setAnalysisMessage(undefined);
        setAnalysisErrorMessage(
          cause instanceof Error ? cause.message : "AI 후보 분석 실행에 실패했습니다.",
        );
        setAnalysisPhase("idle");
      }
    } finally {
      if (analysisRunRef.current === runId) {
        setAnalysisRunning(false);
      }
    }
  }

  return (
    <MarketWorkspace
      data={data}
      analysisPhase={analysisPhase}
      candidateAnalysis={{
        errorMessage: analysisErrorMessage,
        elapsedMs: analysisStatus?.elapsedMs,
        isRestoring: analysisPhase === "restoring",
        isRunning: isAnalysisRunning,
        message: analysisMessage,
        onRun: handleRunCandidateAnalysis,
        progress: analysisStatus?.progress,
      }}
      syncStatus={{
        errorMessage: refreshErrorMessage,
        isRefreshing,
        onRefresh: handleRefreshDashboard,
      }}
    />
  );
}

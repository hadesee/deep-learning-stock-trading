import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { MarketWorkspace } from "../components/market/MarketWorkspace";
import { usePageTitle } from "../hooks/usePageTitle";
import {
  fetchMarketIndicesData,
  fetchMarketDashboardData,
  fetchPipelineCandidates,
  getMarketDashboardData,
  mergeMarketIndices,
  runCandidateAnalysis,
} from "../services/tradingData";
import { overlayLiveAnalysis } from "../data/pipelineAdapter";
import type { CandidateAnalysisStatus } from "../services/tradingData";
import type { MarketDashboardData, PipelineOutputRow } from "../types/trading";

type AnalysisPhase = "idle" | "running" | "done";

const ANALYSIS_CACHE_KEY = "kospi-dashboard-analysis.v1";

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

function readCachedAnalysisRows(): PipelineOutputRow[] | null {
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(ANALYSIS_CACHE_KEY) ?? "null") as unknown;
    return Array.isArray(parsed) && looksLikeLiveRows(parsed as PipelineOutputRow[]) ? (parsed as PipelineOutputRow[]) : null;
  } catch {
    return null;
  }
}

function writeCachedAnalysisRows(rows: PipelineOutputRow[]): void {
  try {
    window.sessionStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify(rows));
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

  const location = useLocation();
  const navigate = useNavigate();
  const resetAnalysis = (location.state as { resetAnalysis?: boolean } | null)?.resetAnalysis === true;
  const [cachedRows] = useState<PipelineOutputRow[] | null>(() => {
    if (resetAnalysis) {
      clearCachedAnalysisRows();
      return null;
    }

    return readCachedAnalysisRows();
  });
  const [data, setData] = useState<MarketDashboardData>(() => {
    const base = getMarketDashboardData();
    return cachedRows ? overlayLiveAnalysis(base, cachedRows) : base;
  });
  const [analysisPhase, setAnalysisPhase] = useState<AnalysisPhase>(cachedRows ? "done" : "idle");
  const [isAnalysisRunning, setAnalysisRunning] = useState(false);
  const [analysisMessage, setAnalysisMessage] = useState<string | undefined>(
    cachedRows ? `분석 결과 유지 중 — 후보 ${cachedRows.length}개.` : undefined,
  );
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState<string | undefined>();
  const [analysisStatus, setAnalysisStatus] = useState<CandidateAnalysisStatus | undefined>();
  const [isRefreshing, setRefreshing] = useState(false);
  const [refreshErrorMessage, setRefreshErrorMessage] = useState<string | undefined>();
  const analysisRunRef = useRef(0);

  useEffect(() => {
    if (!resetAnalysis) {
      return;
    }

    navigate(`${location.pathname}${location.search}${location.hash}`, { replace: true, state: null });
  }, [location.hash, location.pathname, location.search, navigate, resetAnalysis]);

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

  /** Loads the freshly generated outputs and reveals the board. Returns true on success. */
  async function revealResults(note: string): Promise<boolean> {
    const rows = await fetchPipelineCandidates(undefined, { fallbackToMock: false });
    if (!looksLikeLiveRows(rows)) {
      return false;
    }
    writeCachedAnalysisRows(rows);
    setData((base) => overlayLiveAnalysis(base, rows));
    setAnalysisMessage(note);
    setAnalysisPhase("done");
    return true;
  }

  async function handleRefreshDashboard() {
    if (isRefreshing) {
      return;
    }

    analysisRunRef.current += 1;
    clearCachedAnalysisRows();
    setAnalysisRunning(false);
    setAnalysisPhase("idle");
    setAnalysisMessage(undefined);
    setAnalysisErrorMessage(undefined);
    setAnalysisStatus(undefined);
    setData(getMarketDashboardData());

    setRefreshing(true);
    setRefreshErrorMessage(undefined);
    try {
      const refreshed = await fetchMarketDashboardData();
      setData(refreshed);
    } catch (cause) {
      setRefreshErrorMessage(cause instanceof Error ? cause.message : "대시보드 새로고침에 실패했습니다.");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleRunCandidateAnalysis() {
    if (isAnalysisRunning) {
      return;
    }

    const runId = analysisRunRef.current + 1;
    analysisRunRef.current = runId;
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

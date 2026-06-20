import { useEffect, useRef, useState } from "react";
import { MarketWorkspace } from "../components/market/MarketWorkspace";
import { DashboardSkeleton } from "../components/market/DashboardSkeleton";
import { ErrorView } from "../components/common/StatusView";
import { useAsyncData } from "../hooks/useAsyncData";
import { usePageTitle } from "../hooks/usePageTitle";
import { fetchLiveMarketDashboardData, getMarketDashboardData, runCandidateAnalysis } from "../services/tradingData";

/**
 * Background re-sync cadence while the tab is visible. The server caches the
 * snapshot anyway, so polling is cheap; `VITE_DASHBOARD_POLL_MS` overrides it
 * and any value <= 0 disables polling entirely.
 */
const DEFAULT_POLL_INTERVAL_MS = 60_000;

function resolvePollIntervalMs(): number {
  const parsed = Number(import.meta.env.VITE_DASHBOARD_POLL_MS);
  return Number.isFinite(parsed) ? parsed : DEFAULT_POLL_INTERVAL_MS;
}

export function DashboardPage() {
  const [analysisErrorMessage, setAnalysisErrorMessage] = useState<string | undefined>();
  const [analysisMessage, setAnalysisMessage] = useState<string | undefined>();
  const [isAnalysisRunning, setAnalysisRunning] = useState(false);

  usePageTitle("실시간 대시보드");

  const { data, error, isLoading, isRefreshing, reload } = useAsyncData(
    fetchLiveMarketDashboardData,
    [],
    getMarketDashboardData(),
  );

  const lastSyncedAtRef = useRef(Date.now());

  useEffect(() => {
    if (data) {
      lastSyncedAtRef.current = Date.now();
    }
  }, [data]);

  // Keep quotes fresh without user action: poll on an interval while visible,
  // and re-sync immediately when the tab regains focus after going stale.
  useEffect(() => {
    const intervalMs = resolvePollIntervalMs();
    if (intervalMs <= 0) {
      return;
    }

    // Small slack so the timer tick right at the interval boundary still counts
    // as stale (the last sync lands shortly after the timer starts).
    const staleAfterMs = Math.max(intervalMs - 5_000, intervalMs / 2);

    const syncIfStale = () => {
      if (document.visibilityState === "visible" && Date.now() - lastSyncedAtRef.current >= staleAfterMs) {
        reload();
      }
    };

    const timer = window.setInterval(syncIfStale, intervalMs);
    document.addEventListener("visibilitychange", syncIfStale);

    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", syncIfStale);
    };
  }, [reload]);

  async function handleRunCandidateAnalysis() {
    if (isAnalysisRunning) {
      return;
    }

    setAnalysisRunning(true);
    setAnalysisErrorMessage(undefined);
    setAnalysisMessage("AI 후보 분석을 실행 중입니다.");

    try {
      const result = await runCandidateAnalysis();
      const newsNote = result.newsRows && result.newsRows > 0 ? ` · 뉴스 감성 ${result.newsRows}개 종목` : "";
      setAnalysisMessage(`AI 후보 ${result.rows}개 분석 완료${newsNote}. 산출물이 생성되었습니다.`);
      reload();
    } catch (cause) {
      setAnalysisMessage(undefined);
      setAnalysisErrorMessage(cause instanceof Error ? cause.message : "AI 후보 분석 실행에 실패했습니다.");
    } finally {
      setAnalysisRunning(false);
    }
  }

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (!data || data.stocks.length === 0) {
    return (
      <div className="page-status">
        <ErrorView message={error?.message} onRetry={reload} />
      </div>
    );
  }

  return (
    <MarketWorkspace
      data={data}
      candidateAnalysis={{
        errorMessage: analysisErrorMessage,
        isRunning: isAnalysisRunning,
        message: analysisMessage,
        onRun: handleRunCandidateAnalysis,
      }}
      syncStatus={{
        errorMessage: error?.message,
        isRefreshing,
        onRefresh: reload,
      }}
    />
  );
}

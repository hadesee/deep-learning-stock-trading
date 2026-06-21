import type { LandingData } from "../../types/trading";

const signalBars = [56, 78, 44, 88, 64, 92, 70, 84];

function formatPercent(value: number) {
  return `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`;
}

type HeroDashboardPreviewProps = {
  data: LandingData;
};

export function HeroDashboardPreview({ data }: HeroDashboardPreviewProps) {
  const { marketSummary, candidates } = data;
  const topCandidate = candidates[0];

  // Defensive: an empty candidate list (degraded backend response) must not blank
  // the whole hero. Render the metrics we do have and skip the top-candidate row.
  return (
    <section className="dashboard-preview" aria-label="AI 자동매매 대시보드 미리보기">
      <div className="dashboard-preview__header">
        <div>
          <p className="dashboard-kicker">Today Market State</p>
          <h2>{marketSummary.marketState}</h2>
        </div>
        <span className="status-pill">Risk {marketSummary.riskState}</span>
      </div>

      <div className="metric-grid">
        <article>
          <span>후보 종목</span>
          <strong>{marketSummary.candidateCount}</strong>
          <small>파이프라인 분석 결과</small>
        </article>
        <article>
          <span>평균 신뢰도</span>
          <strong>{Math.round(marketSummary.averageConfidence * 100)}%</strong>
          <small>
            긍정 {marketSummary.positiveCount} / 중립 {marketSummary.neutralCount} / 경계{" "}
            {marketSummary.negativeCount}
          </small>
        </article>
        <article>
          <span>전략 슬롯</span>
          <strong>{marketSummary.strategySlots}</strong>
          <small>평균 예상 {formatPercent(marketSummary.averagePredictedReturn)}</small>
        </article>
      </div>

      {topCandidate ? (
        <div className="top-candidate">
          <span>Top Candidate</span>
          <strong>
            {topCandidate.companyName} {topCandidate.ticker}
          </strong>
          <small>
            {topCandidate.sentimentLabelKo} · 예상 {formatPercent(topCandidate.predictedReturn ?? 0)}
          </small>
        </div>
      ) : null}

      <div className="market-curve" role="img" aria-label="상승과 조정을 반복하는 모의 시장 신호 차트">
        <svg viewBox="0 0 520 170" aria-hidden="true" focusable="false">
          <path
            d="M8 132 C72 118 82 54 132 70 C180 86 176 118 232 100 C282 84 296 28 350 44 C402 60 398 122 458 88 C488 72 502 48 516 34"
            fill="none"
            stroke="var(--color-ink)"
            strokeLinecap="round"
            strokeWidth="4"
          />
          <path
            d="M8 132 C72 118 82 54 132 70 C180 86 176 118 232 100 C282 84 296 28 350 44 C402 60 398 122 458 88 C488 72 502 48 516 34"
            fill="none"
            stroke="var(--color-light-signal)"
            strokeDasharray="4 18"
            strokeLinecap="round"
            strokeWidth="3"
          />
        </svg>
      </div>

      <div className="signal-strip" aria-hidden="true">
        {signalBars.map((height, index) => (
          <span key={index} style={{ height: `${height}%` }} />
        ))}
      </div>
    </section>
  );
}

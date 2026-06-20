import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { StockChartPanel } from "../components/market/stock-chart";
import { DashboardSkeleton } from "../components/market/DashboardSkeleton";
import { ErrorView } from "../components/common/StatusView";
import { useAsyncData } from "../hooks/useAsyncData";
import { usePageTitle } from "../hooks/usePageTitle";
import {
  fetchMarketDashboardData,
  fetchStockAnalysis,
  getMarketDashboardData,
  readWatchlistCodes,
  runStockNewsAnalysis,
  writeWatchlistCodes,
} from "../services/tradingData";
import { describeAiSummary, hasLlmSentiment } from "../utils/aiSignal";
import type {
  MarketDashboardData,
  MarketDirection,
  MarketIndexSnapshot,
  PipelineOutputRow,
  StockQuote,
} from "../types/trading";

type DetailData = {
  analysis: PipelineOutputRow | null;
  dashboard: MarketDashboardData;
};

function finiteNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatWon(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatRate(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatCompactWon(value: number) {
  if (value >= 1_000_000_000_000) {
    return `${Math.round(value / 100_000_000_000) / 10}조원`;
  }

  if (value >= 100_000_000) {
    return `${Math.round(value / 100_000_000).toLocaleString("ko-KR")}억원`;
  }

  return formatWon(value);
}

function formatSignedVolume(value: number) {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${Math.abs(value).toLocaleString("ko-KR")}주`;
}

function directionLabel(direction: MarketDirection) {
  return direction === "up" ? "상승" : direction === "down" ? "하락" : "보합";
}

function changeTone(value: number) {
  return value > 0 ? "is-positive-text" : value < 0 ? "is-negative-text" : undefined;
}

function sentimentKo(label: StockQuote["sentimentLabel"]) {
  return label === "POSITIVE" ? "긍정" : label === "NEGATIVE" ? "부정" : "중립";
}

/** The KOSPI index drives the index-shock leg of the risk gate. */
function findKospiIndex(indices: MarketIndexSnapshot[]): MarketIndexSnapshot | undefined {
  return (
    indices.find((index) => /코스피200|kospi ?200/i.test(`${index.name}${index.symbol}`)) ??
    indices.find((index) => /코스피|kospi/i.test(`${index.name}${index.symbol}`)) ??
    indices[0]
  );
}

type RiskCondition = {
  detail: string;
  label: string;
  triggered: boolean;
};

/**
 * Mirrors the automated-trading risk gate: entry is restricted when at least two
 * of {index ≤ -3%, foreign net-sell, confidence < 70%} hold. Evaluating it live
 * for the stock — instead of just stating the rule — is the trust-building part.
 */
function evaluateRiskGate(stock: StockQuote, kospi: MarketIndexSnapshot | undefined): {
  blocked: boolean;
  conditions: RiskCondition[];
} {
  const hasConfidence = stock.confidence > 0;
  const conditions: RiskCondition[] = [
    {
      label: "지수 급락 (KOSPI -3% 이하)",
      triggered: kospi !== undefined && kospi.changeRate <= -3,
      detail: kospi ? `${kospi.name} ${formatRate(kospi.changeRate)}` : "지수 데이터 없음",
    },
    {
      label: "외국인 순매도",
      triggered: stock.investorFlow.foreign < 0,
      detail:
        stock.investorFlow.foreign === 0
          ? "수급 데이터 미연동"
          : `외국인 ${formatSignedVolume(stock.investorFlow.foreign)}`,
    },
    {
      label: "신뢰도 70% 미만",
      triggered: !hasConfidence || stock.confidence < 0.7,
      detail: hasConfidence ? `신뢰도 ${Math.round(stock.confidence * 100)}%` : "LLM 신뢰도 미산출",
    },
  ];

  return {
    blocked: conditions.filter((condition) => condition.triggered).length >= 2,
    conditions,
  };
}

function StatRow({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span>
      {label} <strong className={tone}>{value}</strong>
    </span>
  );
}

function FactorList({ items, tone }: { items: string[]; tone: "positive" | "negative" | "neutral" }) {
  if (items.length === 0) {
    return <p className="factor-empty">해당 근거가 제시되지 않았습니다.</p>;
  }

  return (
    <ul className={`factor-list factor-list--${tone}`}>
      {items.map((item, index) => (
        <li key={`${tone}-${index}`}>{item}</li>
      ))}
    </ul>
  );
}

function FlowBars({ flow }: { flow: StockQuote["investorFlow"] }) {
  const hasFlow = flow.personal !== 0 || flow.foreign !== 0 || flow.institution !== 0;
  if (!hasFlow) {
    return (
      <p className="flow-empty">
        투자자별 순매수 데이터가 아직 연결되지 않았습니다. 실전 시세(KIS_ENV=real) 연동 시 표시됩니다.
      </p>
    );
  }

  const max = Math.max(...[flow.personal, flow.foreign, flow.institution].map((value) => Math.abs(value)), 1);

  return (
    <div className="flow-bars" aria-label="개인 외국인 기관 순매수량">
      {([
        ["개인", flow.personal],
        ["외국인", flow.foreign],
        ["기관", flow.institution],
      ] as const).map(([label, value]) => (
        <div className="flow-bar" key={label}>
          <span>{label}</span>
          <div>
            <i
              className={value >= 0 ? "is-positive" : "is-negative"}
              style={{ width: `${Math.max((Math.abs(value) / max) * 100, 8)}%` }}
            />
          </div>
          <strong className={value >= 0 ? "is-positive-text" : "is-negative-text"}>
            {formatSignedVolume(value)}
          </strong>
        </div>
      ))}
    </div>
  );
}

const initialDetailData = (): DetailData => ({ analysis: null, dashboard: getMarketDashboardData() });

async function loadDetailData(code: string, signal: AbortSignal): Promise<DetailData> {
  const [dashboard, analysis] = await Promise.all([
    fetchMarketDashboardData(signal),
    fetchStockAnalysis(code, signal),
  ]);

  return { analysis, dashboard };
}

export function StockDetailPage() {
  const { code = "" } = useParams<{ code: string }>();
  const [seed] = useState(initialDetailData);
  const { data, error, isLoading, isRefreshing, reload } = useAsyncData(
    (signal) => loadDetailData(code, signal),
    [code],
    seed,
  );

  const detail = data ?? seed;
  const stock =
    detail.dashboard.stocks.find((item) => item.code === code) ??
    detail.dashboard.watchlist.find((item) => item.code === code);

  usePageTitle(stock ? `${stock.name} ${stock.code}` : "종목 상세");

  const [watchCodes, setWatchCodes] = useState<string[]>(() => readWatchlistCodes() ?? []);
  const [newsAnalysisState, setNewsAnalysisState] = useState<{
    error: string;
    isRunning: boolean;
    message: string;
  }>({ error: "", isRunning: false, message: "" });
  useEffect(() => {
    writeWatchlistCodes(watchCodes);
  }, [watchCodes]);

  if (isLoading) {
    return <DashboardSkeleton />;
  }

  if (!stock) {
    return (
      <main className="page-status">
        <ErrorView
          message={`종목코드 ${code || "(없음)"}에 해당하는 데이터가 없습니다. 대시보드에서 다시 선택해 주세요.`}
        />
        <p className="detail-back-row">
          <Link className="detail-back-link" to="/dashboard">
            ← 실시간 대시보드로 돌아가기
          </Link>
        </p>
      </main>
    );
  }

  const row = detail.analysis;
  const result = row?.result;
  const modelRow = row?.input_row;
  const news = row?.news ?? [];
  const upProbability = finiteNumber(modelRow?.p_up) ?? stock.upProbability ?? null;
  const legacyPredictedReturn =
    finiteNumber(modelRow?.lstm_pred_return) ??
    (modelRow?.p_up === undefined ? finiteNumber(modelRow?.ensemble_pred_return) : null) ??
    stock.predictedReturn;
  const kospi = findKospiIndex(detail.dashboard.indices);
  const analyzedStock: StockQuote = {
    ...stock,
    aiSummary: result?.summary || stock.aiSummary,
    confidence: result?.confidence ?? stock.confidence,
    predictedReturn: legacyPredictedReturn,
    sentimentLabel: result?.label ?? stock.sentimentLabel,
    upProbability,
  };
  const gate = evaluateRiskGate(analyzedStock, kospi);
  // The freshly-fetched candidate row is the authoritative AI source for this
  // report — prefer it over the dashboard snapshot quote, whose AI fields are
  // only populated once a snapshot refresh has merged the pipeline output. This
  // makes the Gemini news/sentiment view appear right after an analysis run,
  // independent of snapshot timing.
  const hasResultSentiment = (result?.confidence ?? 0) > 0;
  const llmReady = hasResultSentiment || hasLlmSentiment(analyzedStock);
  const verdictLabel = result?.label ?? analyzedStock.sentimentLabel;
  const verdictConfidence = hasResultSentiment && result ? result.confidence : analyzedStock.confidence;
  const verdictSummary = result?.summary || describeAiSummary(analyzedStock);
  const isWatched = watchCodes.includes(stock.code);

  async function analyzeSelectedStockNews() {
    setNewsAnalysisState({ error: "", isRunning: true, message: "뉴스와 Gemini 분석을 실행 중입니다." });
    try {
      await runStockNewsAnalysis(stock!.code);
      setNewsAnalysisState({ error: "", isRunning: false, message: "뉴스 분석이 완료되었습니다." });
      reload();
    } catch (cause) {
      setNewsAnalysisState({
        error: cause instanceof Error ? cause.message : "뉴스 분석에 실패했습니다.",
        isRunning: false,
        message: "",
      });
    }
  }

  function toggleWatch() {
    setWatchCodes((current) =>
      current.includes(stock!.code)
        ? current.filter((item) => item !== stock!.code)
        : [stock!.code, ...current],
    );
  }

  return (
    <main className="stock-detail-page">
      <div className="detail-back-row">
        <Link className="detail-back-link" to="/dashboard">
          ← 실시간 대시보드
        </Link>
        {isRefreshing ? <span className="detail-refresh-flag">최신 데이터 동기화 중…</span> : null}
      </div>

      <header className="detail-hero">
        <div className="detail-hero__id">
          <span className="detail-hero__eyebrow">종목 분석 리포트</span>
          <h1>
            {stock.name} <small>{stock.code}</small>
          </h1>
          <p className="detail-hero__market">
            {stock.isKospi200 ? `${stock.market} · KOSPI200` : stock.market}
          </p>
        </div>
        <div className="detail-hero__price">
          <strong>{formatWon(stock.currentPrice)}</strong>
          <span className={changeTone(stock.change)}>
            {formatWon(stock.change)} ({formatRate(stock.changeRate)}) · {directionLabel(stock.direction)}
          </span>
        </div>
        <button
          className={`report-button ${isWatched ? "is-active" : ""}`}
          onClick={toggleWatch}
          type="button"
        >
          {isWatched ? "관심 해제" : "관심 추가"}
        </button>
      </header>

      {error ? (
        <p className="detail-banner detail-banner--warn">
          실시간 데이터를 불러오지 못해 최근 기준 데이터를 표시합니다.
        </p>
      ) : null}

      <section className="detail-card detail-verdict">
        <h2>AI 투자 의견</h2>
        <div className="verdict-grid">
          <div className={`verdict-headline verdict-headline--${verdictLabel.toLowerCase()}`}>
            <span>{llmReady ? "뉴스 감성" : "예측 방향"}</span>
            <strong>{sentimentKo(verdictLabel)}</strong>
          </div>
          <div className="detail-stats verdict-stats">
            <StatRow
              label={upProbability !== null ? "상승 확률(익일)" : "예상 수익률(익일)"}
              value={
                upProbability !== null
                  ? `${(upProbability * 100).toFixed(2)}%`
                  : legacyPredictedReturn === null
                    ? "—"
                    : formatRate(legacyPredictedReturn)
              }
              tone={
                upProbability !== null
                  ? changeTone(upProbability - 0.5)
                  : legacyPredictedReturn === null
                    ? undefined
                    : changeTone(legacyPredictedReturn)
              }
            />
            <StatRow label="신뢰도" value={llmReady ? `${Math.round(verdictConfidence * 100)}%` : "—"} />
            {result ? (
              <StatRow
                label="감성 점수"
                value={llmReady ? result.sentiment_score.toFixed(2) : "—"}
                tone={llmReady ? changeTone(result.sentiment_score) : undefined}
              />
            ) : null}
          </div>
        </div>
        <p className="reason-text">{verdictSummary}</p>
        {/* `caution` carries the internal fallback reason (e.g. the missing API
            key) for fallback rows — only surface it for genuine LLM analyses,
            where it's a real analytical caveat rather than a diagnostic string. */}
        {llmReady && result?.caution ? <p className="detail-caution">⚠ {result.caution}</p> : null}
      </section>

      <section className="detail-card">
        <h2>예측 모델 근거 (Transformer)</h2>
        {modelRow ? (
          <div className="detail-stats">
            <StatRow
              label="익일 상승 확률"
              value={upProbability === null ? "—" : `${(upProbability * 100).toFixed(2)}%`}
              tone={upProbability === null ? undefined : changeTone(upProbability - 0.5)}
            />
            <StatRow
              label="전체 예측 순위"
              value={
                finiteNumber(modelRow.pred_rank) === null
                  ? "—"
                  : `${finiteNumber(modelRow.pred_rank)}위 / ${finiteNumber(modelRow.pred_pool_size) ?? "—"}개`
              }
            />
            <StatRow
              label="예측 기준일"
              value={String(modelRow.transformer_base_date ?? modelRow.lstm_base_date ?? "—")}
            />
            <StatRow
              label="모델 상태"
              value={String(modelRow.prediction_status ?? modelRow.lstm_status ?? "—")}
            />
            <StatRow label="시계열 데이터" value={String(modelRow.ohlcv_source ?? "—")} />
          </div>
        ) : (
          <p className="factor-empty">
            이 종목의 Transformer 예측 결과가 없습니다. OHLCV 데이터 부족 또는 예측 실패 상태를 확인해야 합니다.
          </p>
        )}
        <p className="panel-note">
          OHLCV 기술지표 시퀀스를 학습한 Transformer 분류 모델이 다음 거래일 상승 확률을 계산합니다. 확률은 투자
          판단의 참고 지표이며, 수익률이나 수익을 보장하지 않습니다.
        </p>
      </section>

      <section className="detail-card">
        <div className="detail-card-heading">
          <h2>뉴스·감성 근거 (Gemini)</h2>
          <button
            className="secondary-button"
            disabled={newsAnalysisState.isRunning || !modelRow}
            onClick={analyzeSelectedStockNews}
            type="button"
          >
            {newsAnalysisState.isRunning ? "분석 중" : llmReady ? "뉴스 다시 분석" : "이 종목 뉴스 분석"}
          </button>
        </div>
        {newsAnalysisState.message ? <p className="detail-analysis-status">{newsAnalysisState.message}</p> : null}
        {newsAnalysisState.error ? (
          <p className="detail-analysis-status detail-analysis-status--error">{newsAnalysisState.error}</p>
        ) : null}
        {llmReady && result ? (
          <>
            <div className="factor-columns">
              <div>
                <h3 className="factor-heading is-positive-text">긍정 요인</h3>
                <FactorList items={result.positive_factors} tone="positive" />
              </div>
              <div>
                <h3 className="factor-heading is-negative-text">부정 요인</h3>
                <FactorList items={result.negative_factors} tone="negative" />
              </div>
              <div>
                <h3 className="factor-heading">핵심 데이터</h3>
                <FactorList items={result.key_data_points} tone="neutral" />
              </div>
            </div>
            {result.trading_insight ? (
              <p className="trading-insight">
                <strong>투자 인사이트</strong> {result.trading_insight}
              </p>
            ) : null}
          </>
        ) : (
          <p className="factor-empty">
            이 종목의 Gemini 분석 결과가 아직 없습니다. 위 버튼을 누르면 현재 종목만 네이버 뉴스와 기술지표를
            결합해 분석합니다.
          </p>
        )}

        <h3 className="factor-heading factor-heading--news">분석에 사용한 뉴스</h3>
        {news.length > 0 ? (
          <ul className="news-list">
            {news.map((item) => (
              <li key={item.index}>
                {item.url ? (
                  <a href={item.url} target="_blank" rel="noopener noreferrer">
                    {item.title}
                  </a>
                ) : (
                  <span>{item.title}</span>
                )}
                <small>
                  {item.source} · {item.pub_date}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          <p className="factor-empty">분석에 사용된 뉴스 항목이 없습니다.</p>
        )}
      </section>

      <section className="detail-card">
        <h2>가격 차트</h2>
        <StockChartPanel stock={stock} />
      </section>

      <section className="detail-card">
        <h2>투자자 수급</h2>
        <FlowBars flow={stock.investorFlow} />
        <div className="detail-stats">
          <StatRow label="거래량" value={`${stock.accumulatedVolume.toLocaleString("ko-KR")}주`} />
          <StatRow label="거래대금" value={formatCompactWon(stock.tradingValue)} />
          <StatRow label="거래대금 순위" value={stock.tradingValueRank > 0 ? `${stock.tradingValueRank}위` : "—"} />
        </div>
      </section>

      <section className={`detail-card risk-gate ${gate.blocked ? "risk-gate--blocked" : "risk-gate--clear"}`}>
        <h2>자동매매 리스크 게이트</h2>
        <p className="risk-gate__verdict">
          {gate.blocked
            ? "⛔ 신규 진입 제한 — 아래 위험 조건 중 2개 이상이 충족되었습니다."
            : "✅ 신규 진입 허용 — 위험 조건이 2개 미만입니다."}
        </p>
        <ul className="risk-condition-list">
          {gate.conditions.map((condition) => (
            <li key={condition.label} className={condition.triggered ? "is-triggered" : "is-clear"}>
              <span className="risk-condition__mark">{condition.triggered ? "위험" : "정상"}</span>
              <span className="risk-condition__label">{condition.label}</span>
              <small>{condition.detail}</small>
            </li>
          ))}
        </ul>
        <p className="panel-note">
          지수 -3% 이하, 외국인 순매도, 신뢰도 70% 미만 중 2개 이상이면 신규 진입을 제한하는 규칙을 이 종목에
          실시간으로 적용한 결과입니다.
        </p>
      </section>

      <footer className="detail-sources">
        <h2>데이터 출처 및 유의사항</h2>
        <ul>
          <li>시세·거래대금·투자자 수급: 한국투자증권(KIS) Open API.</li>
          <li>
            익일 상승 확률: 자체 학습 Transformer 모델 (예측 기준일 {String(modelRow?.transformer_base_date ?? "—")}).
          </li>
          <li>뉴스·감성: 네이버 뉴스 + Gemini 구조화 분석 (키 미설정 시 모델 예측 방향만 반영).</li>
          <li>기준 시각: {detail.dashboard.generatedAt} · {detail.dashboard.sessionLabel}</li>
        </ul>
        <p className="panel-note">
          모의투자(VTS) 환경 시세는 실제 시장가와 다를 수 있습니다. 본 리포트는 투자 참고용이며 투자 손익에 대한
          책임은 투자자 본인에게 있습니다.
        </p>
      </footer>
    </main>
  );
}

import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { StockChartPanel } from "../components/market/stock-chart";
import { usePageTitle } from "../hooks/usePageTitle";
import {
  fetchStockAnalysis,
  getMarketDashboardData,
  readWatchlistCodes,
  writeWatchlistCodes,
} from "../services/tradingData";
import { getAiCandidate } from "../data/aiCandidates";
import type { AiCandidate, AiNews } from "../data/aiCandidates";
import { rowToCandidate } from "../data/pipelineAdapter";
import type { MarketDirection, StockQuote } from "../types/trading";

function formatWon(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatRate(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/** Net-buy won amounts come in raw KRW; show them in 억원 for readability. */
function formatEok(won: number) {
  const abs = Math.abs(won / 100_000_000);
  const value =
    abs >= 10 ? Math.round(abs).toLocaleString("ko-KR") : abs >= 1 ? abs.toFixed(1) : abs > 0 ? abs.toFixed(2) : "0";
  return `${won > 0 ? "+" : won < 0 ? "-" : ""}${value}억원`;
}

function directionLabel(direction: MarketDirection) {
  return direction === "up" ? "상승" : direction === "down" ? "하락" : "보합";
}

function changeTone(value: number) {
  return value > 0 ? "is-positive-text" : value < 0 ? "is-negative-text" : undefined;
}

/** Brand-consistent tone for a sentiment label (KR market: 상승 red / 하락 blue). */
function sentimentTone(label: string) {
  const upper = label.toUpperCase();
  if (upper === "POSITIVE" || upper === "BULLISH") return "up";
  if (upper === "NEGATIVE" || upper === "BEARISH") return "down";
  return "neutral";
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function parseSentimentTally(tally: string) {
  const result = { negative: 0, neutral: 0, positive: 0 };
  const matches = tally.matchAll(/(긍정|부정|중립|혼합)\s*(\d+)\s*건/g);
  for (const match of matches) {
    const count = Number(match[2]);
    if (match[1] === "긍정") result.positive = count;
    if (match[1] === "부정") result.negative = count;
    if (match[1] === "중립" || match[1] === "혼합") result.neutral += count;
  }
  return result;
}

function formatRatio(count: number, total: number) {
  return total > 0 ? `${Math.round((count / total) * 100)}%` : "0%";
}

type NewsTone = "negative" | "neutral" | "positive";

type ClassifiedNews = AiNews & {
  tone: NewsTone;
  toneLabel: string;
  toneReason?: string;
};

const NEWS_TONE_META: Record<NewsTone, { label: string; shortLabel: string }> = {
  positive: { label: "긍정 뉴스", shortLabel: "긍정" },
  neutral: { label: "중립 뉴스", shortLabel: "중립" },
  negative: { label: "부정 뉴스", shortLabel: "부정" },
};

const POSITIVE_NEWS_KEYWORDS = [
  "상승",
  "오른",
  "급등",
  "강세",
  "호재",
  "매수",
  "추천",
  "목표가",
  "상향",
  "성장",
  "수주",
  "흑자",
  "개선",
  "최대",
  "돌파",
  "호실적",
  "기대",
  "수혜",
  "확대",
  "친환경",
  "슈퍼사이클",
  "유망",
  "buy",
];

const NEGATIVE_NEWS_KEYWORDS = [
  "하락",
  "급락",
  "약세",
  "악재",
  "담합",
  "구속",
  "수사",
  "적자",
  "부진",
  "하회",
  "리스크",
  "매도",
  "하향",
  "감소",
  "침체",
  "우려",
  "조정",
  "손실",
  "중단",
  "불확실",
  "과열",
  "부담",
];

function newsToneFromSentiment(label: string | undefined): NewsTone | null {
  const normalized = String(label ?? "").toUpperCase();
  if (normalized === "POSITIVE" || normalized === "BULLISH" || normalized.includes("긍정")) return "positive";
  if (normalized === "NEGATIVE" || normalized === "BEARISH" || normalized.includes("부정")) return "negative";
  if (normalized === "NEUTRAL" || normalized.includes("중립")) return "neutral";
  return null;
}

function keywordScore(text: string, keywords: string[]) {
  const lowered = text.toLowerCase();
  return keywords.reduce((score, keyword) => score + (lowered.includes(keyword.toLowerCase()) ? 1 : 0), 0);
}

function classifyNews(item: AiNews): ClassifiedNews {
  const llmTone = newsToneFromSentiment(item.sentiment ?? item.sentimentKo);
  if (llmTone) {
    return {
      ...item,
      tone: llmTone,
      toneLabel: NEWS_TONE_META[llmTone].shortLabel,
      toneReason: item.sentimentReason,
    };
  }

  const text = `${item.title} ${item.description}`;
  const positiveScore = keywordScore(text, POSITIVE_NEWS_KEYWORDS);
  const negativeScore = keywordScore(text, NEGATIVE_NEWS_KEYWORDS);
  const tone: NewsTone =
    positiveScore > negativeScore ? "positive" : negativeScore > positiveScore ? "negative" : "neutral";

  return {
    ...item,
    tone,
    toneLabel: NEWS_TONE_META[tone].shortLabel,
  };
}

function groupedNews(news: AiNews[]) {
  const classified = news.map(classifyNews);
  return (["positive", "neutral", "negative"] as const)
    .map((tone) => ({
      tone,
      ...NEWS_TONE_META[tone],
      items: classified.filter((item) => item.tone === tone),
    }))
    .filter((group) => group.items.length > 0);
}

/** Circular 0-100 conviction gauge — the headline "how strong is this pick" signal. */
function ScoreGauge({ score, tone }: { score: number; tone: string }) {
  const pct = Math.max(0, Math.min(100, score)) / 100;
  const radius = 52;
  const circ = 2 * Math.PI * radius;
  const dash = circ * pct;

  return (
    <div className={`score-gauge score-gauge--${tone}`} role="img" aria-label={`종합 점수 ${Math.round(score)}점`}>
      <svg viewBox="0 0 120 120">
        <circle className="score-gauge__track" cx="60" cy="60" r={radius} />
        <circle
          className="score-gauge__value"
          cx="60"
          cy="60"
          r={radius}
          strokeDasharray={`${dash} ${circ - dash}`}
          strokeDashoffset={circ / 4}
        />
      </svg>
      <div className="score-gauge__center">
        <strong>{Math.round(score)}</strong>
        <span>종합점수</span>
      </div>
    </div>
  );
}

function MetricTile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className="metric-tile">
      <span className="metric-tile__label">{label}</span>
      <strong className={`metric-tile__value ${tone ?? ""}`}>{value}</strong>
      {sub ? <small className="metric-tile__sub">{sub}</small> : null}
    </div>
  );
}

function ReportKpiCard({
  icon,
  label,
  sub,
  tone,
  value,
}: {
  icon: string;
  label: string;
  sub: string;
  tone?: string;
  value: string;
}) {
  return (
    <article className="report-kpi-card">
      <span className="report-kpi-card__icon" aria-hidden="true">{icon}</span>
      <small>{label}</small>
      <strong className={tone}>{value}</strong>
      <span>{sub}</span>
    </article>
  );
}

function EvidenceReportDashboard({ candidate }: { candidate: AiCandidate }) {
  const parsed = parseSentimentTally(candidate.newsSentimentTally);
  const parsedTotal = parsed.positive + parsed.neutral + parsed.negative;
  const uncategorized = Math.max(candidate.newsCount - parsedTotal, 0);
  const neutralCount = parsed.neutral + uncategorized;
  const total = parsed.positive + neutralCount + parsed.negative || candidate.newsCount;
  const positivePct = total > 0 ? (parsed.positive / total) * 100 : 0;
  const neutralPct = total > 0 ? (neutralCount / total) * 100 : 0;
  const negativePct = total > 0 ? (parsed.negative / total) * 100 : 0;
  const tone = sentimentTone(candidate.finalSentiment);
  const supplyMaxAbs = Math.max(Math.abs(candidate.foreignNetBuy), Math.abs(candidate.instNetBuy), Math.abs(candidate.totalSupplyNetBuy), 1);
  const supplyDays = candidate.foreignPositiveDays + candidate.instPositiveDays;
  const supplyDayTotal = Math.max(candidate.supplyWindow * 2, 1);
  const supplyParticipationScore = clampPercent((supplyDays / supplyDayTotal) * 100);
  const signalBars = [
    {
      label: "Transformer",
      value: candidate.pUp * 100,
      tone: candidate.pUp >= 0.5 ? "up" : "down",
    },
    {
      label: "뉴스",
      value: candidate.newsOverallScore * 10,
      tone: candidate.newsOverallScore >= 5 ? "up" : "down",
    },
    {
      label: "수급",
      value: supplyParticipationScore,
      tone: candidate.totalSupplyNetBuy >= 0 ? "up" : "down",
    },
    {
      label: "최종",
      value: candidate.finalCombinedScore,
      tone,
    },
  ];

  return (
    <section className="detail-card report-dashboard reco-reveal" style={{ animationDelay: "240ms" }}>
      <header className="report-dashboard__head">
        <div>
          <h2>AI 근거 리포트 대시보드</h2>
          <p className="detail-card-sub">모델 예측, 뉴스 감성, 수급 흐름을 한 화면에서 비교합니다.</p>
        </div>
        <strong className={`report-dashboard__verdict tone-${tone}`}>{candidate.finalSentimentKo}</strong>
      </header>

      <div className="report-kpi-grid">
        <ReportKpiCard
          icon="AI"
          label="최종 결합 점수"
          value={`${Math.round(candidate.finalCombinedScore)}점`}
          sub="모델+뉴스+수급"
          tone={tone === "up" ? "is-positive-text" : tone === "down" ? "is-negative-text" : undefined}
        />
        <ReportKpiCard
          icon="P"
          label="상승확률"
          value={`${(candidate.pUp * 100).toFixed(1)}%`}
          sub={`${candidate.rank}위 / ${candidate.poolSize}개`}
          tone={candidate.pUp >= 0.5 ? "is-positive-text" : "is-negative-text"}
        />
        <ReportKpiCard
          icon="N"
          label="뉴스 분석"
          value={`${candidate.newsCount}건`}
          sub={`${candidate.newsOverallScore.toFixed(1)} / 10`}
          tone={candidate.newsOverallScore >= 5 ? "is-positive-text" : "is-negative-text"}
        />
        <ReportKpiCard
          icon="F"
          label="수급 합산"
          value={formatEok(candidate.totalSupplyNetBuy)}
          sub={`매수 우위 ${supplyDays}/${supplyDayTotal}일`}
          tone={candidate.totalSupplyNetBuy >= 0 ? "is-positive-text" : "is-negative-text"}
        />
      </div>

      <div className="report-chart-grid">
        <article className="report-chart-card">
          <div className="report-chart-card__head">
            <strong>뉴스 감성 비율</strong>
            <span>{candidate.newsOverallScore.toFixed(1)} / 10</span>
          </div>
          <div className="sentiment-donut-wrap">
            <div
              className="sentiment-donut"
              style={{
                background: `conic-gradient(var(--news-sentiment-positive) 0 ${positivePct}%, var(--report-neutral) ${positivePct}% ${
                  positivePct + neutralPct
                }%, var(--news-sentiment-negative) ${positivePct + neutralPct}% 100%)`,
              }}
              role="img"
              aria-label={`긍정 ${parsed.positive}건, 중립 ${parsed.neutral}건, 부정 ${parsed.negative}건`}
            >
              <span>{candidate.newsCount}</span>
              <small>뉴스</small>
            </div>
            <div className="sentiment-legend">
              <span><i className="is-positive" />긍정 {parsed.positive}건 · {formatRatio(parsed.positive, total)}</span>
              <span><i className="is-neutral" />중립 {neutralCount}건 · {formatRatio(neutralCount, total)}</span>
              <span><i className="is-negative" />부정 {parsed.negative}건 · {formatRatio(parsed.negative, total)}</span>
            </div>
          </div>
        </article>

        <article className="report-chart-card">
          <div className="report-chart-card__head">
            <strong>카테고리별 근거 점수</strong>
            <span>0-100</span>
          </div>
          <div className="report-bar-chart" aria-label="근거 점수 막대 차트">
            {signalBars.map((bar) => (
              <div className="report-bar" key={bar.label}>
                <span>{bar.label}</span>
                <div className="report-bar__track">
                  <i className={`report-bar__fill report-bar__fill--${bar.tone}`} style={{ width: `${Math.max(4, clampPercent(bar.value))}%` }} />
                </div>
                <strong>{Math.round(bar.value)}</strong>
              </div>
            ))}
          </div>
        </article>
      </div>

      <div className="report-supply-panel">
        <div className="report-supply-panel__summary">
          <MetricTile
            label="외국인+기관 합산"
            value={formatEok(candidate.totalSupplyNetBuy)}
            sub="최근 누적 순매수 금액"
            tone={candidate.totalSupplyNetBuy >= 0 ? "is-positive-text" : "is-negative-text"}
          />
          <MetricTile
            label="매수 우위 일수"
            value={`${supplyDays}/${supplyDayTotal}일`}
            sub="외국인·기관 합산 관찰"
            tone={supplyDays >= supplyDayTotal / 2 ? "is-positive-text" : "is-negative-text"}
          />
        </div>
        <div className="supply-grid">
          <SupplyRow
            label="외국인"
            won={candidate.foreignNetBuy}
            days={candidate.foreignPositiveDays}
            maxAbs={supplyMaxAbs}
            window={candidate.supplyWindow}
          />
          <SupplyRow
            label="기관"
            won={candidate.instNetBuy}
            days={candidate.instPositiveDays}
            maxAbs={supplyMaxAbs}
            window={candidate.supplyWindow}
          />
        </div>
      </div>
    </section>
  );
}

function SupplyRow({
  days,
  label,
  maxAbs,
  window,
  won,
}: {
  days: number;
  label: string;
  maxAbs: number;
  window: number;
  won: number;
}) {
  const tone = won >= 0 ? "is-positive-text" : "is-negative-text";
  const amountFill = maxAbs > 0 ? Math.max(8, Math.min(100, (Math.abs(won) / maxAbs) * 100)) : 0;
  const dayFill = clampPercent((days / Math.max(window, 1)) * 100);
  return (
    <div className="supply-row">
      <span className="supply-row__label">{label}</span>
      <div className="supply-row__bar">
        <i className={won >= 0 ? "is-positive" : "is-negative"} style={{ width: `${amountFill}%` }} />
      </div>
      <strong className={`supply-row__won ${tone}`}>{formatEok(won)}</strong>
      <small className="supply-row__days">매수 우위 {days}/{window}일</small>
      <div className="supply-row__daysbar" aria-hidden="true">
        <i style={{ width: `${Math.max(dayFill, 4)}%` }} />
      </div>
    </div>
  );
}

function AiRecommendation({ candidate }: { candidate: AiCandidate }) {
  const tone = sentimentTone(candidate.finalSentiment);
  const newsGroups = groupedNews(candidate.news);

  return (
    <>
      <section className="detail-card ai-reco reco-reveal" style={{ animationDelay: "40ms" }}>
        <div className="ai-reco__head">
          <span className="ai-reco__eyebrow">왜 이 종목을 추천했나</span>
          <h2>
            AI는 이 종목을 <em className={`tone-${tone}`}>{candidate.finalSentimentKo}</em> 후보로 선정했습니다
          </h2>
        </div>

        <div className="reco-grid">
          <ScoreGauge score={candidate.finalCombinedScore} tone={tone} />
          <div className="metric-tiles">
            <MetricTile
              label="익일 상승확률"
              value={`${(candidate.pUp * 100).toFixed(1)}%`}
              sub="Transformer 예측"
              tone={candidate.pUp >= 0.5 ? "is-positive-text" : "is-negative-text"}
            />
            <MetricTile
              label="전체 예측순위"
              value={candidate.rank > 0 ? `${candidate.rank}위` : "—"}
              sub={candidate.poolSize > 0 ? `${candidate.poolSize}개 중` : undefined}
            />
            <MetricTile
              label="뉴스 점수"
              value={`${candidate.newsOverallScore.toFixed(1)} / 10`}
              sub={candidate.newsSentimentTally || `뉴스 ${candidate.newsCount}건`}
            />
          </div>
        </div>

        <div className="reco-reason">
          <span className="reco-reason__tag">핵심 근거</span>
          <p>
            {[candidate.summary, candidate.tradingInsight].filter(Boolean).join(" ")}
          </p>
        </div>
      </section>

      <EvidenceReportDashboard candidate={candidate} />

      <section className="detail-card reco-reveal" style={{ animationDelay: "440ms" }}>
        <h2>분석에 사용한 뉴스 ({candidate.news.length})</h2>
        {candidate.news.length > 0 ? (
          <div className="ai-news-groups">
            {newsGroups.map((group) => (
              <section className={`ai-news-group ai-news-group--${group.tone}`} key={group.tone}>
                <div className={`ai-news-group__head is-${group.tone}`}>
                  <strong>{group.label}</strong>
                  <span>{group.items.length}건</span>
                </div>
                <ul className="ai-news-list">
                  {group.items.map((item) => (
                    <li key={`${group.tone}-${item.index}`}>
                      <a className={`ai-news-list__link is-${item.tone}`} href={item.url} target="_blank" rel="noopener noreferrer">
                        <span className="ai-news-list__top">
                          <span className="ai-news-list__title">{item.title}</span>
                          <span className={`ai-news-badge is-${item.tone}`}>{item.toneLabel}</span>
                        </span>
                        {item.description ? <span className="ai-news-list__desc">{item.description}</span> : null}
                        {item.toneReason ? <span className="ai-news-list__reason">{item.toneReason}</span> : null}
                        <small className="ai-news-list__meta">
                          {item.source} · {item.pubDate?.slice(0, 10)}
                        </small>
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        ) : (
          <p className="factor-empty">분석에 사용된 뉴스 항목이 없습니다.</p>
        )}
      </section>
    </>
  );
}

export function StockDetailPage() {
  const { code = "" } = useParams<{ code: string }>();
  const normalized = code.replace(/\D/g, "").padStart(6, "0").slice(-6);

  const dashboard = getMarketDashboardData();
  const stock: StockQuote | undefined =
    dashboard.stocks.find((item) => item.code === normalized) ??
    dashboard.watchlist.find((item) => item.code === normalized);

  // Bundled output shows instantly; the live pipeline result (after a real run)
  // overrides it once fetched.
  const [candidate, setCandidate] = useState<AiCandidate | undefined>(() => getAiCandidate(normalized));
  const [isSyncing, setSyncing] = useState(false);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setSyncing(true);
    fetchStockAnalysis(normalized, controller.signal)
      .then((row) => {
        if (active && row) {
          setCandidate(rowToCandidate(row));
          setIsLive(true);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (active) {
          setSyncing(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [normalized]);

  usePageTitle(candidate ? `${candidate.companyName} ${normalized}` : stock ? `${stock.name} ${stock.code}` : "종목 상세");

  const [watchCodes, setWatchCodes] = useState<string[]>(() => readWatchlistCodes() ?? []);
  useEffect(() => {
    writeWatchlistCodes(watchCodes);
  }, [watchCodes]);

  const displayName = candidate?.companyName ?? stock?.name ?? normalized;
  const isWatched = watchCodes.includes(normalized);

  function toggleWatch() {
    setWatchCodes((current) =>
      current.includes(normalized) ? current.filter((item) => item !== normalized) : [normalized, ...current],
    );
  }

  if (!candidate && !stock) {
    return (
      <main className="page-status">
        <div className="status-view">
          <strong>분석 데이터가 없습니다</strong>
          <p>종목코드 {normalized || "(없음)"}에 대한 AI 분석 결과를 찾을 수 없습니다.</p>
        </div>
        <p className="detail-back-row">
          <Link className="detail-back-link" to="/dashboard">
            ← 실시간 대시보드로 돌아가기
          </Link>
        </p>
      </main>
    );
  }

  return (
    <main className="stock-detail-page">
      <div className="detail-back-row">
        <Link className="detail-back-link" to="/dashboard">
          ← 실시간 대시보드
        </Link>
        <span className="detail-source-flag">
          {isSyncing ? "최신 분석 동기화 중…" : isLive ? "실시간 파이프라인 결과" : "최근 생성된 분석 결과"}
        </span>
      </div>

      <header className="detail-hero">
        <div className="detail-hero__id">
          <span className="detail-hero__eyebrow">AI 추천 종목 리포트</span>
          <h1>
            {displayName} <small>{normalized}</small>
          </h1>
          <p className="detail-hero__market">{stock?.isKospi200 ? "KOSPI · KOSPI200" : "KOSPI"}</p>
        </div>
        {stock ? (
          <div className="detail-hero__price">
            <strong>{formatWon(stock.currentPrice)}</strong>
            <span className={changeTone(stock.change)}>
              {formatWon(stock.change)} ({formatRate(stock.changeRate)}) · {directionLabel(stock.direction)}
            </span>
          </div>
        ) : null}
        <button className={`report-button ${isWatched ? "is-active" : ""}`} onClick={toggleWatch} type="button">
          {isWatched ? "관심 해제" : "관심 추가"}
        </button>
      </header>

      {candidate ? (
        <AiRecommendation candidate={candidate} />
      ) : (
        <section className="detail-card">
          <p className="factor-empty">이 종목의 AI 분석 결과가 아직 없습니다.</p>
        </section>
      )}

      {stock ? (
        <section className="detail-card reco-reveal" style={{ animationDelay: "440ms" }}>
          <h2>가격 차트</h2>
          <StockChartPanel stock={stock} />
        </section>
      ) : null}

      <footer className="detail-sources">
        <h2>데이터 출처 및 유의사항</h2>
        <ul>
          <li>익일 상승 확률·예측 순위: 자체 학습 Transformer 모델{candidate?.baseDate ? ` (기준일 ${candidate.baseDate})` : ""}.</li>
          <li>수급(외국인·기관 순매수): 최근 거래일 누적 순매수 금액.</li>
          <li>뉴스·감성 점수: 네이버 뉴스 + Gemini 구조화 분석(integrated_pipeline.py · step3).</li>
        </ul>
        <p className="panel-note">
          현재 시세는 KIS 연동 전 데모용 기준 데이터일 수 있습니다. 본 리포트는 투자 참고용이며 투자 손익에 대한
          책임은 투자자 본인에게 있습니다.
        </p>
      </footer>
    </main>
  );
}

import type { StockQuote } from "../../types/trading";

function formatWon(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatRate(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function resultTone(label: string) {
  return String(label).toUpperCase() === "POSITIVE" ? "is-positive" : "is-neutral";
}

/**
 * The post-analysis result: a clean ranked list of the AI-selected short-term
 * picks — 순위 · 종목 · 현재가 · 선정근거. Each row links into the full
 * step3-backed evidence report.
 */
export function AnalysisResults({
  stocks,
  onSelect,
}: {
  stocks: StockQuote[];
  onSelect: (stock: StockQuote) => void;
}) {
  return (
    <section className="analysis-results" id="market-table">
      <header className="analysis-results__head">
        <p className="eyebrow">
          <span aria-hidden="true" />
          AI SELECTED · 단기 선정 후보
        </p>
        <h2>AI가 선정한 단기 후보 {stocks.length}종목</h2>
        <p className="analysis-results__sub">
          순위는 Transformer 상승확률·수급·뉴스 근거를 합산한 종합점수 순입니다. 상승 예측 후보는 주황색, 중립 후보는 검정색 번호로 표시합니다. 각 종목의
          <strong> 선정근거</strong>에서 왜 추천했는지 확인하세요.
        </p>
      </header>

      <div className="result-list" role="table" aria-label="AI 선정 후보">
        <div className="result-row result-row--head" role="row">
          <span role="columnheader">순위</span>
          <span role="columnheader">종목</span>
          <span role="columnheader">현재가</span>
          <span role="columnheader" className="result-col-cta">
            선정근거
          </span>
        </div>

        {stocks.length === 0 ? (
          <div className="result-empty" role="row">
            <strong>이번 분석에서 표시할 상승·중립 후보가 없습니다.</strong>
            <p>LLM이 STEP2 예측값, 수급, 뉴스 근거를 종합했을 때 하락 우위로 분류한 종목은 제외합니다.</p>
          </div>
        ) : stocks.map((stock, index) => (
          <div className="result-row" role="row" key={stock.code}>
            <span className={`result-rank ${resultTone(stock.sentimentLabel)}`} role="cell">
              {String(index + 1).padStart(2, "0")}
            </span>
            <div className="result-name" role="cell">
              <span className="result-logo" aria-hidden="true">
                {stock.name.slice(0, 1)}
              </span>
              <div>
                <strong>{stock.name}</strong>
                <small>{stock.code}</small>
              </div>
            </div>
            <div className="result-price" role="cell">
              <strong>{formatWon(stock.currentPrice)}</strong>
              <span
                className={stock.direction === "up" ? "is-up" : stock.direction === "down" ? "is-down" : ""}
              >
                {formatRate(stock.changeRate)}
              </span>
            </div>
            <button className="result-cta" type="button" onClick={() => onSelect(stock)}>
              선정근거 →
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

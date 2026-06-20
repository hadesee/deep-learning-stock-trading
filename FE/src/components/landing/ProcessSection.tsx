const steps = [
  ["Market Scan", "장 시작 전후 시장 흐름과 변동성, 섹터 온도를 스캔합니다."],
  ["Candidate Ranking", "기술 신호, 수급, 이벤트 점수를 합산해 후보를 정렬합니다."],
  ["AI Review", "모델이 종목별 근거와 예상 시나리오를 비교합니다."],
  ["Risk Gate", "손절폭, 포지션 한도, 진입 제한 조건을 검토합니다."],
  ["Execution Plan", "실행 가능한 전략 슬롯과 대기 조건을 정리합니다."],
  ["Report", "판단 근거와 결과를 리포트로 남겨 추적 가능성을 확보합니다."],
];

export function ProcessSection() {
  return (
    <section className="process-section" id="risk">
      <div className="page-shell process-layout">
        <div className="section-heading process-heading">
          <p className="eyebrow">
            <span aria-hidden="true" />
            AUTOMATION FLOW
          </p>
          <h2>자동화는 빠르게, 의사결정 근거는 선명하게</h2>
        </div>

        <div className="process-grid" id="reports">
          {steps.map(([title, description], index) => (
            <article className="process-card" key={title}>
              <span className="step-badge">{String(index + 1).padStart(2, "0")}</span>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

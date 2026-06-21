import type { Candidate } from "../../types/trading";

type Feature = {
  category: string;
  title: string;
  description: string;
};

const baseFeatures: Feature[] = [
  {
    category: "Technical Signal",
    title: "가격과 지표가 만나는 진입 신호",
    description: "추세, 거래대금, 변동성 흐름을 함께 읽어 후보 종목의 기술적 신뢰도를 정리합니다.",
  },
  {
    category: "Flow Analyst",
    title: "수급 변화의 방향을 먼저 확인",
    description: "외국인과 기관의 누적 수급, 섹터 회전, 시장 주도 흐름을 후보 랭킹에 반영합니다.",
  },
  {
    category: "News & Disclosure",
    title: "뉴스와 공시를 전략 문맥으로 해석",
    description: "이벤트성 재료를 단순 키워드가 아니라 종목별 리스크와 모멘텀 관점으로 분류합니다.",
  },
  {
    category: "Risk Manager",
    title: "진입 전 리스크 게이트",
    description: "손절 기준, 포지션 한도, 변동성 제한을 통과한 경우에만 실행 계획으로 넘깁니다.",
  },
];

function FeatureCircleCard({ feature, index }: { feature: Feature; index: number }) {
  return (
    <article className={`feature-card feature-card--${index + 1}`}>
      <div className="feature-orb" aria-hidden="true">
        <span className="feature-orb__grid" />
        <span className="feature-orb__signal" />
        <a className="satellite-cta" href="#process" aria-label={`${feature.category} 자세히 보기`}>
          ↗
        </a>
      </div>
      <p className="eyebrow feature-eyebrow">
        <span aria-hidden="true" />
        {feature.category}
      </p>
      <h3>{feature.title}</h3>
      <p>{feature.description}</p>
    </article>
  );
}

function buildFeatures(candidates: Candidate[]): Feature[] {
  const top = candidates[0];
  const riskCandidate =
    candidates.find((candidate) => candidate.sentimentLabel === "NEGATIVE") ??
    candidates[candidates.length - 1];

  return baseFeatures.map((feature) => {
    if (feature.category === "Technical Signal" && top) {
      return {
        ...feature,
        description: `${top.companyName} 기준 예상 수익률 ${
          top.predictedReturn === null ? "확인 대기" : `${top.predictedReturn.toFixed(2)}%`
        } 등 모델 신호를 후보 랭킹에 반영합니다.`,
      };
    }

    if (feature.category === "Risk Manager" && riskCandidate) {
      return {
        ...feature,
        description: `${riskCandidate.companyName}처럼 경계 신호가 있는 후보는 진입 전 제한 조건과 손절 기준을 먼저 확인합니다.`,
      };
    }

    return feature;
  });
}

type FeatureOrbitSectionProps = {
  candidates: Candidate[];
};

export function FeatureOrbitSection({ candidates }: FeatureOrbitSectionProps) {
  const features = buildFeatures(candidates);

  return (
    <section className="feature-section" id="strategy">
      <div className="page-shell">
        <div className="section-heading">
          <p className="eyebrow">
            <span aria-hidden="true" />
            STRATEGY CONSTELLATION
          </p>
          <h2>분석, 판단, 리스크 제어가 하나의 궤도로 연결됩니다</h2>
        </div>

        <div className="feature-orbit-grid" id="automation">
          <span className="orbit-line orbit-line--one" aria-hidden="true" />
          <span className="orbit-line orbit-line--two" aria-hidden="true" />
          {features.map((feature, index) => (
            <FeatureCircleCard key={feature.category} feature={feature} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}

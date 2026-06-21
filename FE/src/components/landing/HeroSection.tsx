import { Link } from "react-router-dom";
import { PillButton } from "../ui/PillButton";
import { HeroDashboardPreview } from "./HeroDashboardPreview";
import type { LandingData } from "../../types/trading";

type HeroSectionProps = {
  data: LandingData;
};

export function HeroSection({ data }: HeroSectionProps) {
  return (
    <section className="hero-section" id="market">
      <div className="page-shell hero-layout">
        <div className="hero-copy">
          <p className="eyebrow">
            <span aria-hidden="true" />
            KOSPI AI TRADING SYSTEM
          </p>
          <h1>AI가 시장을 읽고, 전략은 데이터로 검증합니다</h1>
          <p className="hero-description">
            코스피 종목의 가격, 수급, 뉴스, 공시, 시장 주도 흐름을 분석해 자동매매
            의사결정을 보조하는 트레이딩 데스크형 시스템입니다.
          </p>
          <div className="hero-actions">
            <Link className="pill-button pill-button--primary" state={{ resetAnalysis: true }} to="/dashboard">
              대시보드 시작하기
            </Link>
            <PillButton href="#strategy" variant="secondary">
              전략 둘러보기
            </PillButton>
          </div>
        </div>

        <HeroDashboardPreview data={data} />
      </div>
    </section>
  );
}

import { FloatingNav } from "../components/landing/FloatingNav";
import { HeroSection } from "../components/landing/HeroSection";
import { FeatureOrbitSection } from "../components/landing/FeatureOrbitSection";
import { ProcessSection } from "../components/landing/ProcessSection";
import { SiteFooter } from "../components/landing/SiteFooter";
import { ErrorView, LoadingView } from "../components/common/StatusView";
import { useAsyncData } from "../hooks/useAsyncData";
import { fetchLandingData } from "../services/tradingData";

export function LandingPage() {
  const { data, error, isLoading, reload } = useAsyncData(fetchLandingData);

  return (
    <div id="top">
      <FloatingNav />
      {isLoading ? (
        <main className="landing-status">
          <LoadingView label="시장 분석 데이터를 불러오는 중입니다" />
        </main>
      ) : error || !data ? (
        <main className="landing-status">
          <ErrorView message={error?.message} onRetry={reload} />
        </main>
      ) : (
        <main>
          <HeroSection data={data} />
          <FeatureOrbitSection candidates={data.candidates} />
          <ProcessSection />
        </main>
      )}
      <SiteFooter />
    </div>
  );
}

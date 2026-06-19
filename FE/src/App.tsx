import { lazy, Suspense, useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { ErrorBoundary } from "./components/common/ErrorBoundary";
import { LoadingView } from "./components/common/StatusView";

// Split each route into its own chunk so the initial landing load doesn't pull
// in the heavy dashboard (table, candle chart, KIS client) until it's visited.
const LandingPage = lazy(() => import("./pages/LandingPage").then((module) => ({ default: module.LandingPage })));
const DashboardPage = lazy(() => import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })));
const StockDetailPage = lazy(() => import("./pages/StockDetailPage").then((module) => ({ default: module.StockDetailPage })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then((module) => ({ default: module.NotFoundPage })));

function ScrollToTop() {
  const { pathname, hash } = useLocation();

  useEffect(() => {
    // A hash means the user is deep-linking to a section (e.g. /dashboard#market-table);
    // let that section's own scroll handler take over instead of jumping to the top.
    if (hash) {
      return;
    }

    window.scrollTo({ top: 0, behavior: "auto" });
  }, [pathname, hash]);

  return null;
}

export default function App() {
  return (
    <ErrorBoundary>
      <ScrollToTop />
      <Suspense
        fallback={
          <main className="page-status">
            <LoadingView label="화면을 불러오는 중입니다" />
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/stock/:code" element={<StockDetailPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

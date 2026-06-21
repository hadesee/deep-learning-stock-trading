import { useEffect, useState } from "react";
import { getKospiStockChartBundle, type ResolvedStockChartBundle } from "../../../services/kospiStockChart";
import type { StockQuote } from "../../../types/trading";
import { TIME_RANGES, type ChartMode, type PricePoint, type TimeRange } from "../../../types/stockChart";
import { AreaPriceChart } from "./AreaPriceChart";
import { CandlePriceChart } from "./CandlePriceChart";
import { getPriceTone, TIME_RANGE_LABELS } from "./formatters";
import { StockPriceHeader } from "./StockPriceHeader";
import { StockStatGrid } from "./StockStatGrid";
import { TimeRangeSelector } from "./TimeRangeSelector";

type StockChartPanelProps = {
  stock: StockQuote;
};

type ChartState = {
  bundle: ResolvedStockChartBundle | null;
  error: string | null;
  isLoading: boolean;
};

const DEFAULT_RANGE: TimeRange = "1D";

function getRangePerformance(range: TimeRange, bundle: ResolvedStockChartBundle, prices: PricePoint[]) {
  if (range === "1D") {
    return {
      changeAmount: bundle.summary.dayChangeAmount,
      changeRate: bundle.summary.dayChangeRate,
      label: "정규장마감",
    };
  }

  const firstPrice = prices[0]?.price ?? bundle.chartData.currentPrice;
  const lastPrice = prices[prices.length - 1]?.price ?? bundle.chartData.currentPrice;
  const changeAmount = lastPrice - firstPrice;

  return {
    changeAmount,
    changeRate: firstPrice > 0 ? (changeAmount / firstPrice) * 100 : 0,
    label: `${TIME_RANGE_LABELS[range]} 수익률`,
  };
}

export function StockChartPanel({ stock }: StockChartPanelProps) {
  const [range, setRange] = useState<TimeRange>(DEFAULT_RANGE);
  const [mode, setMode] = useState<ChartMode>("area");
  const [chartState, setChartState] = useState<ChartState>({
    bundle: null,
    error: null,
    isLoading: true,
  });

  useEffect(() => {
    setRange(DEFAULT_RANGE);
    setMode("area");
  }, [stock.code]);

  // Fetch the whole bundle once per stock — it carries every range, so changing
  // the range below just reads from memory (no refetch, no loading spinner).
  useEffect(() => {
    const controller = new AbortController();

    setChartState({ bundle: null, error: null, isLoading: true });

    getKospiStockChartBundle(stock.code, stock, controller.signal)
      .then((bundle) => {
        setChartState({ bundle, error: null, isLoading: false });
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }

        const message = error instanceof Error ? error.message : "KIS 차트 데이터를 불러오지 못했습니다.";
        setChartState({ bundle: null, error: message, isLoading: false });
      });

    return () => controller.abort();
  }, [stock.code]);

  // If the selected range came back empty (e.g. KIS rate-limited the 1D intraday
  // call), fall back to the first range that does have data so the default tab is
  // never blank.
  useEffect(() => {
    const bundle = chartState.bundle;
    if (!bundle) {
      return;
    }

    const hasData = (value: TimeRange) =>
      bundle.chartData.ranges[value].prices.length > 0 || bundle.chartData.ranges[value].candles.length > 0;

    if (!hasData(range)) {
      const firstWithData = TIME_RANGES.find(hasData);
      if (firstWithData && firstWithData !== range) {
        setRange(firstWithData);
      }
    }
  }, [chartState.bundle, range]);

  const rangeData = chartState.bundle?.chartData.ranges[range] ?? { candles: [], prices: [] };
  const hasCurrentRangeData = rangeData.prices.length > 0 || rangeData.candles.length > 0;

  if (chartState.isLoading && (!chartState.bundle || !hasCurrentRangeData)) {
    return (
      <section className="stock-chart-panel">
        <p className="stock-chart-state">KIS 차트 데이터를 불러오는 중입니다.</p>
      </section>
    );
  }

  if (!chartState.bundle) {
    return (
      <section className="stock-chart-panel">
        <p className="stock-chart-state stock-chart-state--error">
          {chartState.error ?? "차트 데이터를 불러오지 못했습니다."}
        </p>
      </section>
    );
  }

  const bundle = chartState.bundle;
  const prices = rangeData.prices;
  const candles = rangeData.candles;
  const performance = getRangePerformance(range, bundle, prices);
  const tone = getPriceTone(performance.changeAmount);
  const averageBuyPrice = bundle.chartData.averageBuyPrice;

  return (
    <section className="stock-chart-panel" aria-label={`${stock.name} 가격 차트`}>
      <StockPriceHeader
        changeAmount={performance.changeAmount}
        changeRate={performance.changeRate}
        code={bundle.chartData.code}
        currentPrice={bundle.chartData.currentPrice}
        name={bundle.chartData.name}
        performanceLabel={performance.label}
        tone={tone}
      />

      <div className="stock-chart-panel__plot">
        {mode === "area" ? (
          <AreaPriceChart averageBuyPrice={averageBuyPrice} prices={prices} tone={tone} />
        ) : (
          <CandlePriceChart averageBuyPrice={averageBuyPrice} candles={candles} />
        )}
      </div>

      <TimeRangeSelector
        mode={mode}
        onModeToggle={() => setMode((current) => (current === "area" ? "candle" : "area"))}
        onRangeChange={setRange}
        range={range}
      />

      {bundle.warning ? (
        <p className="stock-chart-warning">
          KIS 실시간 차트 응답이 지연되어 현재가 기준 대체 차트를 표시합니다.
        </p>
      ) : null}

      <StockStatGrid summary={bundle.summary} />
    </section>
  );
}

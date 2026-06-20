import { useId, useMemo, useRef, useState } from "react";
import type { PricePoint } from "../../../types/stockChart";
import { AveragePriceLine } from "./AveragePriceLine";
import type { PriceTone } from "./formatters";
import { formatPointDate, formatWon } from "./formatters";

type AreaPriceChartProps = {
  averageBuyPrice?: number;
  prices: PricePoint[];
  tone: PriceTone;
};

const VIEW_W = 100;
const VIEW_H = 100;
const TOP_PAD = 6;
const BOTTOM_PAD = 92;

const TONE_COLORS: Record<PriceTone, string> = {
  down: "#1f73ff",
  flat: "#696969",
  up: "#ef3e55",
};

function getPriceBounds(prices: PricePoint[]) {
  const values = prices.map((point) => point.price);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const padding = Math.max((max - min) * 0.12, max * 0.01, 1);

  return {
    max: max + padding,
    min: Math.max(1, min - padding),
  };
}

export function AreaPriceChart({ averageBuyPrice, prices, tone }: AreaPriceChartProps) {
  const gradientId = `area-gradient-${useId().replace(/:/g, "")}`;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const model = useMemo(() => {
    if (prices.length === 0) {
      return null;
    }

    const bounds = getPriceBounds(prices);
    const range = Math.max(bounds.max - bounds.min, 1);
    const toX = (index: number) => (index / Math.max(prices.length - 1, 1)) * VIEW_W;
    const toY = (price: number) => BOTTOM_PAD - ((price - bounds.min) / range) * (BOTTOM_PAD - TOP_PAD);
    const points = prices.map((point, index) => ({
      ...point,
      x: toX(index),
      y: toY(point.price),
    }));
    const linePath = points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x} ${point.y}`).join(" ");
    const areaPath = `${linePath} L ${VIEW_W} ${VIEW_H} L 0 ${VIEW_H} Z`;
    const averageTopPercent =
      averageBuyPrice && averageBuyPrice >= bounds.min && averageBuyPrice <= bounds.max ? toY(averageBuyPrice) : null;

    return {
      areaPath,
      averageTopPercent,
      linePath,
      points,
    };
  }, [averageBuyPrice, prices]);

  if (!model) {
    return <p className="stock-chart-state">차트 데이터가 없습니다.</p>;
  }

  const activePoint = activeIndex === null ? null : model.points[activeIndex];
  const color = TONE_COLORS[tone];

  return (
    <div className={`area-price-chart area-price-chart--${tone}`}>
      <svg
        className="area-price-chart__svg"
        onPointerLeave={() => setActiveIndex(null)}
        onPointerMove={(event) => {
          const rect = svgRef.current?.getBoundingClientRect();
          if (!rect) {
            return;
          }

          const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
          setActiveIndex(Math.round(ratio * (prices.length - 1)));
        }}
        preserveAspectRatio="none"
        ref={svgRef}
        role="img"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      >
        <title>선택 기간 가격 면적 차트</title>
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.34" />
            <stop offset="78%" stopColor={color} stopOpacity="0.05" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={model.areaPath} fill={`url(#${gradientId})`} />
        <path
          d={model.linePath}
          fill="none"
          stroke={color}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="1.6"
          vectorEffect="non-scaling-stroke"
        />
        {activePoint ? (
          <g>
            <line
              className="stock-chart-crosshair"
              x1={activePoint.x}
              x2={activePoint.x}
              y1={TOP_PAD}
              y2={BOTTOM_PAD}
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={activePoint.x} cy={activePoint.y} fill={color} r="1.8" vectorEffect="non-scaling-stroke" />
          </g>
        ) : null}
      </svg>

      <AveragePriceLine price={averageBuyPrice ?? 0} topPercent={model.averageTopPercent} />

      {activePoint ? (
        <div className="stock-chart-tooltip" style={{ left: `${activePoint.x}%`, top: `${activePoint.y}%` }}>
          <span>{formatPointDate(activePoint.date)}</span>
          <strong>{formatWon(activePoint.price)}</strong>
        </div>
      ) : null}
    </div>
  );
}

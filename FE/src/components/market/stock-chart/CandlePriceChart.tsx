import { useMemo } from "react";
import type { CandlePoint } from "../../../types/stockChart";
import { AveragePriceLine } from "./AveragePriceLine";

type CandlePriceChartProps = {
  averageBuyPrice?: number;
  candles: CandlePoint[];
};

const VIEW_W = 100;
const VIEW_H = 100;
const PRICE_TOP = 6;
const PRICE_BOTTOM = 76;
const VOL_TOP = 84;
const VOL_BOTTOM = 98;
const GRID_RATIOS = [0, 0.25, 0.5, 0.75, 1];

function formatAxis(value: number) {
  return Math.round(value).toLocaleString("ko-KR");
}

export function CandlePriceChart({ averageBuyPrice, candles }: CandlePriceChartProps) {
  const model = useMemo(() => {
    if (candles.length === 0) {
      return null;
    }

    const rawLow = Math.min(...candles.map((candle) => candle.low));
    const rawHigh = Math.max(...candles.map((candle) => candle.high));
    const padding = Math.max((rawHigh - rawLow) * 0.08, rawHigh * 0.004, 1);
    const minLow = Math.max(1, rawLow - padding);
    const maxHigh = rawHigh + padding;
    const priceRange = Math.max(maxHigh - minLow, 1);
    const maxVolume = Math.max(...candles.map((candle) => candle.volume ?? 0), 1);
    const slot = VIEW_W / candles.length;
    const bodyWidth = Math.min(Math.max(slot * 0.62, 0.35), 4);
    const toY = (price: number) => PRICE_BOTTOM - ((price - minLow) / priceRange) * (PRICE_BOTTOM - PRICE_TOP);

    const last = candles[candles.length - 1];
    const lastUp = last.close >= last.open;
    const averageTopPercent =
      averageBuyPrice && averageBuyPrice >= minLow && averageBuyPrice <= maxHigh ? toY(averageBuyPrice) : null;

    return {
      averageTopPercent,
      bars: candles.map((candle, index) => {
        const center = (index + 0.5) * slot;
        const up = candle.close >= candle.open;
        const bodyTop = toY(Math.max(candle.open, candle.close));
        const bodyBottom = toY(Math.min(candle.open, candle.close));
        const volumeHeight = ((candle.volume ?? 0) / maxVolume) * (VOL_BOTTOM - VOL_TOP);

        return {
          bodyHeight: Math.max(bodyBottom - bodyTop, 0.5),
          bodyTop,
          bodyX: center - bodyWidth / 2,
          center,
          key: `${candle.time}-${index}`,
          tone: up ? "up" : "down",
          volumeHeight,
          volumeTop: VOL_BOTTOM - volumeHeight,
          wickBottom: toY(candle.low),
          wickTop: toY(candle.high),
        };
      }),
      bodyWidth,
      gridLines: GRID_RATIOS.map((ratio) => {
        const y = PRICE_TOP + ratio * (PRICE_BOTTOM - PRICE_TOP);
        return { price: minLow + ((PRICE_BOTTOM - y) / (PRICE_BOTTOM - PRICE_TOP)) * priceRange, y };
      }),
      lastClose: last.close,
      lastCloseY: toY(last.close),
      lastTone: lastUp ? "up" : "down",
    };
  }, [averageBuyPrice, candles]);

  if (!model) {
    return <p className="stock-chart-state">차트 데이터가 없습니다.</p>;
  }

  return (
    <div className="candle-price-chart">
      <svg className="candle-price-chart__svg" preserveAspectRatio="none" role="img" viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}>
        <title>선택 기간 캔들 차트</title>
        {model.gridLines.map((grid) => (
          <line
            className="candle-price-chart__grid"
            key={grid.y}
            x1={0}
            x2={VIEW_W}
            y1={grid.y}
            y2={grid.y}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        <line
          className={`candle-price-chart__lastline candle-price-chart__lastline--${model.lastTone}`}
          x1={0}
          x2={VIEW_W}
          y1={model.lastCloseY}
          y2={model.lastCloseY}
          vectorEffect="non-scaling-stroke"
        />

        {model.bars.map((bar) => (
          <g className={`candle-price-chart__bar candle-price-chart__bar--${bar.tone}`} key={bar.key}>
            <line
              className="candle-price-chart__wick"
              x1={bar.center}
              x2={bar.center}
              y1={bar.wickTop}
              y2={bar.wickBottom}
              vectorEffect="non-scaling-stroke"
            />
            <rect
              className="candle-price-chart__body"
              height={bar.bodyHeight}
              rx="0.35"
              width={model.bodyWidth}
              x={bar.bodyX}
              y={bar.bodyTop}
            />
            <rect
              className="candle-price-chart__volume"
              height={bar.volumeHeight}
              rx="0.3"
              width={model.bodyWidth}
              x={bar.bodyX}
              y={bar.volumeTop}
            />
          </g>
        ))}
      </svg>

      <div className="candle-price-chart__axis" aria-hidden="true">
        {model.gridLines.map((grid) => (
          <span className="candle-price-chart__tick" key={grid.y} style={{ top: `${grid.y}%` }}>
            {formatAxis(grid.price)}
          </span>
        ))}
        <span
          className={`candle-price-chart__lasttag candle-price-chart__lasttag--${model.lastTone}`}
          style={{ top: `${model.lastCloseY}%` }}
        >
          {formatAxis(model.lastClose)}
        </span>
      </div>

      <AveragePriceLine price={averageBuyPrice ?? 0} topPercent={model.averageTopPercent} />
    </div>
  );
}

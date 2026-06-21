import { useMemo } from "react";
import type { Candle } from "../../types/trading";

type CandleChartProps = {
  candles: Candle[];
  /** Marks the latest close with a dashed reference line + price tag. */
  showLastClose?: boolean;
};

/**
 * Fixed horizontal viewBox width. Because the SVG fills its container with
 * `preserveAspectRatio="none"`, keeping this constant (instead of scaling it to
 * the candle count) means a candle body of N viewBox units renders at the same
 * pixel width regardless of how many candles are shown — so daily and yearly
 * candles stay visually consistent instead of fattening as the count drops.
 */
const VIEW_W = 300;
const VIEW_H = 100;
const PRICE_TOP = 6;
const PRICE_BOTTOM = 70;
const VOL_TOP = 80;
const VOL_BOTTOM = 98;
/** Cap so a handful of candles (e.g. yearly) don't render as fat blocks. */
const MAX_BODY_W = 9;

function formatWon(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

function formatAxis(value: number) {
  return Math.round(value).toLocaleString("ko-KR");
}

/**
 * Dependency-free SVG candlestick chart with a volume strip and a price axis.
 * Renders real OHLC candles (body = open→close, wick = high→low) using the
 * Korean colour convention (up = red, down = blue). Candle width is fixed in
 * pixels; the price axis labels sit in a right-hand gutter so they aren't
 * distorted by the non-uniform SVG scaling.
 */
export function CandleChart({ candles, showLastClose = true }: CandleChartProps) {
  const model = useMemo(() => {
    if (candles.length === 0) {
      return null;
    }

    const maxHigh = Math.max(...candles.map((candle) => candle.high));
    const minLow = Math.min(...candles.map((candle) => candle.low));
    const priceRange = Math.max(maxHigh - minLow, 1);
    const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1);

    const toPriceY = (value: number) =>
      PRICE_BOTTOM - ((value - minLow) / priceRange) * (PRICE_BOTTOM - PRICE_TOP);
    const priceAtY = (y: number) =>
      minLow + ((PRICE_BOTTOM - y) / (PRICE_BOTTOM - PRICE_TOP)) * priceRange;

    const slot = VIEW_W / candles.length;
    const bodyW = Math.min(Math.max(slot * 0.6, 0.8), MAX_BODY_W);
    const last = candles[candles.length - 1];

    const gridYs = [0, 0.25, 0.5, 0.75, 1].map((ratio) => PRICE_TOP + ratio * (PRICE_BOTTOM - PRICE_TOP));

    return {
      bars: candles.map((candle, index) => {
        const up = candle.close >= candle.open;
        const center = (index + 0.5) * slot;
        const bodyTop = toPriceY(Math.max(candle.open, candle.close));
        const bodyBottom = toPriceY(Math.min(candle.open, candle.close));
        const volHeight = (candle.volume / maxVolume) * (VOL_BOTTOM - VOL_TOP);

        return {
          key: `${candle.date}-${index}`,
          center,
          bodyX: center - bodyW / 2,
          up,
          wickTop: toPriceY(candle.high),
          wickBottom: toPriceY(candle.low),
          bodyTop,
          bodyHeight: Math.max(bodyBottom - bodyTop, 0.6),
          volTop: VOL_BOTTOM - volHeight,
          volHeight,
        };
      }),
      bodyW,
      gridYs,
      ticks: gridYs.map((y) => ({ y, price: priceAtY(y) })),
      lastCloseY: toPriceY(last.close),
      lastClose: last.close,
      lastUp: last.close >= last.open,
    };
  }, [candles]);

  if (!model) {
    return <p className="candle-chart__empty">차트 데이터를 준비 중입니다.</p>;
  }

  return (
    <figure className="candle-chart">
      <div className="candle-chart__plot">
        <svg
          className="candle-chart__svg"
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`최근 ${candles.length}개 봉 캔들 차트`}
        >
          {model.gridYs.map((y) => (
            <line
              className="candle-grid"
              key={y}
              x1={0}
              x2={VIEW_W}
              y1={y}
              y2={y}
              vectorEffect="non-scaling-stroke"
            />
          ))}

          {showLastClose ? (
            <line
              className={`candle-lastclose candle-${model.lastUp ? "up" : "down"}`}
              x1={0}
              x2={VIEW_W}
              y1={model.lastCloseY}
              y2={model.lastCloseY}
              vectorEffect="non-scaling-stroke"
            />
          ) : null}

          {model.bars.map((bar) => {
            const tone = bar.up ? "up" : "down";
            return (
              <g className={`candle-${tone}`} key={bar.key}>
                <line
                  className="candle-wick"
                  x1={bar.center}
                  x2={bar.center}
                  y1={bar.wickTop}
                  y2={bar.wickBottom}
                  vectorEffect="non-scaling-stroke"
                />
                <rect className="candle-body" x={bar.bodyX} y={bar.bodyTop} width={model.bodyW} height={bar.bodyHeight} />
                <rect className="candle-vol" x={bar.bodyX} y={bar.volTop} width={model.bodyW} height={bar.volHeight} />
              </g>
            );
          })}
        </svg>

        <div className="candle-chart__axis" aria-hidden="true">
          {model.ticks.map((tick) => (
            <span className="candle-chart__tick" key={tick.y} style={{ top: `${tick.y}%` }}>
              {formatAxis(tick.price)}
            </span>
          ))}
          {showLastClose ? (
            <span
              className={`candle-chart__lasttag candle-chart__lasttag--${model.lastUp ? "up" : "down"}`}
              style={{ top: `${model.lastCloseY}%` }}
            >
              {formatAxis(model.lastClose)}
            </span>
          ) : null}
        </div>
      </div>

      <figcaption className="candle-chart__caption">
        <span>최근 종가 {formatWon(model.lastClose)}</span>
        <span className="candle-chart__legend">
          <i className="candle-dot candle-dot--up" aria-hidden="true" /> 상승
          <i className="candle-dot candle-dot--down" aria-hidden="true" /> 하락 · 하단 거래량
        </span>
      </figcaption>
    </figure>
  );
}

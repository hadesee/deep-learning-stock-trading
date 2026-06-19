import type { ChartMode } from "../../../types/stockChart";

type ChartModeToggleProps = {
  mode: ChartMode;
  onToggle: () => void;
};

export function ChartModeToggle({ mode, onToggle }: ChartModeToggleProps) {
  const isCandle = mode === "candle";

  return (
    <button
      aria-label={isCandle ? "면적 차트로 전환" : "캔들 차트로 전환"}
      aria-pressed={isCandle}
      className="chart-mode-toggle"
      onClick={onToggle}
      title={isCandle ? "면적 차트" : "캔들 차트"}
      type="button"
    >
      <svg viewBox="0 0 32 32" aria-hidden="true" focusable="false">
        <line x1="8" x2="8" y1="8" y2="25" />
        <rect x="5.5" y="14" width="5" height="8" rx="1" />
        <line x1="16" x2="16" y1="5" y2="21" />
        <rect x="13.5" y="8" width="5" height="8" rx="1" />
        <line x1="24" x2="24" y1="9" y2="26" />
        <rect x="21.5" y="17" width="5" height="7" rx="1" />
      </svg>
    </button>
  );
}

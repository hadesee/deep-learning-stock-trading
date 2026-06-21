import type { ChartMode, TimeRange } from "../../../types/stockChart";
import { TIME_RANGES } from "../../../types/stockChart";
import { ChartModeToggle } from "./ChartModeToggle";

type TimeRangeSelectorProps = {
  mode: ChartMode;
  onModeToggle: () => void;
  onRangeChange: (range: TimeRange) => void;
  range: TimeRange;
};

export function TimeRangeSelector({ mode, onModeToggle, onRangeChange, range }: TimeRangeSelectorProps) {
  return (
    <div className="time-range-selector" role="group" aria-label="차트 기간">
      {TIME_RANGES.map((item) => (
        <button
          aria-pressed={range === item}
          className="time-range-selector__tab"
          key={item}
          onClick={() => onRangeChange(item)}
          type="button"
        >
          {item}
        </button>
      ))}
      <ChartModeToggle mode={mode} onToggle={onModeToggle} />
    </div>
  );
}

import type { StockSummary } from "../../../types/stockChart";
import { formatCompactShares, formatKoreanMarketCap, formatWon } from "./formatters";

type StockStatGridProps = {
  summary: StockSummary;
};

export function StockStatGrid({ summary }: StockStatGridProps) {
  const stats = [
    { label: "시작가", value: formatWon(summary.openingPrice) },
    { label: "전일거래량", value: formatCompactShares(summary.previousVolume) },
    { label: "시가총액", value: formatKoreanMarketCap(summary.marketCap) },
    { label: "배당수익률", value: `${summary.dividendYield.toFixed(2)}%` },
  ];

  return (
    <dl className="stock-stat-grid">
      {stats.map((stat) => (
        <div key={stat.label}>
          <dt>{stat.label}</dt>
          <dd>{stat.value}</dd>
        </div>
      ))}
    </dl>
  );
}

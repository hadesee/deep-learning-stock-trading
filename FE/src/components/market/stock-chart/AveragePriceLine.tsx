import { formatWon } from "./formatters";

type AveragePriceLineProps = {
  price: number;
  topPercent: number | null;
};

export function AveragePriceLine({ price, topPercent }: AveragePriceLineProps) {
  if (topPercent === null) {
    return null;
  }

  return (
    <div className="average-price-line" style={{ top: `${topPercent}%` }}>
      <span>평균구매 {formatWon(price)}</span>
    </div>
  );
}

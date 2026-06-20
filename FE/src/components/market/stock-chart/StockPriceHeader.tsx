import type { PriceTone } from "./formatters";
import { formatChangeRate, formatWon } from "./formatters";

type StockPriceHeaderProps = {
  changeAmount: number;
  changeRate: number;
  code: string;
  currentPrice: number;
  name: string;
  performanceLabel: string;
  tone: PriceTone;
};

function getMarker(tone: PriceTone) {
  if (tone === "up") {
    return "▲";
  }

  if (tone === "down") {
    return "▼";
  }

  return "";
}

export function StockPriceHeader({
  changeAmount,
  changeRate,
  code,
  currentPrice,
  name,
  performanceLabel,
  tone,
}: StockPriceHeaderProps) {
  const marker = getMarker(tone);

  return (
    <header className="stock-price-header">
      <div className="stock-price-header__identity">
        <strong>{name}</strong>
        <span>{code}</span>
      </div>
      <div className="stock-price-header__price">{formatWon(currentPrice)}</div>
      <p className={`stock-price-header__change stock-price-header__change--${tone}`}>
        <span>
          {marker ? `${marker} ` : ""}
          {formatWon(Math.abs(changeAmount))} ({formatChangeRate(changeRate)})
        </span>
        <small>{performanceLabel}</small>
      </p>
    </header>
  );
}

import type { TimeRange } from "../../../types/stockChart";

export type PriceTone = "up" | "down" | "flat";

export const TIME_RANGE_LABELS: Record<TimeRange, string> = {
  "1D": "1일",
  "1M": "1개월",
  "3M": "3개월",
  "1Y": "1년",
  "3Y": "3년",
  "5Y": "5년",
};

export function formatWon(value: number) {
  return `${Math.round(value).toLocaleString("ko-KR")}원`;
}

export function formatChangeRate(value: number) {
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

export function getPriceTone(value: number): PriceTone {
  if (value > 0) {
    return "up";
  }

  if (value < 0) {
    return "down";
  }

  return "flat";
}

export function formatCompactShares(value: number) {
  if (value >= 100_000_000) {
    return `${Math.round(value / 10_000_000) / 10}억주`;
  }

  if (value >= 10_000) {
    return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만주`;
  }

  return `${value.toLocaleString("ko-KR")}주`;
}

export function formatKoreanMarketCap(value: number) {
  if (value >= 1_000_000_000_000) {
    return `${Math.round(value / 100_000_000_000) / 10}조원`;
  }

  if (value >= 100_000_000) {
    return `${Math.round(value / 100_000_000).toLocaleString("ko-KR")}억원`;
  }

  return formatWon(value);
}

export function formatPointDate(value: string) {
  if (value.includes("T")) {
    return value.slice(11, 16);
  }

  return value.slice(5).replace("-", ".");
}

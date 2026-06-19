import { useEffect } from "react";

const BASE_TITLE = "KOSPI AI Trading Desk · AI 자동매매 의사결정 보조";

/**
 * Sets the document title for the current route and restores the base title on
 * unmount, so SPA navigation keeps the browser tab/history readable.
 */
export function usePageTitle(title?: string) {
  useEffect(() => {
    document.title = title ? `${title} · KOSPI AI Trading Desk` : BASE_TITLE;

    return () => {
      document.title = BASE_TITLE;
    };
  }, [title]);
}

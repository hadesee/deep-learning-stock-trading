import { useCallback, useEffect, useState } from "react";

export type AsyncState<T> = {
  data: T | null;
  error: Error | null;
  isLoading: boolean;
  isRefreshing: boolean;
  reload: () => void;
};

/**
 * Runs an async loader on mount, exposing loading/error/data plus a manual
 * `reload`. The loader receives an `AbortSignal` so in-flight requests are
 * cancelled on unmount or reload.
 */
export function useAsyncData<T>(
  loader: (signal: AbortSignal) => Promise<T>,
  deps: ReadonlyArray<unknown> = [],
  initialData: T | null = null,
): AsyncState<T> {
  const [data, setData] = useState<T | null>(initialData);
  const [error, setError] = useState<Error | null>(null);
  const [isLoading, setIsLoading] = useState(() => initialData === null);
  const [isRefreshing, setIsRefreshing] = useState(() => initialData !== null);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((value) => value + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    setIsLoading(data === null);
    setIsRefreshing(data !== null);
    setError(null);

    loader(controller.signal)
      .then((result) => {
        if (active) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!active || controller.signal.aborted) {
          return;
        }

        setError(cause instanceof Error ? cause : new Error("데이터를 불러오지 못했습니다."));
      })
      .finally(() => {
        if (active) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      });

    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, isLoading, isRefreshing, reload };
}

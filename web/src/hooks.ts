import { useCallback, useEffect, useState } from 'react';

export interface FetchState<T> {
  data: T | null;
  error: string;
  loading: boolean;
  reload: () => void;
}

/**
 * 极简加载钩子：依赖变化重新请求，卸载后丢弃结果。
 * 401 由 api 层的全局处理器统一处理，这里只记录普通错误。
 */
export function useFetch<T>(loader: () => Promise<T>, deps: unknown[]): FetchState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    loader()
      .then((value) => {
        if (!alive) return;
        setData(value);
        setError('');
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        const message = (cause as Error).message;
        if (message !== 'unauthorized') setError(message);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
    // loader 每次渲染都是新函数，依赖由调用方显式给出。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  return { data, error, loading, reload };
}

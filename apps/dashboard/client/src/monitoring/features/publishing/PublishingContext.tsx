import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

import type { PublisherGateway } from "./gateway";

const PublishingGatewayContext = createContext<PublisherGateway | null>(null);

export function PublishingGatewayProvider({
  gateway,
  children,
}: {
  gateway: PublisherGateway;
  children: ReactNode;
}) {
  return (
    <PublishingGatewayContext.Provider value={gateway}>
      {children}
    </PublishingGatewayContext.Provider>
  );
}

export function usePublisherGateway() {
  const gateway = useContext(PublishingGatewayContext);
  if (!gateway) throw new Error("PublishingGatewayProvider is missing");
  return gateway;
}

export type PublisherQueryState<T> = {
  data?: T;
  error?: Error;
  loading: boolean;
  refreshing: boolean;
  reload: () => void;
};

export function usePublisherQuery<T>(
  load: (signal: AbortSignal) => Promise<T>,
): PublisherQueryState<T> {
  const [state, setState] = useState<{
    data?: T;
    error?: Error;
    loading: boolean;
    refreshing: boolean;
  }>({ loading: true, refreshing: false });
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({
      ...current,
      error: undefined,
      loading: current.data === undefined,
      refreshing: current.data !== undefined,
    }));
    void load(controller.signal)
      .then((data) => {
        if (!controller.signal.aborted) {
          setState({ data, loading: false, refreshing: false });
        }
      })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        const error = reason instanceof Error ? reason : new Error("请求失败");
        setState((current) => ({
          ...current,
          error,
          loading: false,
          refreshing: false,
        }));
      });
    return () => controller.abort();
  }, [load, reloadToken]);

  return {
    ...state,
    reload: () => setReloadToken((value) => value + 1),
  };
}

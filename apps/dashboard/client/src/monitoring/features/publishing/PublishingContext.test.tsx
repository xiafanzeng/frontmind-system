import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PublishingGatewayProvider,
  usePublisherQuery,
  type PublisherQueryState,
} from "./PublishingContext";
import type { PublisherGateway } from "./gateway";

type Load = (signal: AbortSignal) => Promise<string>;

function deferred() {
  let resolve!: (value: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function harness(gateway: PublisherGateway, load: Load, cacheKey?: string) {
  const renders: PublisherQueryState<string>[] = [];
  function Probe({ load, cacheKey }: { load: Load; cacheKey?: string }) {
    const query = usePublisherQuery(load, cacheKey);
    renders.push(query);
    return (
      <div>
        {query.data ?? (query.loading ? "loading" : query.error?.message)}
      </div>
    );
  }
  const tree = (gateway: PublisherGateway, load: Load, cacheKey?: string) => (
    <PublishingGatewayProvider gateway={gateway}>
      <Probe load={load} cacheKey={cacheKey} />
    </PublishingGatewayProvider>
  );
  const view = render(tree(gateway, load, cacheKey));
  return {
    ...view,
    renders,
    current: () => renders.at(-1)!,
    switch: (gateway: PublisherGateway, load: Load, cacheKey?: string) => {
      renders.length = 0;
      view.rerender(tree(gateway, load, cacheKey));
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePublisherQuery", () => {
  it("shows the same gateway's cached overview immediately and retains it if refresh fails", async () => {
    const gateway = {} as PublisherGateway;
    const first = harness(gateway, async () => "enterprise A", "overview");
    await waitFor(() => expect(first.current().data).toBe("enterprise A"));
    first.unmount();

    const refresh = deferred();
    const next = harness(gateway, () => refresh.promise, "overview");
    expect(next.renders[0]).toMatchObject({
      data: "enterprise A",
      loading: false,
      refreshing: true,
    });
    await act(async () => refresh.reject(new Error("offline")));
    expect(next.current()).toMatchObject({
      data: "enterprise A",
      loading: false,
      refreshing: false,
    });
    expect(next.current().error?.message).toBe("offline");
  });

  it("never renders the previous gateway's private data during an enterprise switch", async () => {
    const a = {} as PublisherGateway,
      b = {} as PublisherGateway;
    const view = harness(a, async () => "private A", "overview");
    await waitFor(() => expect(view.current().data).toBe("private A"));
    const pending = deferred();
    view.switch(b, () => pending.promise, "overview");
    expect(view.renders.every((state) => state.data === undefined)).toBe(true);
    expect(view.renders[0].loading).toBe(true);
    await act(async () => pending.resolve("private B"));
    expect(view.current().data).toBe("private B");
  });

  it("uses only the destination scope's existing cache on the first switch render", async () => {
    const a = {} as PublisherGateway,
      b = {} as PublisherGateway;
    const seed = harness(b, async () => "cached B", "overview");
    await waitFor(() => expect(seed.current().data).toBe("cached B"));
    seed.unmount();
    const view = harness(a, async () => "private A", "overview");
    await waitFor(() => expect(view.current().data).toBe("private A"));
    const pending = deferred();
    view.switch(b, () => pending.promise, "overview");
    expect(view.renders.every((state) => state.data === "cached B")).toBe(true);
    expect(view.renders[0].refreshing).toBe(true);
  });

  it("clears the previous cache key immediately within the same gateway", async () => {
    const gateway = {} as PublisherGateway;
    const view = harness(gateway, async () => "overview", "overview");
    await waitFor(() => expect(view.current().data).toBe("overview"));
    const pending = deferred();
    view.switch(gateway, () => pending.promise, "another-page");
    expect(view.renders.every((state) => state.data === undefined)).toBe(true);
    await act(async () => pending.resolve("another page"));
    expect(view.current().data).toBe("another page");
  });

  it("also isolates unkeyed queries when the gateway changes", async () => {
    const view = harness({} as PublisherGateway, async () => "private A");
    await waitFor(() => expect(view.current().data).toBe("private A"));
    const pending = deferred();
    view.switch({} as PublisherGateway, () => pending.promise);
    expect(view.renders.every((state) => state.data === undefined)).toBe(true);
    await act(async () => pending.resolve("private B"));
    expect(view.current().data).toBe("private B");
  });

  it("aborts a previous scope and ignores its late result without contaminating either cache", async () => {
    const a = {} as PublisherGateway,
      b = {} as PublisherGateway;
    const previous = deferred(),
      current = deferred();
    let previousSignal!: AbortSignal;
    const view = harness(
      a,
      (signal) => {
        previousSignal = signal;
        return previous.promise;
      },
      "overview",
    );
    await act(async () => {});
    view.switch(b, () => current.promise, "overview");
    expect(previousSignal.aborted).toBe(true);
    await act(async () => previous.resolve("late A"));
    expect(view.current().data).toBeUndefined();
    await act(async () => current.resolve("private B"));
    expect(view.current().data).toBe("private B");
    view.unmount();
    const next = harness(a, () => new Promise(() => {}), "overview");
    expect(next.renders[0].data).toBeUndefined();
  });

  it("times out a stalled request, ignores late data, and supports retry", async () => {
    vi.useFakeTimers();
    const pending = deferred();
    const load = vi
      .fn<Load>()
      .mockImplementationOnce(() => pending.promise)
      .mockResolvedValueOnce("retry result");
    const view = harness({} as PublisherGateway, load, "overview");
    await act(async () => {});
    const signal = load.mock.calls[0][0];
    await act(async () => vi.advanceTimersByTime(20_000));
    expect(signal.aborted).toBe(true);
    expect(view.current()).toMatchObject({ loading: false, refreshing: false });
    expect(view.current().error?.message).toBe("请求超时，请重试。");
    await act(async () => pending.resolve("too late"));
    expect(view.current().data).toBeUndefined();
    await act(async () => view.current().reload());
    expect(view.current()).toMatchObject({
      data: "retry result",
      error: undefined,
      loading: false,
    });
  });

  it("handles synchronous loader errors and clears the request timeout", async () => {
    vi.useFakeTimers();
    const view = harness({} as PublisherGateway, () => {
      throw new Error("sync failure");
    });
    await act(async () => {});
    expect(view.current().error?.message).toBe("sync failure");
    expect(view.current().loading).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts on unmount and never renders or caches a subsequent response", async () => {
    const gateway = {} as PublisherGateway;
    const pending = deferred();
    let signal!: AbortSignal;
    const view = harness(
      gateway,
      (value) => {
        signal = value;
        return pending.promise;
      },
      "overview",
    );
    await act(async () => {});
    view.unmount();
    const renderCount = view.renders.length;
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve("after unmount"));
    expect(view.renders).toHaveLength(renderCount);
    const next = harness(gateway, () => new Promise(() => {}), "overview");
    expect(next.renders[0].data).toBeUndefined();
  });
});

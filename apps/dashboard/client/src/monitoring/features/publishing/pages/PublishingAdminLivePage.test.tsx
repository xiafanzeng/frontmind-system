import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import PublishingAdminLivePage from "./PublishingAdminLivePage";

const queryState = vi.hoisted(() => ({
  pending: false,
  error: null as Error | null,
  disabledError: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock("../../../trpc", () => {
  const query = (data: unknown) => ({
    useQuery: (_input: unknown, options: { enabled: boolean }) => ({
      data: options.enabled && !queryState.pending ? data : undefined,
      isPending: !options.enabled || queryState.pending,
      error: options.enabled ? queryState.error : queryState.disabledError,
      refetch: queryState.refetch,
    }),
  });
  const mutation = { useMutation: () => ({ isPending: false }) };
  return {
    trpc: {
      useUtils: () => ({}),
      publisherAdmin: {
        runtime: query({ mode: "test", credentialStatus: "healthy" }),
        catalogRuns: query([]),
        capabilities: query([]),
        unknownItems: query([]),
        updateRuntime: mutation,
        emergencyStop: mutation,
        requestCatalogSync: mutation,
        setCapability: mutation,
        setLiveWhitelist: mutation,
        bindUnknown: mutation,
        authorizeResubmit: mutation,
      },
    },
  };
});

describe("publishing administrator page readiness", () => {
  beforeEach(() => {
    queryState.pending = false;
    queryState.error = null;
    queryState.disabledError = null;
  });

  it.each([
    ["integration", "运行门禁"],
    ["catalog", "同步记录"],
    ["capabilities", "媒体图文证据"],
    ["reconciliation", "等待人工对账"],
  ] as const)(
    "renders the loaded %s section without waiting on disabled queries",
    (section, heading) => {
      render(<PublishingAdminLivePage section={section} />);
      expect(
        screen.getByRole("heading", { name: heading }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    },
  );

  it("clears the loading notice when the active query finishes", () => {
    queryState.pending = true;
    const view = render(<PublishingAdminLivePage section="capabilities" />);
    expect(screen.getByRole("status")).toHaveTextContent(
      "正在读取媒体发布管理状态",
    );
    expect(
      screen.queryByRole("heading", { name: "媒体图文证据" }),
    ).not.toBeInTheDocument();

    queryState.pending = false;
    view.rerender(<PublishingAdminLivePage section="capabilities" />);
    expect(
      screen.getByRole("heading", { name: "媒体图文证据" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows active query failures while excluding errors from disabled sections", () => {
    queryState.disabledError = new Error("Inactive catalog query failed");
    const view = render(<PublishingAdminLivePage section="capabilities" />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    queryState.error = new Error("Active capabilities query failed");
    view.rerender(<PublishingAdminLivePage section="capabilities" />);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Active capabilities query failed",
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent(
      "Inactive catalog query failed",
    );
  });
});

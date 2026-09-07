import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import KnowledgeBillingResume from "./KnowledgeBillingResume";
vi.mock("@/lib/ai-billing-feedback", () => ({ showAiBillingAction: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
describe("explicit knowledge recharge continuation", () => {
  it("does not send automatically and links to the one account wallet", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "AI_BALANCE_INSUFFICIENT", message: "账户余额不足" },
          }),
          { status: 402 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <KnowledgeBillingResume buildId="build" turnId="turn" reason="balance" />,
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "前往账户充值" })).toHaveAttribute(
      "href",
      "/account",
    );
    fireEvent.click(screen.getByRole("button", { name: "已充值，继续原任务" }));
    await waitFor(() =>
      expect(screen.getByText("账户余额不足")).toBeInTheDocument(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("only checks costs and continues after an explicit click", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: "AI_COST_PENDING", message: "费用仍在核对" },
          }),
          { status: 503 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <KnowledgeBillingResume buildId="build" turnId="turn" reason="cost" />,
    );
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "核对费用并继续" }));
    await waitFor(() =>
      expect(screen.getByText("费用仍在核对")).toBeInTheDocument(),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

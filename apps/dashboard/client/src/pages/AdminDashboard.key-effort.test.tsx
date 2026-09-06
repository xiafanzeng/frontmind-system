import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutations = vi.hoisted(() => ({
  replace: vi.fn(),
  revoke: vi.fn(),
  bulkReplace: vi.fn(),
}));

vi.mock("@/lib/trpc", () => ({
  trpc: {
    admin: {
      apiKeyUsageAlerts: {
        replaceTargetCredential: {
          useMutation: () => ({
            mutateAsync: mutations.replace,
            isPending: false,
            reset: vi.fn(),
          }),
        },
        revokeTargetCredential: {
          useMutation: () => ({
            mutateAsync: mutations.revoke,
            isPending: false,
            reset: vi.fn(),
          }),
        },
        bulkReplaceTargetCredentials: {
          useMutation: () => ({
            mutateAsync: mutations.bulkReplace,
            isPending: false,
            reset: vi.fn(),
          }),
        },
      },
    },
  },
}));

import {
  AdminBulkApiKeyDialog,
  AdminOverviewApiKeyDialog,
  type KeyManagementRow,
} from "./AdminDashboard";

const customer: KeyManagementRow = {
  kind: "customer",
  userId: 42,
  displayName: "测试客户",
  username: "test-customer",
  configured: false,
  version: 0,
  typeLabel: "客户",
  scopeLabel: "测试范围",
  deliveryAdminId: 10,
  isActive: true,
  inherited: false,
  rolling30DayUsed: 0,
  keyPoolTotalUsed: null,
  keyHealth: "unconfigured",
  syncIssueCode: null,
  keyPoolStale: false,
  fetchedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mutations.replace.mockResolvedValue({ version: 8 });
  mutations.bulkReplace.mockResolvedValue({
    updatedCount: 1,
    unchangedCount: 0,
  });
});

describe("administrator Zhipu Key effort", () => {
  it.each(["customer", "delivery_admin", "engineer"] as const)(
    "defaults new %s Keys to Max and submits it explicitly",
    async (kind) => {
      const onSaved = vi.fn();
      render(
        <AdminOverviewApiKeyDialog
          target={{ ...customer, kind }}
          onOpenChange={vi.fn()}
          onSaved={onSaved}
        />,
      );

      expect(
        screen.getByRole("combobox", { name: "智谱思考强度" }),
      ).toHaveValue("max");
      expect(
        screen.getAllByRole("option").map((option) => option.textContent),
      ).toEqual(["High", "Max"]);
      fireEvent.change(screen.getByLabelText("智谱 API Key"), {
        target: { value: "test-key-not-a-real-secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: "验证并配置" }));
      expect(mutations.replace).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "确认验证并配置" }));

      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(mutations.replace).toHaveBeenCalledWith(
        expect.objectContaining({
          kind,
          userId: customer.userId,
          expectedVersion: 0,
          upstreamEffort: "max",
        }),
      );
      expect(mutations.replace.mock.calls[0][0]).not.toHaveProperty(
        "agentProfile",
      );
    },
  );

  it.each([
    ["high", "max"],
    ["max", "high"],
  ] as const)(
    "shows stored %s and submits changed %s",
    async (stored, selected) => {
      render(
        <AdminOverviewApiKeyDialog
          target={{
            ...customer,
            configured: true,
            version: 7,
            upstreamEffort: stored,
          }}
          onOpenChange={vi.fn()}
          onSaved={vi.fn()}
        />,
      );
      const select = screen.getByRole("combobox", { name: "智谱思考强度" });
      expect(select).toHaveValue(stored);
      fireEvent.change(select, { target: { value: selected } });
      fireEvent.change(screen.getByLabelText("新的智谱 API Key"), {
        target: { value: "test-key-not-a-real-secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: "验证并替换" }));
      fireEvent.click(screen.getByRole("button", { name: "确认验证并替换" }));
      await waitFor(() =>
        expect(mutations.replace).toHaveBeenCalledWith(
          expect.objectContaining({
            upstreamEffort: selected,
            expectedVersion: 7,
          }),
        ),
      );
    },
  );

  it("loads each target's stored effort and clears the previous Key draft", () => {
    const props = { onOpenChange: vi.fn(), onSaved: vi.fn() };
    const { rerender } = render(
      <AdminOverviewApiKeyDialog
        {...props}
        target={{ ...customer, upstreamEffort: "high" }}
      />,
    );
    fireEvent.change(screen.getByLabelText("智谱 API Key"), {
      target: { value: "test-key-not-a-real-secret" },
    });
    rerender(
      <AdminOverviewApiKeyDialog
        {...props}
        target={{ ...customer, userId: 43, upstreamEffort: "max" }}
      />,
    );
    expect(screen.getByRole("combobox", { name: "智谱思考强度" })).toHaveValue(
      "max",
    );
    expect(screen.getByLabelText("智谱 API Key")).toHaveValue("");
  });

  it.each(["high", "max"] as const)(
    "submits explicit %s for bulk assignment",
    async (selected) => {
      const onSaved = vi.fn();
      render(
        <AdminBulkApiKeyDialog
          open
          rows={[customer]}
          onOpenChange={vi.fn()}
          onSaved={onSaved}
        />,
      );
      const select = screen.getByRole("combobox", { name: "智谱思考强度" });
      expect(select).toHaveValue("max");
      fireEvent.change(select, { target: { value: selected } });
      fireEvent.change(screen.getByLabelText("智谱 Managed Agents API Key"), {
        target: { value: "test-key-not-a-real-secret" },
      });
      fireEvent.click(screen.getByRole("button", { name: "继续确认" }));
      expect(mutations.bulkReplace).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "确认并批量配置" }));
      await waitFor(() => expect(onSaved).toHaveBeenCalledOnce());
      expect(mutations.bulkReplace).toHaveBeenCalledWith(
        expect.objectContaining({
          upstreamEffort: selected,
          scope: { kind: "all" },
          targets: [
            { userId: customer.userId, expectedVersion: customer.version },
          ],
          applyMode: "unconfigured_only",
        }),
      );
      expect(mutations.bulkReplace.mock.calls[0][0]).not.toHaveProperty(
        "agentProfile",
      );
    },
  );
});

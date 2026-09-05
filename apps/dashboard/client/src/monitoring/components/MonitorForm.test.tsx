import { useCallback, useState } from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import MonitorForm from "./MonitorForm";
import type { MonitorInput, ProjectSummary, ProviderModel } from "../domain";
import type { QuoteRunCost, RunCostQuoteView } from "../runBilling";

const project: ProjectSummary = {
  id: "project",
  name: "验收项目",
  brandName: "SiliconFlow",
  brandAliases: [],
  competitors: [],
  timezone: "Asia/Shanghai",
};
const model: ProviderModel = {
  id: "deepseek",
  code: "deepseek",
  name: "DeepSeek",
  clientType: "web",
  enabled: true,
  verified: true,
  capabilities: {
    reasoning: true,
    screenshot: true,
    region: true,
    overseas: true,
  },
};
const initial: MonitorInput = {
  name: "单次验收",
  questions: ["介绍 SiliconFlow"],
  competitors: [],
  platforms: [
    {
      platformId: model.id,
      providerCode: model.code,
      clientType: "web",
      mode: "search",
      screenshot: 0,
      regionCode: null,
    },
  ],
  repetitions: 1,
  schedule: { type: "none", timezone: "Asia/Shanghai" },
};
afterEach(cleanup);
const submitButton = () =>
  screen.getByRole("button", { name: "保存并立即执行" });

it("finishes one quote when mutation updates rerender the parent with equal model data", async () => {
  const requested = vi.fn();
  function StatefulWorkspace() {
    const [, setMutationState] = useState(0);
    const quote = useCallback<QuoteRunCost>((input) => {
      requested(input);
      setMutationState((value) => value + 1);
      // Bound a regression's request loop so a failing test cannot starve the runner.
      if (requested.mock.calls.length > 3) return new Promise(() => {});
      return Promise.resolve({ totalAmountTenThousandths: "900" });
    }, []);
    return (
      <MonitorForm
        project={{ ...project }}
        models={[{ ...model }]}
        initial={initial}
        availableBalanceTenThousandths="900"
        quoteRunCost={quote}
        onCancel={() => {}}
        onSubmit={() => {}}
      />
    );
  }
  render(<StatefulWorkspace />);
  await waitFor(() => expect(submitButton()).toBeEnabled());
  expect(requested).toHaveBeenCalledTimes(1);
  expect(requested).toHaveBeenCalledWith({
    items: [
      {
        platformId: model.id,
        mode: "search",
        screenshot: 0,
        regionCode: null,
        quantity: 1,
      },
    ],
  });
});

it("discards an old quote after inputs change and responds to balance changes without re-quoting", async () => {
  const completions: Array<(value: RunCostQuoteView) => void> = [];
  const quote = vi.fn<QuoteRunCost>(
    () => new Promise((resolve) => completions.push(resolve)),
  );
  const form = (balance: string) => (
    <MonitorForm
      project={project}
      models={[{ ...model }]}
      initial={initial}
      availableBalanceTenThousandths={balance}
      quoteRunCost={quote}
      onCancel={() => {}}
      onSubmit={() => {}}
    />
  );
  const view = render(form("900"));
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(1));
  fireEvent.change(screen.getByLabelText("重复次数"), {
    target: { value: "2" },
  });
  await waitFor(() => expect(quote).toHaveBeenCalledTimes(2));
  await act(async () => completions[0]({ totalAmountTenThousandths: "900" }));
  expect(submitButton()).toBeDisabled();
  await act(async () => completions[1]({ totalAmountTenThousandths: "1800" }));
  expect(submitButton()).toBeDisabled();
  expect(screen.getByText(/余额不足，还差 ¥0.09/)).toBeInTheDocument();
  view.rerender(form("1800"));
  await waitFor(() => expect(submitButton()).toBeEnabled());
  expect(quote).toHaveBeenCalledTimes(2);
  expect(quote.mock.calls[1][0].items[0].quantity).toBe(2);
});

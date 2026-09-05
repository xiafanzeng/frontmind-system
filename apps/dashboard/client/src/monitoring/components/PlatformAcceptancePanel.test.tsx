import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { observable } from "@trpc/server/observable";
import { TRPCClientError } from "@trpc/client";
import { trpc } from "../trpc";
import PlatformAcceptancePanel from "./PlatformAcceptancePanel";

const projectId = "22222222-2222-5222-8222-222222222222";
const platformId = "33333333-3333-5333-8333-333333333333";
const checks = [
  "search_default",
  "reasoning_search",
  "screenshot_mention",
  "screenshot_all",
  "region_default",
  "region_domestic",
  "region_overseas",
].map((dimension, index) => ({
  platformId,
  providerCode: "deepseek",
  displayName: "DeepSeek",
  clientType: "web",
  platformFingerprint: "b".repeat(64),
  dimension,
  mode: index === 1 ? "reasoning_search" : "search",
  screenshot: index === 2 ? 2 : index === 3 ? 1 : 0,
  regionCode: index === 5 ? "310000" : index === 6 ? "224" : null,
  unitAmountTenThousandths: [1, 2, 3].includes(index) ? "1800" : "900",
}));
const quote = {
  planFingerprint: "a".repeat(64),
  currency: "CNY",
  scale: 4,
  attemptCount: 7,
  totalAmountTenThousandths: "9000",
  checks,
};
const queries: QueryClient[] = [];
afterEach(() => {
  cleanup();
  queries.splice(0).forEach((client) => client.clear());
});
function setup() {
  const calls = vi.fn();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queries.push(queryClient);
  const client = trpc.createClient({
    links: [
      () =>
        ({ op }) =>
          observable((observer) => {
            calls(op.path, op.input);
            if (op.path === "admin.platforms.acceptance.start") {
              observer.error(
                new TRPCClientError("请求超时，请使用同一计划重试"),
              );
              return;
            }
            const data: Record<string, unknown> = {
              "auth.me": {
                user: { id: "11111111-1111-5111-8111-111111111111" },
              },
              "projects.list": [{ id: projectId, name: "公开验收项目" }],
              "admin.platforms.list": [
                { id: platformId, displayName: "DeepSeek", clientType: "web" },
              ],
              "regions.list": [],
              "admin.platforms.acceptance.list": [],
              "admin.platforms.acceptance.plan": quote,
            };
            observer.next({ result: { data: data[op.path] } });
            observer.complete();
          }),
    ],
  });
  render(
    <QueryClientProvider client={queryClient}>
      <trpc.Provider client={client} queryClient={queryClient}>
        <PlatformAcceptancePanel />
      </trpc.Provider>
    </QueryClientProvider>,
  );
  return calls;
}
async function prepare() {
  await screen.findByRole("option", { name: "公开验收项目" });
  fireEvent.change(screen.getByLabelText("验收项目"), {
    target: { value: projectId },
  });
  fireEvent.change(screen.getByLabelText("验收问题"), {
    target: { value: "介绍公开品牌" },
  });
  fireEvent.click(screen.getByLabelText("DeepSeek · 网页"));
  fireEvent.click(screen.getByRole("button", { name: "生成验收报价" }));
  await screen.findByText("本次完整计划：7 次，共 ¥0.90");
}
it("shows the complete seven-check exact quote without dispatch and requires explicit confirmation", async () => {
  const calls = setup();
  await prepare();
  for (const label of [
    "默认搜索",
    "深度思考",
    "提及时截图",
    "全量截图",
    "默认地域",
    "国内地域",
    "海外地域",
  ])
    expect(screen.getByRole("cell", { name: label })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "确认并启动验收" })).toBeDisabled();
  expect(
    calls.mock.calls.filter(
      ([path]) => path === "admin.platforms.acceptance.start",
    ),
  ).toHaveLength(0);
});
it("invalidates both the quote and confirmation when the question changes", async () => {
  setup();
  await prepare();
  fireEvent.click(screen.getByLabelText("我确认执行 7 次，最高 ¥0.90"));
  fireEvent.change(screen.getByLabelText("验收问题"), {
    target: { value: "新的公开问题" },
  });
  expect(
    screen.queryByRole("button", { name: "确认并启动验收" }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "生成验收报价" }));
  expect(
    await screen.findByRole("button", { name: "确认并启动验收" }),
  ).toBeDisabled();
});
it("retries an uncertain start using the identical frozen input, price and deterministic key", async () => {
  const calls = setup();
  await prepare();
  fireEvent.click(screen.getByLabelText("我确认执行 7 次，最高 ¥0.90"));
  fireEvent.click(screen.getByRole("button", { name: "确认并启动验收" }));
  await screen.findByRole("alert");
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "确认并启动验收" }),
    ).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "确认并启动验收" }));
  await waitFor(() =>
    expect(
      calls.mock.calls.filter(
        ([path]) => path === "admin.platforms.acceptance.start",
      ),
    ).toHaveLength(2),
  );
  const [first, second] = calls.mock.calls
    .filter(([path]) => path === "admin.platforms.acceptance.start")
    .map(([, input]) => input);
  expect(first).toEqual(second);
  expect(first).toMatchObject({
    ownerId: "11111111-1111-5111-8111-111111111111",
    projectId,
    platformIds: [platformId],
    question: "介绍公开品牌",
    confirmedTotalAmountTenThousandths: "9000",
    planFingerprint: quote.planFingerprint,
    idempotencyKey: `platform-acceptance:${quote.planFingerprint}`,
  });
});

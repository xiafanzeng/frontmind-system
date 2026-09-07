import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { chromium } from "playwright";

const appRoot = fileURLToPath(new URL("../", import.meta.url));
const output =
  process.env.FRONTMIND_MONITORING_UI_OUTPUT ||
  "/tmp/frontmind-local-ui/monitoring";
const origin =
  process.env.FRONTMIND_MONITORING_UI_ORIGIN || "http://127.0.0.1:4173";
assert(
  ["127.0.0.1", "localhost"].includes(new URL(origin).hostname),
  "Use a local demo server only",
);
const source = await readFile(
  resolve(appRoot, "client/src/monitoring/MonitoringDemo.tsx"),
  "utf8",
);
assert(
  !/\bfetch\s*\(|\btrpc\b|\/api\//.test(source),
  "Demo must not call APIs",
);
assert(source.includes("serverData={false}"));
await mkdir(output, { recursive: true });
for (const oldName of ["S13-local-save.png", "S14-local-run-confirmation.png"])
  await rm(resolve(output, oldName), { force: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 2048, height: 1100 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
const apiRequests = [];
const externalRequests = [];
const errors = [];
const states = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.pathname.startsWith("/api/")) {
    apiRequests.push(url.pathname);
    await route.abort();
    return;
  }
  if (
    ["http:", "https:"].includes(url.protocol) &&
    url.origin !== new URL(origin).origin
  ) {
    externalRequests.push(url.origin);
    await route.abort();
    return;
  }
  await route.continue();
});
async function shot(id, note) {
  await page.waitForTimeout(180);
  await page.screenshot({ path: resolve(output, `${id}.png`) });
  states.push({ id, note });
}
async function tab(name) {
  await page.getByRole("tab", { name, exact: true }).click();
}
try {
  await page.goto(`${origin}/monitoring`, { waitUntil: "networkidle" });
  await page.getByText("本地演示", { exact: true }).waitFor();
  await shot("S0-default", "2048×1100 desktop; synthetic overview");
  await page
    .getByRole("article", { name: "环保材料与选购意图监控任务" })
    .locator("button")
    .first()
    .click();
  await shot("S1-second-monitor", "Independent monitor selection");
  await page
    .getByRole("article", { name: "客厅家居品牌认知监控任务" })
    .locator("button")
    .first()
    .click();
  await page
    .getByLabel("按问题筛选回答", { exact: true })
    .selectOption({ label: "云杉家居的设计和材料有哪些特点？" });
  await shot("S2-question-filter", "Native select; project-owned questions");
  await page.getByLabel("按问题筛选回答", { exact: true }).selectOption("");
  for (const [label, queryKey] of [
    ["品牌主体", "subject"],
    ["按问题筛选回答", "question"],
    ["按模型筛选回答", "model"],
  ]) {
    const select = page.getByLabel(label, { exact: true });
    const options = await select
      .locator("option")
      .evaluateAll((nodes) =>
        nodes.map((node) => ({ value: node.value, label: node.textContent })),
      );
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      await select.selectOption(option.value);
      assert.equal(await select.inputValue(), option.value);
      assert.equal(
        new URL(page.url()).searchParams.get(queryKey),
        option.value,
      );
      await shot(
        `S2-${queryKey}-${index}`,
        `Verified filter option: ${option.label}`,
      );
    }
    await select.selectOption(options[0].value);
  }
  const dates = page.getByLabel("选择日期范围");
  for (const range of ["7d", "30d", "90d", "custom"]) {
    await dates.selectOption(range);
    assert.equal(await dates.inputValue(), range);
    assert.equal(new URL(page.url()).searchParams.get("range"), range);
    await shot(`S2-date-${range}`, `Date filter ${range}`);
  }
  const customFrom = new Date(Date.now() - 5 * 86400000)
    .toISOString()
    .slice(0, 10);
  const customTo = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await page.getByLabel("开始日期", { exact: true }).fill(customFrom);
  await page.getByLabel("结束日期（不含）").fill(customTo);
  assert.equal(new URL(page.url()).searchParams.get("from"), customFrom);
  assert.equal(new URL(page.url()).searchParams.get("to"), customTo);
  await shot("S2-custom-calendar", "Both custom calendar boundaries verified");
  await dates.selectOption("7d");
  await page.getByRole("button", { name: "暂停计划", exact: true }).click();
  await page.getByRole("button", { name: "恢复计划", exact: true }).waitFor();
  await shot("Extra-monitor-paused", "Monitor plan paused locally");
  await page.getByRole("button", { name: "恢复计划", exact: true }).click();
  for (const name of [
    "指标看板",
    "问答明细",
    "指标明细",
    "趋势分析",
    "竞品排名",
    "引用分析",
    "信源分布",
    "商品统计",
    "视频统计",
  ]) {
    await tab(name);
    await shot(
      `S3-${name}`,
      "Existing analysis retained; media cards explicitly synthetic",
    );
  }
  await tab("问答明细");
  await page
    .getByRole("button", { name: "下一个监控问题", exact: true })
    .click();
  await shot("S4-next-question", "Next synthetic question");
  await page
    .getByRole("button", { name: "下一条回答内容", exact: true })
    .click();
  await shot("S4-next-answer", "Next captured answer");
  await page
    .getByRole("button", { name: "追踪引用 · 演示", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: "已追踪 1", exact: true }).click();
  await shot("S5-tracked", "Tracking state is local only");
  await page.getByRole("button", { name: "未追踪 1", exact: true }).click();
  await shot("S5-untracked", "Untracked local sources");
  await page.getByRole("button", { name: "全部 2", exact: true }).click();
  await page.getByRole("button", { name: "全屏查看", exact: true }).click();
  await shot(
    "S6-fullscreen",
    "Answer and sources retain independent scrolling",
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "全屏查看", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.getByRole("button", { name: "截图", exact: true }).click();
  await shot(
    "S6-local-snapshot",
    "HTML answer snapshot explicitly marked synthetic; no image provider request",
  );
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "复制", exact: true }).click();
  assert(
    (await page.evaluate(() => navigator.clipboard.readText())).includes(
      "合成演示",
    ),
  );
  await page.getByRole("button", { name: "纠正", exact: true }).click();
  await page.getByLabel("纠正后的提及位置").fill("4");
  await shot(
    "S6-local-correction",
    "Local correction; real backend remains unchanged",
  );
  await page.getByRole("button", { name: "保存演示纠正", exact: true }).click();
  await page.getByRole("button", { name: "批量添加问题", exact: true }).click();
  await shot("S7-modal-default", "Shared monitor form, 47/53 desktop columns");
  const dialog = page.getByRole("dialog", {
    name: "批量添加问题",
    exact: true,
  });
  assert.equal(
    await dialog
      .getByRole("button", { name: "保存并立即执行", exact: true })
      .isEnabled(),
    false,
  );
  await dialog.getByRole("button", { name: "保存监控", exact: true }).click();
  await dialog.getByText("请填写监控名称。", { exact: true }).waitFor();
  assert.equal(await page.locator(".fm-monitor-card").count(), 2);
  await shot(
    "S13-required-empty-name",
    "Empty form save shows required-name error; no local monitor created",
  );
  await dialog.getByPlaceholder("例如：核心品牌问题监控").fill("本地验收监控");
  await dialog.getByRole("button", { name: "保存监控", exact: true }).click();
  await dialog.getByText("请至少添加一个监控问题。", { exact: true }).waitFor();
  await shot(
    "S13-required-missing-question",
    "Name alone cannot save; required-question error is visible",
  );
  await dialog.getByRole("button", { name: "选择演示监控品牌" }).click();
  const brandDialog = page.getByRole("dialog", { name: "选择监控品牌 · 演示" });
  await brandDialog.getByLabel("选择合成品牌").selectOption("拾木家居");
  await brandDialog.getByLabel("演示品牌别名").fill("拾木,拾木生活");
  assert.equal(
    await brandDialog.getByLabel("演示品牌名称").inputValue(),
    "拾木家居",
  );
  await shot(
    "S8-brand-dialog",
    "Nested local brand picker and aliases; draft does not change enterprise project",
  );
  await brandDialog
    .getByRole("button", { name: "确定演示品牌", exact: true })
    .click();
  assert.equal(await page.getByRole("dialog").count(), 1);
  assert(
    (
      await dialog.getByRole("button", { name: "选择演示监控品牌" }).innerText()
    ).includes("拾木家居"),
  );
  await shot(
    "S8-brand-selected",
    "Synthetic brand selection displayed in the draft",
  );
  await dialog.getByLabel("演示核心词 1", { exact: true }).fill("实木家具");
  await dialog.getByRole("button", { name: "添加演示核心词" }).click();
  await dialog.getByLabel("演示核心词 2", { exact: true }).fill("小户型");
  await dialog.getByRole("switch", { name: "启用演示核心词 1" }).click();
  assert.equal(
    await dialog.getByLabel("演示核心词 1", { exact: true }).isEnabled(),
    false,
  );
  await shot(
    "S9-keyword-disabled",
    "Added keyword draft; first keyword switch disabled its input",
  );
  await dialog.getByRole("switch", { name: "启用演示核心词 1" }).click();
  assert.equal(
    await dialog.getByLabel("演示核心词 1", { exact: true }).isEnabled(),
    true,
  );
  await dialog.getByRole("button", { name: "删除演示核心词 2" }).click();
  assert.equal(
    await dialog.getByLabel("演示核心词 2", { exact: true }).count(),
    0,
  );
  await shot(
    "S9-keyword-removed",
    "Keyword delete and re-enable verified; no effect on attempts",
  );
  await dialog
    .getByLabel("新增监控问题")
    .fill("如何选择适合小户型的家具？\n怎样判断实木家具的材料质量？");
  await dialog.getByRole("button", { name: "添加问题", exact: true }).click();
  await shot(
    "S9-two-questions",
    "Two synthetic questions; no recommended questions",
  );
  await dialog.getByRole("button", { name: "全部模型", exact: true }).click();
  await shot("S10-all-models", "Twelve synthetic model endpoints");
  const thinking = dialog.getByRole("button", {
    name: /批量(开启|关闭)深度思考/,
  });
  if ((await thinking.getAttribute("aria-pressed")) === "false")
    await thinking.click();
  await thinking.click();
  await dialog.getByRole("button", { name: "提及品牌时", exact: true }).click();
  await shot(
    "S11-thinking-off-mentioned-screenshot",
    "Reasoning and screenshot configuration reflected locally",
  );
  const schedule = dialog.getByRole("group", { name: "自动监控状态" });
  await schedule.getByRole("button", { name: "暂停", exact: true }).click();
  assert.equal(await dialog.getByLabel("执行频率").isEnabled(), false);
  assert.equal(
    await schedule
      .getByRole("button", { name: "暂停", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await shot(
    "S12-schedule-paused",
    "Paused schedule disables frequency without running a task",
  );
  await schedule.getByRole("button", { name: "开启", exact: true }).click();
  assert.equal(await dialog.getByLabel("执行频率").isEnabled(), true);
  await dialog.getByLabel("执行频率").selectOption("daily");
  assert.equal(await dialog.getByLabel("执行频率").inputValue(), "daily");
  await shot("S12-schedule-daily", "Enabled daily frequency selected");
  await dialog.getByLabel("执行频率").selectOption("weekly");
  assert.equal(await dialog.getByLabel("执行频率").inputValue(), "weekly");
  await dialog.getByLabel("执行时间").fill("11:30");
  await shot("S12-time-settings", "Weekly cadence and explicit timezone");
  const saveAndRun = dialog.getByRole("button", {
    name: "保存并立即执行",
    exact: true,
  });
  await saveAndRun.click({ trial: true });
  assert.equal(await saveAndRun.isEnabled(), true);
  assert.equal(
    await dialog
      .getByRole("button", { name: "保存监控", exact: true })
      .isEnabled(),
    true,
  );
  await shot(
    "S14-valid-form-enabled",
    "Required fields and eligible estimate enable save-and-run; trial click does not submit",
  );
  await dialog.getByRole("button", { name: "保存监控", exact: true }).click();
  await page.getByRole("article", { name: "本地验收监控监控任务" }).waitFor();
  await shot(
    "Extra-local-save",
    "Local save verified; source site submit intentionally not observed",
  );
  await page.getByRole("button", { name: "立即运行", exact: true }).click();
  const confirm = page.getByRole("dialog", { name: "确认立即执行" });
  await confirm.getByText(/本次只模拟运行/).waitFor();
  await shot(
    "Extra-local-run-confirmation",
    "Local run confirmation; source brand-create/submit intentionally not observed",
  );
  await confirm.getByRole("button", { name: "确认执行", exact: true }).click();
  await page.getByText(/模拟运行完成：/).waitFor();
  await page.getByRole("button", { name: "批量添加问题", exact: true }).click();
  await page
    .getByRole("dialog", { name: "批量添加问题" })
    .getByRole("button", { name: "取消", exact: true })
    .click();
  await shot("S15-cancel-closed", "Cancel returns to local workspace");
  assert.deepEqual(apiRequests, [], "Demo made API requests");
  assert.deepEqual(externalRequests, [], "Demo requested external resources");
  assert.deepEqual(errors, [], "Browser runtime errors");
  const report = {
    viewport: { width: 2048, height: 1100 },
    passed: true,
    states,
    apiRequests,
    externalRequests,
    errors,
    sourceLimitations: [
      "S13 proves local required-field errors and S14 proves local eligible-button state; source-site submit/brand-create outcomes were not observed.",
      "The nested brand picker and keyword add/delete/toggle are isolated local form drafts; they do not change enterprise ownership, run configuration or monitoring statistics.",
      "Native selects and nine preserved analysis tabs adapt the reference; not every reference control or transition is claimed complete.",
      "No pixel-identical claim; screenshots cover desktop local states.",
    ],
  };
  await writeFile(
    resolve(output, "report.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify({
      passed: true,
      states: states.length,
      output,
      apiRequests: 0,
      externalRequests: 0,
    }),
  );
} finally {
  await context.close();
  await browser.close();
}

/** Uses synthetic inputs on a local app only. Screenshots stay outside the repository. */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
const origin = process.env.OPERATOR_UI_ORIGIN || "http://127.0.0.1:4173";
assert.ok(["localhost", "127.0.0.1"].includes(new URL(origin).hostname));
const output =
  process.env.OPERATOR_UI_OUTPUT || "/tmp/frontmind-operator-portal-ui";
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 2048, height: 1200 },
  deviceScaleFactor: 1,
});
const errors = [],
  calls = [],
  states = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (
    /^https?:$/.test(url.protocol) &&
    (url.origin !== new URL(origin).origin || url.pathname.startsWith("/api/"))
  ) {
    calls.push(`${route.request().method()} ${url.origin}${url.pathname}`);
    await route.abort();
    return;
  }
  await route.continue();
});
const button = (name) => page.getByRole("button", { name, exact: true });
const field = (name) => page.getByLabel(name, { exact: true });
const tab = (name) => page.getByRole("tab", { name, exact: true });
const capture = async (name) => {
  await page.screenshot({ path: path.join(output, `${name}.png`) });
  states.push({
    name,
    styles: await page.locator(".knowledge-frontend").evaluate((el) => {
      const props = [
        "backgroundColor",
        "color",
        "fontFamily",
        "fontSize",
        "lineHeight",
        "width",
        "height",
        "padding",
        "borderRadius",
        "borderColor",
        "boxShadow",
      ];
      return [
        ".kf-sidebar",
        ".kf-main",
        ".kf-tabs",
        ".kf-scroll",
        ".kf-savebar",
        ".kf-primary",
      ].map((selector) => {
        const target = el.querySelector(selector);
        if (!target) return { selector, visible: false };
        const css = getComputedStyle(target);
        return {
          selector,
          ...Object.fromEntries(props.map((prop) => [prop, css[prop]])),
        };
      });
    }),
  });
};
try {
  await page.goto(`${origin}/knowledge-frontend-demo`);
  await button("保存草稿").waitFor();
  await capture("H0-info");
  for (const [i, name] of [
    "SEO配置",
    "自定义域名",
    "多语言配置",
    "嵌入代码",
    "文章",
    "栏目",
    "搜索",
    "通知",
  ].entries()) {
    await tab(name).click();
    assert.equal(await tab(name).getAttribute("aria-selected"), "true");
    await capture(`H${i + 1}-${name}`);
  }
  await tab("站点信息").click();
  await field("站点语言").selectOption("英文-EN");
  await page
    .getByRole("radio", { name: "Markdown编辑器", exact: true })
    .check();
  await page.getByRole("radio", { name: "仅深色", exact: true }).check();
  await page.getByRole("button", { name: /GuideMe 模板示意/ }).click();
  await field("站点名称").fill("本地测试知识中心");
  await capture("H12-selected");
  await button("导航栏").click();
  await button("新增菜单").click();
  await field("菜单3名称").fill("联系品牌");
  await button("上移菜单3").click();
  assert.equal(await field("菜单2名称").inputValue(), "联系品牌");
  await capture("H9-navigation");
  await button("主页").click();
  await field("主页标语").fill("让知识触达每一个读者");
  await page.locator("summary").filter({ hasText: "快速入门" }).click();
  await page.getByRole("switch", { name: "开启快速入门", exact: true }).click();
  await capture("H10-home");
  await button("页脚").click();
  assert.equal(await field("页脚标语").isDisabled(), true);
  await capture("H11-footer-disabled");
  await page.getByRole("switch", { name: "启用页脚", exact: true }).click();
  await field("页脚标语").fill("本地预览页脚");
  await capture("H11-footer-enabled");
  await button("保存草稿").click();
  await page
    .getByRole("status")
    .filter({ hasText: "当前项目的本地草稿已保存" })
    .waitFor();
  await page.reload();
  assert.equal(await field("站点名称").inputValue(), "本地测试知识中心");
  await field("站点名称").fill("");
  await button("保存草稿").click();
  await page.getByRole("alert").waitFor();
  await capture("H13-validation");
  await button("还原草稿").click();
  await button("预览站点").click();
  await page.getByRole("dialog").waitFor();
  await capture("H14-preview");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  assert.equal(await field("站点名称").inputValue(), "本地测试知识中心");
  await button("AI友好官网").click();
  for (const name of ["模板配置", "文章管理", "域名与部署", "现有工作流"]) {
    await button(name).click();
    assert.equal(await button(name).getAttribute("aria-pressed"), "true");
    await capture(`H15-website-${name}`);
  }
  await button("站点设置").click();
  await button("保存草稿").hover();
  await capture("H16-hover");
  await page.mouse.down();
  await capture("H16-pressed");
  await page.mouse.up();
  await tab("站点信息").focus();
  await page.keyboard.press("ArrowRight");
  assert.equal(await tab("SEO配置").getAttribute("aria-selected"), "true");
  assert.deepEqual(calls, [], "No API or remote assets");
  assert.deepEqual(errors, [], "No runtime errors");
  await fs.writeFile(
    path.join(output, "states.json"),
    JSON.stringify(
      { viewport: { width: 2048, height: 1200 }, states, errors, calls },
      null,
      2,
    ),
  );
  console.log(
    `Portal UI: ${states.length} states captured; interactions passed; zero API requests/errors. ${output}`,
  );
} finally {
  await browser.close();
}

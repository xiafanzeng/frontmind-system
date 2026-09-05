import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import CitationDataWorkbench, {
  type ContentCitationRow,
  type MediaCitationRow,
  type QuestionCitationRow,
} from "./CitationDataWorkbench";

const questionRows: QuestionCitationRow[] = Array.from(
  { length: 26 },
  (_, index) => [
    index % 2 ? "doubao" : "baiduai",
    index % 2 ? "产品体验怎么样？" : "品牌是否值得推荐？",
    `引用文章 ${String(index + 1).padStart(2, "0")}`,
    `https://example.com/article-${index + 1}`,
    index % 2 ? "行业媒体" : "品牌观察",
    "2026-07-20",
  ],
);

const contentRows: ContentCitationRow[] = [
  [
    "净水器品牌选择指南",
    "品牌观察",
    "example.com",
    "https://example.com/guide",
    16,
    "16.00%",
  ],
  [
    "产品参数解读",
    "行业媒体",
    "industry.example",
    "https://industry.example/product",
    8,
    "8.00%",
  ],
];

const mediaRows: MediaCitationRow[] = [
  ["example.com", "品牌观察", 16, "16.00%"],
  ["industry.example", "行业媒体", 8, "8.00%"],
];

function renderWorkbench() {
  return render(
    <CitationDataWorkbench
      questionRows={questionRows}
      contentRows={contentRows}
      mediaRows={mediaRows}
    />,
  );
}

describe("CitationDataWorkbench", () => {
  it("shows complete dataset counts and paginates question citation records", () => {
    renderWorkbench();

    expect(screen.getByRole("tab", { name: "问题引用 26 条" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByText("第 1 / 2 页")).toBeTruthy();
    expect(screen.getByText("引用文章 01")).toBeTruthy();
    expect(screen.queryByText("引用文章 26")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "下一页" }));

    expect(screen.getByText("引用文章 26")).toBeTruthy();
    expect(screen.getByText("第 2 / 2 页")).toBeTruthy();
  });

  it("switches datasets and supports search and field filters", () => {
    renderWorkbench();

    fireEvent.click(screen.getByRole("tab", { name: "内容引用 2 条" }));
    expect(
      screen.getByPlaceholderText("搜索内容标题、媒体、域名或链接"),
    ).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText("搜索内容标题、媒体、域名或链接"),
      {
        target: { value: "参数" },
      },
    );
    expect(screen.getByText("产品参数解读")).toBeTruthy();
    expect(screen.queryByText("净水器品牌选择指南")).toBeNull();
    expect(screen.getByText("筛选出 1 条")).toBeTruthy();

    fireEvent.change(
      screen.getByPlaceholderText("搜索内容标题、媒体、域名或链接"),
      {
        target: { value: "" },
      },
    );
    fireEvent.change(screen.getByRole("combobox", { name: "全部媒体" }), {
      target: { value: "品牌观察" },
    });
    expect(screen.getByText("净水器品牌选择指南")).toBeTruthy();
    expect(screen.queryByText("产品参数解读")).toBeNull();
  });

  it("sorts numeric columns and exposes article links", () => {
    renderWorkbench();
    fireEvent.click(screen.getByRole("tab", { name: "内容引用 2 条" }));

    const table = screen.getByRole("table");
    const bodyRows = within(table).getAllByRole("row").slice(1);
    expect(within(bodyRows[0]).getByText("净水器品牌选择指南")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: /引用次数/,
      }),
    );

    const sortedRows = within(table).getAllByRole("row").slice(1);
    expect(within(sortedRows[0]).getByText("产品参数解读")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "净水器品牌选择指南" }),
    ).toHaveAttribute("href", "https://example.com/guide");
    expect(screen.queryByRole("columnheader", { name: "原文" })).toBeNull();
    expect(screen.queryByRole("link", { name: "打开" })).toBeNull();
  });
});

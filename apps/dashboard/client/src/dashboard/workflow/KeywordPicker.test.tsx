import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { KeywordPicker, keywordPickerRows } from "./KeywordPicker";

const tables = [
  {
    id: "table-source",
    title: "品牌词库",
    columns: ["序号", "问题", "主分类"],
    rows: Array.from({ length: 23 }, (_, i) => [
      i + 1,
      `品牌选择问题 ${i + 1}`,
      "产品场景词",
    ]),
  },
];
describe("inline keyword resource picker", () => {
  it("retains original source indices when searching and paginating", () => {
    const select = vi.fn();
    render(<KeywordPicker tables={tables} revision={9} onSelect={select} />);
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    fireEvent.click(screen.getByRole("button", { name: /品牌选择问题 11/ }));
    expect(select).toHaveBeenLastCalledWith(
      expect.objectContaining({
        dashboardRevision: 9,
        tableId: "table-source",
        rowIndex: 10,
        question: "品牌选择问题 11",
      }),
    );
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "23" },
    });
    fireEvent.click(screen.getByRole("button", { name: /品牌选择问题 23/ }));
    expect(select).toHaveBeenLastCalledWith(
      expect.objectContaining({ rowIndex: 22 }),
    );
  });
  it("does not invent a category or selectable row from an invalid source", () => {
    expect(
      keywordPickerRows(
        [{ ...tables[0]!, rows: [[1, "不可靠的问题", "未知类别"]] }],
        9,
      ),
    ).toEqual([]);
    expect(
      keywordPickerRows([{ ...tables[0]!, columns: ["不含问题列"] }], 9),
    ).toEqual([]);
  });
});

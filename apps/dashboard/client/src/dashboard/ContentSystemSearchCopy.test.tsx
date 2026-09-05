import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PreviewUserBrandDashboard } from "./UserBrandDashboard";
import { userPreviewFixtures } from "@/lib/development-preview-fixtures";

function UserBrandDashboard({
  preview: _preview,
  ...props
}: {
  preview?: boolean;
  [key: string]: unknown;
}) {
  return (
    <PreviewUserBrandDashboard {...props} fixtures={userPreviewFixtures} />
  );
}

describe("内容制作体系入口", () => {
  it("is no longer exposed in the customer dashboard", () => {
    render(<UserBrandDashboard preview />);

    expect(
      screen.queryByRole("button", { name: "内容制作体系" }),
    ).toBeNull();
    expect(screen.queryByPlaceholderText("搜索内容条目...")).toBeNull();
    expect(screen.queryByPlaceholderText("搜索知识库条目...")).toBeNull();
  });
});

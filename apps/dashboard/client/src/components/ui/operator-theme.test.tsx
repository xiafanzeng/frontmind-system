import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperatorThemeProvider } from "./operator-theme";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./dropdown-menu";

function Example({ operator }: { operator: boolean }) {
  return <OperatorThemeProvider enabled={operator}><div data-testid="workspace">
    <Dialog defaultOpen><DialogContent><DialogTitle>编辑项目</DialogTitle><DialogDescription>项目内容</DialogDescription>
      <DropdownMenu><DropdownMenuTrigger>更多操作</DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem>选项一</DropdownMenuItem></DropdownMenuContent></DropdownMenu>
    </DialogContent></Dialog>
  </div></OperatorThemeProvider>;
}

describe("operator portal presentation", () => {
  it("carries scoped tokens to body portals including a popup inside a dialog", async () => {
    render(<Example operator />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveClass("operator-theme", "operator-portal");
    expect(screen.getByTestId("workspace")).not.toContainElement(dialog);
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass("operator-theme");
    fireEvent.keyDown(screen.getByRole("button", { name: "更多操作" }), { key: "Enter" });
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveClass("operator-theme", "operator-portal");
    expect(dialog).not.toContainElement(menu);
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("leaves other roles' portal presentation unchanged", () => {
    render(<Example operator={false} />);
    expect(screen.getByRole("dialog")).not.toHaveClass("operator-theme");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).not.toHaveClass("operator-theme");
  });
});

import { describe, expect, it } from "vitest";

import { userFacingErrorMessage } from "./user-facing-error";

describe("userFacingErrorMessage", () => {
  it("keeps Chinese messages and translates login errors", () => {
    expect(userFacingErrorMessage("账号已停用")).toBe("账号已停用");
    expect(userFacingErrorMessage("Invalid username or password")).toBe(
      "用户名或密码不正确",
    );
  });

  it("does not expose unknown English backend details", () => {
    const error = Object.assign(new Error("database driver exploded"), {
      status: 503,
    });
    expect(userFacingErrorMessage(error)).toBe("服务暂时不可用，请稍后重试");
  });
});

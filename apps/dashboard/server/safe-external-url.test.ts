import { describe, expect, it } from "vitest";
import {
  assertSafeExternalUrl,
  ExternalUrlRejectedError,
  isBlockedNetworkAddress,
} from "./_core/safe-external-url";

describe("external URL SSRF boundary", () => {
  it.each([
    "http://127.0.0.1/admin",
    "http://10.0.0.2/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[::ffff:7f00:1]/",
    "http://host.docker.internal/",
    "file:///etc/passwd",
  ])("rejects non-public target %s", target => {
    expect(() => assertSafeExternalUrl(target)).toThrow(
      ExternalUrlRejectedError,
    );
  });

  it("accepts a normal HTTPS object URL", () => {
    expect(assertSafeExternalUrl("https://objects.example.com/a.pdf?x=1")).toBe(
      "https://objects.example.com/a.pdf?x=1",
    );
  });

  it("recognizes private DNS results before a socket is opened", () => {
    expect(isBlockedNetworkAddress("192.168.1.2")).toBe(true);
    expect(isBlockedNetworkAddress("fd00::1")).toBe(true);
    expect(isBlockedNetworkAddress("8.8.8.8")).toBe(false);
  });
});

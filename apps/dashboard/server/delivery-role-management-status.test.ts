import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { deliveryTicketStatusGroup } from "./delivery-role-service";

describe("delivery management public ticket status", () => {
  it.each([
    ["submitted", "pending"],
    ["needs_information", "pending"],
    ["scheduled", "pending"],
    ["in_progress", "pending"],
    ["completed", "completed"],
    ["rejected", "completed"],
    ["cancelled", "completed"],
  ] as const)("maps historical %s to %s", (historical, expected) => {
    expect(deliveryTicketStatusGroup(historical)).toBe(expected);
  });

  it("does not accidentally expose an unknown database state", () => {
    expect(deliveryTicketStatusGroup("future_unknown_state")).toBeNull();
  });

  it("does not expose administrator dispatch or urge mutations", () => {
    const source = readFileSync(
      resolve(process.cwd(), "server/delivery-role-router.ts"),
      "utf8",
    );

    expect(source).not.toContain("dispatchTicket:");
    expect(source).not.toContain("urgeTicket:");
    expect(source).not.toContain("dispatchDeliveryTicket");
    expect(source).not.toContain("urgeDeliveryTicket");
  });
});

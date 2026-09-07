import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { DeliveryRoleType } from "@shared/delivery-roles";
import {
  filterProjectTeams,
  getMissingProjectRoleTypes,
  summarizeProjectTeams,
} from "./AdminDeliveryRoles";

const coreRoles: DeliveryRoleType[] = [
  "monitoring_optimization_engineer",
  "content_distribution_engineer",
];
const allRoles: DeliveryRoleType[] = ["ai_operations_engineer", ...coreRoles];

function project(
  input: Partial<{
    id: number;
    displayName: string;
    username: string;
    managerId: number;
    requiredRoleTypes: DeliveryRoleType[];
  }> = {},
) {
  return {
    id: input.id ?? 1,
    username: input.username ?? "acme",
    displayName: input.displayName ?? "示例客户",
    isActive: true,
    managerId: input.managerId ?? 10,
    managerUsername: "delivery-admin",
    managerDisplayName: "交付管理员",
    requiredRoleTypes: input.requiredRoleTypes ?? allRoles,
  };
}

function assignment(
  customerUserId: number,
  roleType: DeliveryRoleType,
  engineerUserId: number | null = 100,
) {
  return {
    id: `${customerUserId}-${roleType}`,
    customerUserId,
    roleType,
    engineerUserId,
    revision: 1,
    engineerUsername: `engineer-${engineerUserId}`,
    engineerDisplayName: `工程师 ${engineerUserId}`,
    engineerApiKeyConfigured: true,
  };
}

describe("customer project team helpers", () => {
  it("requires the same three roles even when a legacy project lists fewer roles", () => {
    const legacyProject = project({ requiredRoleTypes: coreRoles });
    const assignments = coreRoles.map((roleType) => assignment(legacyProject.id, roleType));
    expect(getMissingProjectRoleTypes(legacyProject, assignments)).toEqual([
      "ai_operations_engineer",
    ]);
    expect(getMissingProjectRoleTypes(legacyProject, [
      ...assignments,
      assignment(legacyProject.id, "ai_operations_engineer"),
    ])).toEqual([]);
  });

  it("summarizes incomplete projects and missing roles", () => {
    const projects = [
      project({ id: 1 }),
      project({
        id: 2,
        requiredRoleTypes: allRoles,
      }),
    ];
    const assignments = [
      ...coreRoles.slice(0, 1).map((roleType) => assignment(1, roleType)),
      ...allRoles.map((roleType) => assignment(2, roleType)),
    ];

    expect(summarizeProjectTeams(projects, assignments)).toEqual({
      projectCount: 2,
      incompleteProjectCount: 1,
      missingRoleCount: 2,
    });
  });

  it("keeps a project incomplete until its delivery administrator is set", () => {
    const unownedProject = {
      ...project(),
      managerId: null,
    };
    const assignments = allRoles.map((roleType) =>
      assignment(unownedProject.id, roleType),
    );

    expect(summarizeProjectTeams([unownedProject], assignments)).toMatchObject({
      incompleteProjectCount: 1,
      missingRoleCount: 0,
    });
    expect(
      filterProjectTeams([unownedProject], assignments, {
        query: "",
        managerId: "all",
        teamStatus: "incomplete",
      }),
    ).toHaveLength(1);
  });

  it("treats a retained role slot with no engineer as unassigned", () => {
    const basicProject = project();
    const assignments = allRoles.map((roleType, index) =>
      assignment(basicProject.id, roleType, index === 0 ? null : 100 + index),
    );

    expect(getMissingProjectRoleTypes(basicProject, assignments)).toEqual([
      "ai_operations_engineer",
    ]);
    expect(summarizeProjectTeams([basicProject], assignments)).toMatchObject({
      incompleteProjectCount: 1,
      missingRoleCount: 1,
    });
  });

  it("filters by account text, manager, and completion state", () => {
    const projects = [
      project({ id: 1, displayName: "甲公司", username: "alpha" }),
      project({
        id: 2,
        displayName: "乙公司",
        username: "beta",
        managerId: 20,
        requiredRoleTypes: allRoles,
      }),
    ];
    const assignments = allRoles.map((roleType) => assignment(1, roleType));

    expect(
      filterProjectTeams(projects, assignments, {
        query: "alpha",
        managerId: "all",
        teamStatus: "all",
      }).map((row) => row.id),
    ).toEqual([1]);
    expect(
      filterProjectTeams(projects, assignments, {
        query: "",
        managerId: "20",
        teamStatus: "incomplete",
      }).map((row) => row.id),
    ).toEqual([2]);
    expect(
      filterProjectTeams(projects, assignments, {
        query: "",
        managerId: "all",
        teamStatus: "complete",
      }).map((row) => row.id),
    ).toEqual([1]);
  });

  it("does not expose the retired global-team and API-key forms", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDeliveryRoles.tsx"),
      "utf8",
    );

    for (const retiredCopy of [
      "固定交付团队",
      "创建交付成员",
      "成员加入团队",
      "成员通用智能体 Key",
    ]) {
      expect(source).not.toContain(retiredCopy);
    }
    expect(source).toContain('title="客户项目团队"');
    expect(source).not.toContain("<DeliveryWorkflowGuide");
    expect(source).not.toContain("项目交付协作链");
  });

  it("separates project coordination from shared-engineer key ownership", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDeliveryRoles.tsx"),
      "utf8",
    );

    expect(source).toContain("项目工程师已更新");
    expect(source).not.toContain("未结束需求");
    expect(source).toContain(
      "工程师加入后由该管理员负责项目协调；所有账号 API Key 均由系统管理员在“API 与人员管理”统一维护",
    );
    expect(source).not.toContain("engineer.apiKeyManageable !== false");
    expect(source).toContain("Key 由系统管理员维护");
  });

  it("does not highlight a role card with a yellow outer frame", () => {
    const source = readFileSync(
      resolve(process.cwd(), "client/src/pages/AdminDeliveryRoles.tsx"),
      "utf8",
    );

    expect(source).not.toContain("highlightedRole");
    expect(source).not.toContain("getInitialHighlightedRole");
    expect(source).not.toContain("border-amber-400 ring-2 ring-amber-200");
  });
});

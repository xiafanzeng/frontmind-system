import { describe, expect, it } from "vitest";

import { QUESTION_CLASSIFICATION_V2_WRITES_ENABLED } from "../shared/service-portal";
import {
  countReservedQuestionUsage,
  resolveWorkspaceQuestionApprovalCategory,
} from "./service-entitlement";
import {
  questionCategoryForPublic,
  UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
} from "./question-selection-policy";

describe("workspace question selection policy", () => {
  it("enables engineer-classified direct question writes after the compatibility release", () => {
    expect(QUESTION_CLASSIFICATION_V2_WRITES_ENABLED).toBe(true);
  });

  it("keeps the database category readable while hiding the compatibility value", () => {
    expect(
      questionCategoryForPublic({
        category: "product_scenario",
        candidateKey: UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
        source: "user",
        status: "candidate",
        selectionApprovalStatus: "pending",
      }),
    ).toBeNull();
    expect(
      questionCategoryForPublic({
        category: "competitor_comparison",
        candidateKey: null,
        source: "user",
        status: "selected",
        selectionApprovalStatus: "approved",
      }),
    ).toBe("competitor_comparison");
    expect(
      questionCategoryForPublic({
        category: "product_scenario",
        candidateKey: null,
        source: "user",
        status: "candidate",
        selectionApprovalStatus: "pending",
      }),
    ).toBe("product_scenario");
  });

  it("reserves total capacity for unclassified pending questions without assigning a category", () => {
    expect(
      countReservedQuestionUsage(
        [
          {
            quotaPeriodId: "period-1",
            category: "product_scenario",
            candidateKey: UNCLASSIFIED_QUESTION_CANDIDATE_KEY,
            source: "user",
            status: "candidate",
            selectionApprovalStatus: "pending",
          },
          {
            quotaPeriodId: "period-1",
            category: "industry",
            candidateKey: null,
            source: "admin",
            status: "candidate",
            selectionApprovalStatus: "pending",
          },
          {
            quotaPeriodId: "period-1",
            category: "reputation",
            candidateKey: null,
            source: "admin",
            status: "selected",
            selectionApprovalStatus: "approved",
          },
        ],
        "period-1",
      ),
    ).toEqual({
      industry: 1,
      competitorComparison: 0,
      reputation: 1,
      productScenario: 0,
      total: 3,
    });
  });

  it("requires a category only for an unclassified question", () => {
    expect(
      resolveWorkspaceQuestionApprovalCategory({
        currentCategory: null,
        requestedCategory: "competitor_comparison",
      }),
    ).toBe("competitor_comparison");
    expect(() =>
      resolveWorkspaceQuestionApprovalCategory({ currentCategory: null }),
    ).toThrow("必须先由服务团队选择问题类型");
  });

  it("does not allow approval to overwrite an existing category", () => {
    expect(
      resolveWorkspaceQuestionApprovalCategory({
        currentCategory: "industry",
      }),
    ).toBe("industry");
    expect(() =>
      resolveWorkspaceQuestionApprovalCategory({
        currentCategory: "industry",
        requestedCategory: "reputation",
      }),
    ).toThrow("不能在审核时改为其他问题类型");
  });
});

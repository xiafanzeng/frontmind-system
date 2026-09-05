import { describe, expect, it } from "vitest";

import {
  acceptanceGeoAnswerBooks,
  acceptanceMonitoringFixtureCounts,
} from "./acceptance-monitoring-fixture";

describe("synthetic acceptance monitoring fixture", () => {
  it("provides 50 anonymous answers across two questions and five models", () => {
    const scopes = Object.values(acceptanceGeoAnswerBooks).flatMap((book) =>
      book.platforms.flatMap((platform) =>
        platform.questions.map((question) => ({
          model: platform.name,
          question: question.question,
          answers: question.answers.length,
        })),
      ),
    );

    expect(acceptanceMonitoringFixtureCounts).toEqual(
      expect.objectContaining({
        answers: 50,
        questions: 2,
        platforms: 5,
        date: "2026-01-15",
      }),
    );
    expect(scopes).toHaveLength(10);
    expect(scopes.every((scope) => scope.answers === 5)).toBe(true);
    expect(scopes.reduce((total, scope) => total + scope.answers, 0)).toBe(50);
  });
});

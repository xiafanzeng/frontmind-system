import type { WorkspaceQuestionCategory } from "../shared/service-portal";

/*
 * workspace_questions.category stays NOT NULL so an older Dashboard process
 * can keep reading rows during a rolling Dev deployment. A pending user-authored
 * question uses this non-authoritative storage value; every new-code read path
 * treats the pending approval state as the source of truth and exposes null
 * until an engineer writes the approved category.
 */
export const UNCLASSIFIED_QUESTION_STORAGE_CATEGORY =
  "product_scenario" as const;

/**
 * Existing user-authored questions may legitimately be pending in the
 * product-scenario category. Keep an explicit marker in the already-nullable
 * candidateKey column so those historical rows are never reinterpreted as
 * awaiting classification.
 */
export const UNCLASSIFIED_QUESTION_CANDIDATE_KEY =
  "direct:v2:pending-classification" as const;

export type QuestionClassificationState = {
  category: WorkspaceQuestionCategory;
  candidateKey?: string | null;
  source: string;
  status: string;
  selectionApprovalStatus?: string | null;
};

export function isUserQuestionPendingClassification(
  row: Omit<QuestionClassificationState, "category">,
) {
  return (
    row.candidateKey === UNCLASSIFIED_QUESTION_CANDIDATE_KEY &&
    row.source === "user" &&
    row.status === "candidate" &&
    row.selectionApprovalStatus === "pending"
  );
}

export function questionCategoryForPublic(
  row: QuestionClassificationState,
): WorkspaceQuestionCategory | null {
  return isUserQuestionPendingClassification(row) ? null : row.category;
}

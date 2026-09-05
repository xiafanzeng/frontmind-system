import { KnowledgeBaseTurnReservationError } from "./knowledge-base-turn-service";

export function assertKnowledgeBaseExpectedGeneration(input: {
  expectedGeneration: number | undefined;
  actualGeneration: number;
}) {
  if (
    input.expectedGeneration !== undefined &&
    input.expectedGeneration !== input.actualGeneration
  ) {
    throw new KnowledgeBaseTurnReservationError(
      "CONFLICT",
      "当前知识库已重置或进入新一代构建，请刷新后重试",
    );
  }
}

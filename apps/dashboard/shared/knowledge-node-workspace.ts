import type {
  KnowledgeBaseApprovedResourceDto,
  KnowledgeBaseLeafStatus,
  KnowledgeBaseObservationDto,
} from "./knowledge-base-progress";

export interface KnowledgeNodeCapability {
  allowed: boolean;
  reason: string | null;
}

export interface KnowledgeNodeDetailsDto {
  coordinates: {
    buildId: string;
    conversationId: string;
    leafId: string;
    generation: number;
    revision: number;
    stateEpoch: number;
    contentVersion: number;
    resetRevision: number;
  };
  node: {
    leafId: string;
    title: string;
    status: KnowledgeBaseLeafStatus;
    contentMarkdown: string;
  };
  resources: KnowledgeBaseApprovedResourceDto[];
  capabilities: {
    directEdit: KnowledgeNodeCapability;
    aiEdit: KnowledgeNodeCapability;
    manageImages: KnowledgeNodeCapability;
  };
}

export interface KnowledgeNodeContentQuery {
  conversationId: string;
  leafId: string;
  expectedGeneration: number;
  expectedContentVersion: number;
}

export interface KnowledgeNodeSearchInput {
  conversationId: string;
  query: string;
  expectedGeneration: number;
  expectedContentVersion: number;
  expectedResetRevision?: number;
}

export interface KnowledgeNodeSearchMatch {
  leafId: string;
  branchId: string;
  branchTitle: string;
  title: string;
  status: KnowledgeBaseLeafStatus;
  snippet: string;
  matchFields: Array<"title" | "content">;
}

export interface KnowledgeNodeSearchResult {
  coordinates: {
    buildId: string;
    conversationId: string;
    generation: number;
    contentVersion: number;
    resetRevision: number;
  };
  matches: KnowledgeNodeSearchMatch[];
}

export interface KnowledgeNodeSaveInput {
  conversationId: string;
  leafId: string;
  clientRequestId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedStateEpoch: number;
  expectedContentVersion: number;
  expectedResetRevision: number;
  contentMarkdown: string;
}

export interface KnowledgeNodeSaveResult {
  accepted: true;
  unchanged: boolean;
  observation: KnowledgeBaseObservationDto;
}

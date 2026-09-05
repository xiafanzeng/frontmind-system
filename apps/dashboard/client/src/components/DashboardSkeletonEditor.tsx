import {
  ArrowLeft,
  BarChart3,
  Building2,
  Eye,
  FileJson2,
  FileSpreadsheet,
  LayoutTemplate,
  Loader2,
  Plus,
  RefreshCw,
  Save,
  Table2,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";

import { PortalCard } from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import CustomerDashboardMirror, {
  type CustomerKnowledgePreview,
  type CustomerDashboardMirrorSection,
} from "@/components/CustomerDashboardMirror";
import { trpc } from "@/lib/trpc";
import {
  createDashboardModuleTemplateMetadata,
  createDashboardOptimizationReportTemplate,
  dashboardModuleImportPreviewSchema,
  dashboardPayloadSchema,
  type DashboardModuleImportPreview,
  type DashboardPayload,
} from "@shared/dashboard";
import type {
  PublicDeliveryTicketSummary,
  PublicDeliveryTicketWorkspaceMetadata,
} from "@shared/delivery-ticket";
import OptimizationReportEditor from "./OptimizationReportEditor";

type DashboardImportModule =
  | "profile"
  | "metrics"
  | "sections"
  | "section-table"
  | "keywords"
  | "questions"
  | "monitoring"
  | "response-logic"
  | "content-assets"
  | "optimization-report";

export type DashboardWorkspaceSnapshot = {
  payload: DashboardPayload;
  revision?: number;
  sourceName?: string | null;
  enterpriseIdentityBoundAt?: number | null;
  updatedAt?: number | null;
};

type DashboardSkeletonEditorProps = {
  userId: number;
  workspace?: DashboardWorkspaceSnapshot;
  loading?: boolean;
  dashboardLayout?: "embedded" | "workspace";
  initialSection?: CustomerDashboardMirrorSection;
  marketEdition?: "domestic" | "overseas";
  brandTrackingManagement?: ReactNode;
  onExitDashboard?: () => void;
  knowledgePreview?: CustomerKnowledgePreview | null;
  servicePortal?: unknown;
  servicePortalLoading?: boolean;
  servicePortalError?: boolean;
  onRefreshServicePortal?: () => void;
  websiteWorkspace?:
    | (PublicDeliveryTicketWorkspaceMetadata & {
        tickets: PublicDeliveryTicketSummary[];
      })
    | null;
  knowledgeUploading?: boolean;
  onUploadKnowledge?: (file: File) => void | Promise<void>;
  onOpenWebsiteWorkspace?: () => void;
  authoritativeQuestions?: readonly AuthoritativeQuestionTemplateSource[];
  authoritativeQuestionsLoading?: boolean;
  authoritativeQuestionsError?: string | null;
  onWorkspaceChanged?: () => void | Promise<void>;
};

type AuthoritativeQuestionTemplateSource = {
  id: string;
  revision: number;
  category:
    | "industry"
    | "competitor_comparison"
    | "reputation"
    | "product_scenario";
  question: string;
  intent?: string | null;
  rationale?: string | null;
};

type ImportCardDefinition = {
  module: Exclude<DashboardImportModule, "section-table">;
  title: string;
  description: string;
  accept: string;
  format: string;
  icon: typeof FileSpreadsheet;
};

type MonitoringImportIssue = {
  level?: "error" | "warning" | "info";
  severity?: "error" | "warning";
  code?: string;
  message?: string;
  sheet?: string;
  row?: number;
};

type MonitoringImportBatchOption = {
  batchKey: string;
  sourceName?: string;
  collectedAt?: string | number;
  revision?: number;
  sampleCount?: number;
  citationCount?: number;
};

type MonitoringImportPreview = {
  mode?: string;
  sourceName?: string;
  fileHash?: string;
  sampleCount?: number;
  citationCount?: number;
  exactLinked?: number | boolean;
  targetBatchRequired?: boolean;
  suggestedBatchKey?: string;
  questions?: Array<
    string | { id?: string; label?: string; question?: string }
  >;
  models?: Array<
    string | { key?: string; value?: string; label?: string; name?: string }
  >;
  dates?: string[];
  issues?: Array<string | MonitoringImportIssue>;
  availableBatches?: MonitoringImportBatchOption[];
  preflightToken?: string;
  preflightExpiresAt?: string;
  preflightTargetBatchKey?: string;
};

type PendingMonitoringImport = {
  file: File;
  preview: MonitoringImportPreview;
  targetBatchKey: string;
};

type OptimizationReportImportPreview = {
  mode: "optimization-report";
  sourceName: string;
  fileHash: string;
  templateRevision: number;
  questionReports: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
  };
  questionBaselines: {
    added: number;
    updated: number;
    removed: number;
    unchanged: number;
  };
  releasedAfterEffects: number;
  questions: Array<{
    id: string;
    question: string;
    afterEffectReleased: boolean;
  }>;
  preflightToken?: string;
  preflightExpiresAt?: string;
};

type PendingOptimizationReportImport = {
  file: File;
  preview: OptimizationReportImportPreview;
};

type PendingDashboardModuleImport = {
  file: File;
  sectionId?: string;
  preview: DashboardModuleImportPreview;
};

type ResponseLogicTemplateRecord = {
  questionId?: string;
  question?: string;
  revision?: number;
  draft?: Record<string, unknown> | null;
  confirmed?: Record<string, unknown> | null;
};

function responseLogicDraftForTemplate(
  record?: ResponseLogicTemplateRecord | null,
) {
  const source = record?.confirmed ?? record?.draft ?? {};
  return {
    concern: String(source.concern ?? ""),
    conclusion: String(source.conclusion ?? ""),
    facts: String(source.facts ?? ""),
    pending: String(source.pending ?? ""),
    boundaries: String(source.boundaries ?? ""),
    references: String(source.references ?? ""),
    images: Array.isArray(source.images) ? source.images : [],
  };
}

export function currentModuleTemplate(input: {
  module: Exclude<DashboardImportModule, "section-table">;
  revision: number;
  payload: DashboardPayload;
  responseLogicRecords: readonly ResponseLogicTemplateRecord[];
  authoritativeQuestions?: readonly AuthoritativeQuestionTemplateSource[];
}) {
  if (input.module === "optimization-report") {
    return createDashboardOptimizationReportTemplate({
      revision: input.revision,
      report: input.payload.optimizationReport,
    });
  }
  const metadata = createDashboardModuleTemplateMetadata({
    module: input.module,
    revision: input.revision,
  });
  if (input.module === "profile") {
    return {
      ...metadata,
      profile: {
        brandName: input.payload.brandName,
        headline: input.payload.headline,
        summary: input.payload.summary,
      },
    };
  }
  if (input.module === "metrics") {
    return { ...metadata, metrics: input.payload.metrics };
  }
  if (input.module === "sections") {
    return { ...metadata, sections: input.payload.sections };
  }
  if (input.module === "keywords") {
    return { ...metadata, keywordTables: input.payload.keywordTables };
  }
  if (input.module === "questions") {
    const questions =
      input.authoritativeQuestions ??
      input.payload.questions.map((question) => ({
        id: question.id,
        revision: 1,
        category:
          question.groupId === "ranking" || question.groupId === "industry"
            ? ("industry" as const)
            : question.groupId === "comparison" ||
                question.groupId === "competitor"
              ? ("competitor_comparison" as const)
              : question.groupId === "reputation"
                ? ("reputation" as const)
                : ("product_scenario" as const),
        question: question.question,
        intent: question.intent || null,
        rationale: question.summary || null,
      }));
    return {
      ...metadata,
      questions: questions.map((question) => ({
        id: question.id,
        revision: question.revision,
        category: question.category,
        question: question.question,
        intent: question.intent ?? null,
        rationale: question.rationale ?? null,
      })),
    };
  }
  if (input.module === "monitoring") {
    return {
      ...metadata,
      monitoringAnswers: input.payload.monitoringAnswers,
      citations: input.payload.citations,
    };
  }
  if (input.module === "response-logic") {
    const recordsByQuestionId = new Map(
      input.responseLogicRecords.map((record) => [record.questionId, record]),
    );
    const questions =
      input.authoritativeQuestions?.map((question) => ({
        id: question.id,
        question: question.question,
      })) ?? input.payload.questions;
    return {
      ...metadata,
      responseLogic: questions.map((question) => {
        const record = recordsByQuestionId.get(question.id);
        return {
          questionId: question.id,
          question: question.question,
          // This is the optimistic record version, not the published V-number.
          // Zero means the question does not yet have a response-logic record.
          version: record?.revision ?? 0,
          draft: responseLogicDraftForTemplate(record),
          publish: Boolean(record?.confirmed),
        };
      }),
    };
  }
  return { ...metadata, contentAssets: input.payload.contentAssets };
}

function downloadModuleTemplate(input: {
  module: Exclude<DashboardImportModule, "section-table">;
  revision: number;
  payload: DashboardPayload;
  responseLogicRecords: readonly ResponseLogicTemplateRecord[];
  authoritativeQuestions?: readonly AuthoritativeQuestionTemplateSource[];
}) {
  const text = JSON.stringify(currentModuleTemplate(input), null, 2);
  const blob = new Blob([text], {
    type: "application/json;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `frontmind-${input.module}-current-R${input.revision}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function downloadMonitoringCurrentTemplate(userId: number) {
  const response = await fetch(`/api/dashboard/monitoring-template/${userId}`, {
    credentials: "include",
  });
  if (!response.ok) throw new Error(await readImportError(response));
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const filename =
    disposition.match(/filename="?([^";]+)"?/i)?.[1] ||
    `frontmind-monitoring-current-${userId}.json`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

const importCards: ImportCardDefinition[] = [
  {
    module: "profile",
    title: "页面抬头",
    description: "上传客户服务首页的抬头内容。",
    accept: ".json,application/json",
    format: "JSON 当前数据",
    icon: Building2,
  },
  {
    module: "metrics",
    title: "数据卡片",
    description: "上传客户服务首页的数据卡片。",
    accept: ".json,application/json",
    format: "JSON 当前数据",
    icon: BarChart3,
  },
  {
    module: "sections",
    title: "页面内容",
    description: "上传客户服务首页的正文、图片和表格。",
    accept: ".json,application/json",
    format: "JSON 当前数据",
    icon: LayoutTemplate,
  },
  {
    module: "keywords",
    title: "品牌全域词库",
    description:
      "上传问题列表 XLSX/CSV，按核心词分类自动映射四类标签并独立替换词库页面。",
    accept:
      ".xlsx,.csv,.json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv,application/json",
    format: "XLSX / CSV / JSON",
    icon: Table2,
  },
  {
    module: "questions",
    title: "问题目录",
    description: "维护问题分类、用户意图和应答目标，供问题优化与智能体使用。",
    accept: ".json,application/json",
    format: "JSON 当前模板",
    icon: FileSpreadsheet,
  },
  {
    module: "monitoring",
    title: "问题监控与引用",
    description:
      "先预检问题、模型、日期及答案关联。完整模板支持逐答案信源，旧引用表仅更新问题级汇总。",
    accept: ".csv,.xlsx,.json,text/csv,application/json",
    format: "XLSX / CSV / JSON",
    icon: BarChart3,
  },
  {
    module: "response-logic",
    title: "应答逻辑确认稿",
    description: "按问题 ID 导入草稿或确认稿，直接同步该用户的应答逻辑页面。",
    accept: ".json,application/json",
    format: "JSON 当前模板",
    icon: FileSpreadsheet,
  },
  {
    module: "content-assets",
    title: "AI 友好内容资产",
    description: "更新内容类型、文章正文、图文素材引用和适用场景。",
    accept: ".json,application/json",
    format: "JSON 当前模板",
    icon: LayoutTemplate,
  },
  {
    module: "optimization-report",
    title: "进度报告",
    description: "按四类问题发布优化前基准、前后答案案例与复测指标。",
    accept: ".json,application/json",
    format: "JSON",
    icon: FileJson2,
  },
];

function clonePayload(payload: DashboardPayload) {
  return JSON.parse(JSON.stringify(payload)) as DashboardPayload;
}

export function dashboardEditorDisplayText(value: string) {
  return value
    .replaceAll("企业数据骨架", "客户页面")
    .replaceAll("看板指标", "数据卡片")
    .replaceAll("内容板块与卡片", "页面内容");
}

function nextSectionId(sections: DashboardPayload["sections"]) {
  const taken = new Set(sections.map((section) => section.id));
  let index = sections.length + 1;
  while (taken.has(`section-${index}`)) index += 1;
  return `section-${index}`;
}

function readImportError(response: Response) {
  return response
    .json()
    .then(
      (payload) =>
        payload?.error?.message ||
        payload?.message ||
        `导入失败 (${response.status})`,
    )
    .catch(() => `导入失败 (${response.status})`);
}

function monitoringPreviewIssueText(issue: string | MonitoringImportIssue) {
  if (typeof issue === "string") return issue;
  const location = [
    issue.sheet?.trim(),
    Number.isFinite(issue.row) ? `第 ${issue.row} 行` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return [location, issue.message?.trim()].filter(Boolean).join("：");
}

function monitoringPreviewQuestionText(
  question: string | { id?: string; label?: string; question?: string },
) {
  if (typeof question === "string") return question;
  return question.label || question.question || question.id || "未命名问题";
}

function monitoringPreviewModelText(
  model:
    | string
    | { key?: string; value?: string; label?: string; name?: string },
) {
  if (typeof model === "string") return model;
  return model.label || model.name || model.value || model.key || "未命名模型";
}

function monitoringPreviewHasErrors(preview: MonitoringImportPreview) {
  return (
    preview.mode === "invalid" ||
    preview.issues?.some(
      (issue) =>
        typeof issue !== "string" &&
        (issue.severity === "error" || issue.level === "error"),
    ) === true
  );
}

function monitoringPreviewHasCompleteLinks(preview: MonitoringImportPreview) {
  const citationCount = Math.max(0, Number(preview.citationCount || 0));
  const exactLinked =
    preview.exactLinked === true
      ? citationCount
      : Math.max(0, Number(preview.exactLinked || 0));
  return (
    Number(preview.sampleCount || 0) > 0 &&
    citationCount > 0 &&
    exactLinked === citationCount
  );
}

export function monitoringImportPublishedDescription(
  preview: MonitoringImportPreview,
) {
  if (monitoringPreviewHasCompleteLinks(preview)) {
    return "答案与引用来源已完成精确关联。";
  }
  if (preview.mode === "answer-only") {
    return "答案明细已发布；逐答案信源为空，可继续上传对应的信源表。";
  }
  if (preview.mode === "question-only") {
    return "问题级引用分析已更新，未生成逐答案关联。";
  }
  return "监控数据已更新；没有将问题级引用混入某一条答案。";
}

function monitoringBatchDate(value: string | number | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function preflightCredentialUsable(input: {
  preflightToken?: string;
  preflightExpiresAt?: string;
}) {
  if (!input.preflightToken?.trim()) return false;
  if (!input.preflightExpiresAt) return true;
  const expiresAt = Date.parse(input.preflightExpiresAt);
  return Number.isFinite(expiresAt) && expiresAt > Date.now() + 5_000;
}

export default function DashboardSkeletonEditor({
  userId,
  workspace,
  loading = false,
  dashboardLayout = "embedded",
  initialSection,
  marketEdition = "domestic",
  brandTrackingManagement,
  onExitDashboard,
  knowledgePreview = null,
  servicePortal,
  servicePortalLoading = false,
  servicePortalError = false,
  onRefreshServicePortal,
  websiteWorkspace = null,
  knowledgeUploading = false,
  onUploadKnowledge,
  onOpenWebsiteWorkspace,
  authoritativeQuestions,
  authoritativeQuestionsLoading = false,
  authoritativeQuestionsError = null,
  onWorkspaceChanged,
}: DashboardSkeletonEditorProps) {
  const [draft, setDraft] = useState<DashboardPayload | null>(
    workspace?.payload ? clonePayload(workspace.payload) : null,
  );
  const [dirty, setDirty] = useState(false);
  const [publishReason, setPublishReason] = useState("");
  const [importingKey, setImportingKey] = useState("");
  const [pendingMonitoringImport, setPendingMonitoringImport] =
    useState<PendingMonitoringImport | null>(null);
  const [pendingOptimizationReportImport, setPendingOptimizationReportImport] =
    useState<PendingOptimizationReportImport | null>(null);
  const [pendingDashboardModuleImport, setPendingDashboardModuleImport] =
    useState<PendingDashboardModuleImport | null>(null);
  const updateMutation = trpc.admin.workspace.updateDashboard.useMutation();
  const responseLogicQuery = trpc.admin.workspace.responseLogic.useQuery(
    { userId },
    {
      enabled: Boolean(workspace?.enterpriseIdentityBoundAt),
      retry: false,
    },
  );

  useEffect(() => {
    setDraft(workspace?.payload ? clonePayload(workspace.payload) : null);
    setDirty(false);
    setPublishReason("");
    setPendingMonitoringImport(null);
    setPendingOptimizationReportImport(null);
    setPendingDashboardModuleImport(null);
  }, [userId, workspace?.payload, workspace?.revision]);

  const revision = workspace?.revision ?? 0;
  const busy = updateMutation.isPending || Boolean(importingKey);
  const enterpriseIdentityBound = Boolean(workspace?.enterpriseIdentityBoundAt);

  const patchDraft = (
    update:
      | Partial<DashboardPayload>
      | ((current: DashboardPayload) => DashboardPayload),
  ) => {
    setDraft((current) => {
      if (!current) return current;
      return typeof update === "function"
        ? update(current)
        : { ...current, ...update };
    });
    setDirty(true);
  };

  const saveDashboard = async () => {
    if (!draft || !dirty) return;
    const sectionIds = draft.sections.map((section) => section.id.trim());
    if (new Set(sectionIds).size !== sectionIds.length) {
      toast.error("板块 ID 不能重复", {
        description: "请为每个内容板块设置唯一 ID 后再发布。",
      });
      return;
    }
    const validated = dashboardPayloadSchema.safeParse(draft);
    if (!validated.success) {
      toast.error("请完善看板必填内容", {
        description:
          validated.error.issues[0]?.message ||
          "企业名称、标题和板块名称不能为空。",
      });
      return;
    }
    try {
      const updated = await updateMutation.mutateAsync({
        userId,
        payload: validated.data,
        expectedRevision: revision,
        reason: publishReason.trim() || undefined,
      });
      setDraft(clonePayload(updated.payload));
      setDirty(false);
      setPublishReason("");
      await onWorkspaceChanged?.();
      toast.success("交付内容与进度已更新", {
        description: `当前版本 R${updated.revision ?? revision + 1}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请稍后重试";
      toast.error(
        /版本|revision|conflict/i.test(message)
          ? "内容已被其他管理员更新"
          : "看板保存失败",
        {
          description: /版本|revision|conflict/i.test(message)
            ? "请刷新最新版本后再继续编辑，当前页面不会覆盖他人的修改。"
            : message,
        },
      );
    }
  };

  const requestModuleImport = async ({
    module,
    file,
    preview = false,
    sectionId,
    targetBatchKey,
    expectedFileHash,
    preflightToken,
  }: {
    module: DashboardImportModule;
    file: File;
    preview?: boolean;
    sectionId?: string;
    targetBatchKey?: string;
    expectedFileHash?: string;
    preflightToken?: string;
  }) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(file.name),
      "X-Import-Mode": "dashboard",
      "X-Dashboard-Module": module,
      "X-Dashboard-Revision": String(revision),
    };
    if (sectionId) headers["X-Dashboard-Section-Id"] = sectionId;
    if (preview) headers["X-Import-Preview"] = "true";
    if (targetBatchKey) {
      headers["X-Monitoring-Target-Batch-Key"] = targetBatchKey;
    }
    if (expectedFileHash) {
      headers[
        module === "monitoring"
          ? "X-Monitoring-File-Hash"
          : "X-Import-File-Hash"
      ] = expectedFileHash;
    }
    if (preflightToken) {
      headers["X-Import-Preflight-Token"] = preflightToken;
    }
    const response = await fetch(`/api/dashboard/import/${userId}`, {
      method: "PUT",
      credentials: "include",
      headers,
      body: file,
    });
    if (!response.ok) throw new Error(await readImportError(response));
    return response.json();
  };

  const importModule = async (
    module: DashboardImportModule,
    file: File,
    sectionId?: string,
  ) => {
    if (dirty) {
      toast.warning("请先保存当前编辑内容", {
        description: "模块导入会载入服务器上的最新版本。",
      });
      return;
    }
    const key = sectionId ? `${module}:${sectionId}` : module;
    setImportingKey(key);
    try {
      if (module === "monitoring") {
        const result = await requestModuleImport({
          module,
          file,
          preview: true,
        });
        const preview = (result?.preview || result) as MonitoringImportPreview;
        const availableBatches = preview.availableBatches || [];
        const firstAnswerBatch = availableBatches.find(
          (batch) => Number(batch.sampleCount || 0) > 0,
        );
        setPendingMonitoringImport({
          file,
          preview,
          targetBatchKey:
            preview.suggestedBatchKey || firstAnswerBatch?.batchKey || "",
        });
        return;
      }
      if (module === "optimization-report") {
        const result = await requestModuleImport({
          module,
          file,
          preview: true,
        });
        const preview = (result?.preview ||
          result) as OptimizationReportImportPreview;
        setPendingOptimizationReportImport({ file, preview });
        return;
      }

      const result = await requestModuleImport({
        module,
        file,
        sectionId,
        preview: true,
      });
      const preview = dashboardModuleImportPreviewSchema.parse(
        result?.preview || result,
      );
      setPendingDashboardModuleImport({ file, sectionId, preview });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请检查文件格式";
      toast.error(
        /版本|revision|conflict|模板|template/i.test(message)
          ? "内容版本已变化"
          : module === "monitoring"
            ? "监控文件预检失败"
            : "板块导入失败",
        {
          description: /版本|revision|conflict|模板|template/i.test(message)
            ? "请刷新最新版本后重新上传。"
            : message,
        },
      );
    } finally {
      setImportingKey("");
    }
  };

  const publishMonitoringImport = async () => {
    if (!pendingMonitoringImport) return;
    const { file, preview, targetBatchKey } = pendingMonitoringImport;
    if (preview.targetBatchRequired && !targetBatchKey) {
      toast.warning("请选择目标监控批次", {
        description: "旧版引用表必须补充到已有答案批次，不能单独发布。",
      });
      return;
    }
    setImportingKey("monitoring");
    try {
      let publishPreview = preview;
      if (
        !preflightCredentialUsable(preview) ||
        (targetBatchKey || undefined) !== preview.preflightTargetBatchKey
      ) {
        const refreshed = await requestModuleImport({
          module: "monitoring",
          file,
          preview: true,
          targetBatchKey,
        });
        publishPreview = (refreshed?.preview ||
          refreshed) as MonitoringImportPreview;
        if (
          monitoringPreviewHasErrors(publishPreview) ||
          !preflightCredentialUsable(publishPreview)
        ) {
          throw new Error("监控文件未能取得有效预检凭证，请重新上传预检。");
        }
        setPendingMonitoringImport((current) =>
          current ? { ...current, preview: publishPreview } : current,
        );
      }
      await requestModuleImport({
        module: "monitoring",
        file,
        targetBatchKey,
        expectedFileHash: publishPreview.fileHash,
        preflightToken: publishPreview.preflightToken,
      });
      setPendingMonitoringImport(null);
      setDirty(false);
      await onWorkspaceChanged?.();
      toast.success("问题监控数据已发布", {
        description: monitoringImportPublishedDescription(publishPreview),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请检查文件格式";
      toast.error(
        /版本|revision|conflict/i.test(message)
          ? "内容版本已变化"
          : "监控数据发布失败",
        {
          description: /版本|revision|conflict/i.test(message)
            ? "请重新预检最新文件后发布。"
            : message,
        },
      );
    } finally {
      setImportingKey("");
    }
  };

  const publishOptimizationReportImport = async () => {
    if (!pendingOptimizationReportImport) return;
    const { file, preview } = pendingOptimizationReportImport;
    setImportingKey("optimization-report");
    try {
      let publishPreview = preview;
      if (!preflightCredentialUsable(preview)) {
        const refreshed = await requestModuleImport({
          module: "optimization-report",
          file,
          preview: true,
        });
        publishPreview = (refreshed?.preview ||
          refreshed) as OptimizationReportImportPreview;
        if (!preflightCredentialUsable(publishPreview)) {
          throw new Error("进度报告未能取得有效预检凭证，请重新上传预检。");
        }
        setPendingOptimizationReportImport({ file, preview: publishPreview });
      }
      const result = await requestModuleImport({
        module: "optimization-report",
        file,
        expectedFileHash: publishPreview.fileHash,
        preflightToken: publishPreview.preflightToken,
      });
      const nextWorkspace = result?.dashboard;
      if (nextWorkspace?.payload) {
        setDraft(clonePayload(nextWorkspace.payload));
      }
      setPendingOptimizationReportImport(null);
      setDirty(false);
      await onWorkspaceChanged?.();
      toast.success("进度报告已发布", {
        description: `${file.name} · 模板 R${publishPreview.templateRevision}`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请检查文件格式";
      toast.error(
        /版本|revision|模板|template/i.test(message)
          ? "进度报告模板已过期"
          : "进度报告发布失败",
        {
          description: /版本|revision|模板|template/i.test(message)
            ? "请下载当前内容模板，重新合并修改后再上传。"
            : message,
        },
      );
    } finally {
      setImportingKey("");
    }
  };

  const publishDashboardModuleImport = async () => {
    if (!pendingDashboardModuleImport) return;
    const { file, preview, sectionId } = pendingDashboardModuleImport;
    const key = sectionId ? `${preview.module}:${sectionId}` : preview.module;
    setImportingKey(key);
    try {
      let publishPreview = preview;
      if (!preflightCredentialUsable(preview)) {
        const refreshed = await requestModuleImport({
          module: preview.module,
          file,
          sectionId,
          preview: true,
        });
        publishPreview = dashboardModuleImportPreviewSchema.parse(
          refreshed?.preview || refreshed,
        );
        if (!preflightCredentialUsable(publishPreview)) {
          throw new Error("模块未能取得有效预检凭证，请重新上传预检。");
        }
        setPendingDashboardModuleImport({
          file,
          sectionId,
          preview: publishPreview,
        });
      }
      const result = await requestModuleImport({
        module: publishPreview.module,
        file,
        sectionId,
        expectedFileHash: publishPreview.fileHash,
        preflightToken: publishPreview.preflightToken,
      });
      const nextWorkspace = result?.dashboard;
      if (nextWorkspace?.payload) {
        setDraft(clonePayload(nextWorkspace.payload));
      }
      if (publishPreview.module === "response-logic") {
        await responseLogicQuery.refetch();
      }
      setPendingDashboardModuleImport(null);
      setDirty(false);
      await onWorkspaceChanged?.();
      toast.success("板块内容已发布", {
        description: `${file.name} · ${
          publishPreview.module === "section-table"
            ? "板块表格"
            : importCards.find((item) => item.module === publishPreview.module)
                ?.title || publishPreview.module
        }`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "请检查文件格式";
      toast.error(
        /版本|revision|conflict|模板|template/i.test(message)
          ? "内容版本已变化"
          : "板块发布失败",
        {
          description: /版本|revision|conflict|模板|template/i.test(message)
            ? "请刷新当前内容，使用同一文件重新预检后再发布。"
            : message,
        },
      );
    } finally {
      setImportingKey("");
    }
  };

  const downloadCurrentModule = (card: ImportCardDefinition) => {
    if (card.module === "monitoring") {
      void downloadMonitoringCurrentTemplate(userId)
        .then(() => toast.success("当前问题监控模板已下载"))
        .catch((error) =>
          toast.error("问题监控模板下载失败", {
            description:
              error instanceof Error ? error.message : "请稍后重试。",
          }),
        );
      return;
    }
    if (
      (card.module === "questions" || card.module === "response-logic") &&
      authoritativeQuestionsLoading
    ) {
      toast.warning("正在读取正式问题目录，请稍后再下载。");
      return;
    }
    if (
      (card.module === "questions" || card.module === "response-logic") &&
      authoritativeQuestionsError
    ) {
      toast.error("正式问题目录暂时无法读取", {
        description: authoritativeQuestionsError,
      });
      return;
    }
    if (card.module === "response-logic" && responseLogicQuery.isLoading) {
      toast.warning("正在读取当前应答逻辑，请稍后再下载。");
      return;
    }
    if (card.module === "response-logic" && responseLogicQuery.error) {
      toast.error("当前应答逻辑暂时无法读取", {
        description: responseLogicQuery.error.message,
      });
      return;
    }
    downloadModuleTemplate({
      module: card.module,
      revision,
      payload: workspace?.payload ?? draft!,
      responseLogicRecords: responseLogicQuery.data?.records ?? [],
      authoritativeQuestions,
    });
  };

  if (loading || !draft) {
    return (
      <div
        className={
          dashboardLayout === "workspace"
            ? "flex h-full min-h-0 flex-col gap-4 p-4 sm:p-6"
            : ""
        }
      >
        {onExitDashboard && (
          <Button
            type="button"
            className="w-fit"
            size="sm"
            variant="operatorOutline"
            onClick={onExitDashboard}
          >
            <ArrowLeft className="h-4 w-4" />
            返回工作台
          </Button>
        )}
        <PortalCard className="grid min-h-[420px] flex-1 place-items-center p-8 text-sm text-[#716a80]">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在载入交付内容…
          </div>
        </PortalCard>
      </div>
    );
  }

  return (
    <div className={dashboardLayout === "workspace" ? "h-full" : "space-y-5"}>
      <CustomerDashboardMirror
        payload={draft}
        layout={dashboardLayout}
        initialSection={initialSection}
        marketEdition={marketEdition}
        allowBrandTrackingManagement={Boolean(brandTrackingManagement)}
        brandTrackingManagement={brandTrackingManagement}
        knowledgePreview={knowledgePreview}
        servicePortal={servicePortal}
        servicePortalLoading={servicePortalLoading}
        servicePortalError={servicePortalError}
        onRefreshServicePortal={onRefreshServicePortal}
        websiteWorkspace={websiteWorkspace}
        responseLogicRecords={responseLogicQuery.data?.records ?? []}
        editActions={
          <>
            {onExitDashboard && (
              <Button
                type="button"
                size="sm"
                variant="operatorOutline"
                onClick={onExitDashboard}
              >
                <ArrowLeft className="h-4 w-4" />
                返回工作台
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void onWorkspaceChanged?.()}
            >
              <RefreshCw className="h-4 w-4" />
              刷新
            </Button>
          </>
        }
        renderSectionActions={(section) => {
          if (
            (section === "knowledge-build" || section === "knowledge") &&
            onUploadKnowledge
          ) {
            return (
              <KnowledgeInlineActions
                uploading={knowledgeUploading}
                onFile={onUploadKnowledge}
              />
            );
          }
          if (section === "website" && onOpenWebsiteWorkspace) {
            return (
              <Button
                size="sm"
                className="bg-[#5b2a86] hover:bg-[#49216c]"
                onClick={onOpenWebsiteWorkspace}
              >
                打开官网交付
              </Button>
            );
          }
          return dashboardModulesForSection(section).map((module) => {
            const card = importCards.find((item) => item.module === module);
            if (!card) return null;
            return (
              <ModuleInlineActions
                key={card.module}
                definition={card}
                disabled={busy}
                importing={importingKey === card.module}
                onTemplate={() => downloadCurrentModule(card)}
                onFile={(file) => void importModule(card.module, file)}
              />
            );
          });
        }}
      />

      <Dialog
        open={Boolean(pendingDashboardModuleImport)}
        onOpenChange={(open) => {
          if (!open && !importingKey) {
            setPendingDashboardModuleImport(null);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-[min(860px,calc(100vw-2rem))] overflow-y-auto">
          <DialogHeader className="text-left">
            <DialogTitle>模块文件预检与差异确认</DialogTitle>
            <DialogDescription>
              预检只读取并校验文件，不会修改数据库。确认后将以同一文件哈希发布对应模块。
            </DialogDescription>
          </DialogHeader>

          {pendingDashboardModuleImport && (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <MonitoringPreviewMetric
                  label="目标模块"
                  value={
                    pendingDashboardModuleImport.preview.module ===
                    "section-table"
                      ? "板块表格"
                      : importCards.find(
                          (item) =>
                            item.module ===
                            pendingDashboardModuleImport.preview.module,
                        )?.title || pendingDashboardModuleImport.preview.module
                  }
                />
                <MonitoringPreviewMetric
                  label="当前模板修订号"
                  value={`R${pendingDashboardModuleImport.preview.templateRevision}`}
                />
                <MonitoringPreviewMetric
                  label="源文件"
                  value={pendingDashboardModuleImport.preview.sourceName}
                />
              </div>

              <section className="rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] p-4">
                <strong className="text-sm text-[#332842]">差异摘要</strong>
                <ul className="mt-3 space-y-2 text-sm leading-6 text-[#716a80]">
                  {pendingDashboardModuleImport.preview.summary.map(
                    (summary, index) => (
                      <li key={`${summary}-${index}`}>
                        {dashboardEditorDisplayText(summary)}
                      </li>
                    ),
                  )}
                </ul>
              </section>

              {pendingDashboardModuleImport.preview.recordStats.length > 0 && (
                <div className="grid gap-3 sm:grid-cols-2">
                  {pendingDashboardModuleImport.preview.recordStats.map(
                    (stats) => (
                      <section
                        key={stats.label}
                        className="rounded-2xl border border-[#e5ddea] bg-white p-4"
                      >
                        <strong className="text-sm text-[#332842]">
                          {dashboardEditorDisplayText(stats.label)}
                        </strong>
                        <p className="mt-2 text-xs leading-5 text-[#716a80]">
                          现有 {stats.beforeCount} 条 → 导入后{" "}
                          {stats.afterCount} 条
                        </p>
                        <p className="mt-1 text-xs leading-5 text-[#81778a]">
                          新增 {stats.added} · 更新 {stats.updated} · 删除{" "}
                          {stats.removed} · 不变 {stats.unchanged}
                        </p>
                      </section>
                    ),
                  )}
                </div>
              )}

              {pendingDashboardModuleImport.preview.changedFields.length >
                0 && (
                <section className="rounded-2xl border border-[#e5ddea] bg-white p-4">
                  <strong className="text-sm text-[#332842]">字段变化</strong>
                  <div className="mt-3 space-y-3">
                    {pendingDashboardModuleImport.preview.changedFields.map(
                      (field) => (
                        <div
                          key={field.field}
                          className="grid gap-2 rounded-xl border border-[#eee8f2] bg-[#fbf9fd] p-3 text-xs sm:grid-cols-2"
                        >
                          <p className="text-[#81778a]">
                            <strong className="block text-[#4d4258]">
                              {field.label} · 当前
                            </strong>
                            {field.before || "（空）"}
                          </p>
                          <p className="text-[#81778a]">
                            <strong className="block text-[#4d4258]">
                              {field.label} · 导入后
                            </strong>
                            {field.after || "（空）"}
                          </p>
                        </div>
                      ),
                    )}
                  </div>
                </section>
              )}

              <div className="rounded-2xl border border-[#ead7aa] bg-[#fff8e8] px-4 py-3 text-xs leading-5 text-[#805b08]">
                文件校验值：
                <span className="ml-1 font-mono">
                  {pendingDashboardModuleImport.preview.fileHash.slice(0, 16)}…
                </span>
                。若文件内容或当前看板版本变化，服务端会拒绝发布并要求重新预检。
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-[#eee8f2] pt-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={Boolean(importingKey)}
                  onClick={() => setPendingDashboardModuleImport(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="bg-[#5b2a86] hover:bg-[#49216c]"
                  disabled={Boolean(importingKey)}
                  onClick={() => void publishDashboardModuleImport()}
                >
                  {Boolean(importingKey) && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  确认发布
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingMonitoringImport)}
        onOpenChange={(open) => {
          if (!open && importingKey !== "monitoring") {
            setPendingMonitoringImport(null);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-[min(860px,calc(100vw-2rem))] overflow-y-auto">
          <DialogHeader className="text-left">
            <DialogTitle>问题监控文件预检</DialogTitle>
            <DialogDescription>
              核对问题、模型、日期和答案关联后再发布；预检本身不会修改用户看板。
            </DialogDescription>
          </DialogHeader>

          {pendingMonitoringImport && (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <MonitoringPreviewMetric
                  label="导入方式"
                  value={
                    monitoringPreviewHasCompleteLinks(
                      pendingMonitoringImport.preview,
                    )
                      ? "完整答案与引用"
                      : pendingMonitoringImport.preview.sampleCount
                        ? "答案明细（引用待补充）"
                        : "问题级引用补充"
                  }
                />
                <MonitoringPreviewMetric
                  label="答案记录"
                  value={String(
                    pendingMonitoringImport.preview.sampleCount ?? 0,
                  )}
                />
                <MonitoringPreviewMetric
                  label="引用记录"
                  value={String(
                    pendingMonitoringImport.preview.citationCount ?? 0,
                  )}
                />
                <MonitoringPreviewMetric
                  label="问题"
                  value={
                    pendingMonitoringImport.preview.questions
                      ?.map(monitoringPreviewQuestionText)
                      .join("、") || "未识别"
                  }
                />
                <MonitoringPreviewMetric
                  label="模型"
                  value={
                    pendingMonitoringImport.preview.models
                      ?.map(monitoringPreviewModelText)
                      .join("、") || "未识别"
                  }
                />
                <MonitoringPreviewMetric
                  label="采集日期"
                  value={
                    pendingMonitoringImport.preview.dates?.join("、") ||
                    "未识别"
                  }
                />
              </div>

              <div
                className={`rounded-2xl border px-4 py-3 text-sm leading-6 ${
                  monitoringPreviewHasCompleteLinks(
                    pendingMonitoringImport.preview,
                  )
                    ? "border-[#bee2d1] bg-[#eff9f3] text-[#176344]"
                    : "border-[#ead7aa] bg-[#fff8e8] text-[#805b08]"
                }`}
              >
                <strong className="block">
                  {monitoringPreviewHasCompleteLinks(
                    pendingMonitoringImport.preview,
                  )
                    ? "逐答案关联完备"
                    : "当前文件不包含逐答案关联键"}
                </strong>
                <span>
                  {monitoringPreviewHasCompleteLinks(
                    pendingMonitoringImport.preview,
                  )
                    ? "发布后切换答案时，右侧信源会按答案 ID 同步更新。"
                    : "该文件只更新下方问题级引用分析，不会把引用模糊匹配到某次答案。"}
                </span>
              </div>

              {pendingMonitoringImport.preview.targetBatchRequired && (
                <label className="block space-y-2">
                  <span className="text-sm font-semibold text-[#4d4258]">
                    目标监控批次
                  </span>
                  <select
                    aria-label="目标监控批次"
                    className="h-11 w-full rounded-xl border border-[#dcd2e3] bg-white px-3 text-sm text-[#221a33] outline-none focus:border-[#7c4b9c] focus:ring-2 focus:ring-[#7c4b9c]/15"
                    value={pendingMonitoringImport.targetBatchKey}
                    onChange={(event) =>
                      setPendingMonitoringImport((current) =>
                        current
                          ? {
                              ...current,
                              targetBatchKey: event.target.value,
                            }
                          : current,
                      )
                    }
                  >
                    <option value="">请选择已有答案批次</option>
                    {(pendingMonitoringImport.preview.availableBatches || [])
                      .filter((batch) => Number(batch.sampleCount || 0) > 0)
                      .map((batch) => (
                        <option key={batch.batchKey} value={batch.batchKey}>
                          {[
                            monitoringBatchDate(batch.collectedAt),
                            batch.sourceName,
                            batch.sampleCount === undefined
                              ? ""
                              : `${batch.sampleCount} 条答案`,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </option>
                      ))}
                  </select>
                  <p className="text-xs leading-5 text-[#81778a]">
                    旧版六列表格只能补充已有答案批次中的问题级引用，不会覆盖答案正文和已精确关联的信源。
                  </p>
                </label>
              )}

              {(pendingMonitoringImport.preview.issues?.length ?? 0) > 0 && (
                <div className="rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] p-4">
                  <strong className="text-sm text-[#332842]">预检提示</strong>
                  <ul className="mt-3 space-y-2 text-sm leading-6 text-[#716a80]">
                    {pendingMonitoringImport.preview.issues!.map(
                      (issue, index) => (
                        <li
                          key={`${monitoringPreviewIssueText(issue)}-${index}`}
                        >
                          {monitoringPreviewIssueText(issue)}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}

              <div className="flex flex-col-reverse gap-2 border-t border-[#eee8f2] pt-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={importingKey === "monitoring"}
                  onClick={() => setPendingMonitoringImport(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="bg-[#5b2a86] hover:bg-[#49216c]"
                  disabled={
                    importingKey === "monitoring" ||
                    (pendingMonitoringImport.preview.targetBatchRequired &&
                      !pendingMonitoringImport.targetBatchKey) ||
                    monitoringPreviewHasErrors(pendingMonitoringImport.preview)
                  }
                  onClick={() => void publishMonitoringImport()}
                >
                  {importingKey === "monitoring" && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  确认发布
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingOptimizationReportImport)}
        onOpenChange={(open) => {
          if (!open && importingKey !== "optimization-report") {
            setPendingOptimizationReportImport(null);
          }
        }}
      >
        <DialogContent className="max-h-[92vh] max-w-[min(860px,calc(100vw-2rem))] overflow-y-auto">
          <DialogHeader className="text-left">
            <DialogTitle>进度报告文件预检</DialogTitle>
            <DialogDescription>
              核对模板修订号、逐问题差异和优化后效果开放范围后再发布；预检不会修改用户看板。
            </DialogDescription>
          </DialogHeader>

          {pendingOptimizationReportImport && (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MonitoringPreviewMetric
                  label="模板修订号"
                  value={`R${pendingOptimizationReportImport.preview.templateRevision}`}
                />
                <MonitoringPreviewMetric
                  label="新增问题报告"
                  value={String(
                    pendingOptimizationReportImport.preview.questionReports
                      .added,
                  )}
                />
                <MonitoringPreviewMetric
                  label="更新问题报告"
                  value={String(
                    pendingOptimizationReportImport.preview.questionReports
                      .updated,
                  )}
                />
                <MonitoringPreviewMetric
                  label="移除问题报告"
                  value={String(
                    pendingOptimizationReportImport.preview.questionReports
                      .removed,
                  )}
                />
                <MonitoringPreviewMetric
                  label="新增基准"
                  value={String(
                    pendingOptimizationReportImport.preview.questionBaselines
                      .added,
                  )}
                />
                <MonitoringPreviewMetric
                  label="更新基准"
                  value={String(
                    pendingOptimizationReportImport.preview.questionBaselines
                      .updated,
                  )}
                />
                <MonitoringPreviewMetric
                  label="移除基准"
                  value={String(
                    pendingOptimizationReportImport.preview.questionBaselines
                      .removed,
                  )}
                />
                <MonitoringPreviewMetric
                  label="开放优化后效果"
                  value={String(
                    pendingOptimizationReportImport.preview
                      .releasedAfterEffects,
                  )}
                />
              </div>

              <section className="rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] p-4">
                <strong className="text-sm text-[#332842]">
                  文件中的逐问题报告
                </strong>
                {pendingOptimizationReportImport.preview.questions.length >
                0 ? (
                  <ul className="mt-3 space-y-2">
                    {pendingOptimizationReportImport.preview.questions.map(
                      (question) => (
                        <li
                          key={question.id}
                          className="flex items-start justify-between gap-3 rounded-xl border border-[#e8e1ee] bg-white px-3 py-2 text-sm"
                        >
                          <span className="text-[#4d4258]">
                            {question.question}
                          </span>
                          <span
                            className={
                              question.afterEffectReleased
                                ? "shrink-0 rounded-md bg-[#e8f6ef] px-2 py-1 text-xs font-semibold text-[#237a57]"
                                : "shrink-0 rounded-md bg-[#f1edf3] px-2 py-1 text-xs text-[#81778a]"
                            }
                          >
                            {question.afterEffectReleased
                              ? "效果已开放"
                              : "效果未开放"}
                          </span>
                        </li>
                      ),
                    )}
                  </ul>
                ) : (
                  <p className="mt-3 text-xs text-[#81778a]">
                    文件中没有逐问题报告。
                  </p>
                )}
              </section>

              <div className="rounded-2xl border border-[#ead7aa] bg-[#fff8e8] px-4 py-3 text-sm leading-6 text-[#805b08]">
                发布只替换进度报告模块，不修改企业资料、词库、问题目录、监控答案或内容资产。
              </div>

              <div className="flex flex-col-reverse gap-2 border-t border-[#eee8f2] pt-4 sm:flex-row sm:justify-end">
                <Button
                  type="button"
                  variant="outline"
                  disabled={importingKey === "optimization-report"}
                  onClick={() => setPendingOptimizationReportImport(null)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  className="bg-[#5b2a86] hover:bg-[#49216c]"
                  disabled={importingKey === "optimization-report"}
                  onClick={() => void publishOptimizationReportImport()}
                >
                  {importingKey === "optimization-report" && (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  )}
                  确认发布
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function MonitoringPreviewMetric({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="min-w-0 rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] px-4 py-3">
      <span className="block text-xs font-medium text-[#81778a]">{label}</span>
      <strong
        className="mt-1 block overflow-hidden text-ellipsis text-sm font-semibold text-[#221a33]"
        title={value}
      >
        {value}
      </strong>
    </div>
  );
}

function EditorField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-2">
      <span className="text-xs font-semibold text-[#716a80]">{label}</span>
      {children}
    </label>
  );
}

function MetricEditor({
  metrics,
  disabled,
  onChange,
}: {
  metrics: DashboardPayload["metrics"];
  disabled: boolean;
  onChange: (metrics: DashboardPayload["metrics"]) => void;
}) {
  const patchMetric = (
    index: number,
    patch: Partial<DashboardPayload["metrics"][number]>,
  ) => {
    onChange(
      metrics.map((metric, metricIndex) =>
        metricIndex === index ? { ...metric, ...patch } : metric,
      ),
    );
  };

  return (
    <PortalCard className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5 text-[#5b2a86]" />
            <h3 className="font-semibold text-[#171321]">数据卡片</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#716a80]">
            对应客户看板顶部的数据卡片。文档、图片和字数由发布版本自动校准，其他展示数据可直接维护。
          </p>
        </div>
        <Button
          variant="outline"
          disabled={disabled || metrics.length >= 24}
          onClick={() =>
            onChange([
              ...metrics,
              { label: "新指标", value: "", unit: "", note: "" },
            ])
          }
        >
          <Plus className="h-4 w-4" />
          添加数据项
        </Button>
      </div>
      <div className="mt-5 space-y-3">
        {metrics.map((metric, index) => (
          <div
            key={index}
            className="grid gap-3 rounded-2xl border border-[#e8e1ee] bg-[#fbf9fd] p-4 md:grid-cols-[1fr_1fr_100px_1.2fr_auto]"
          >
            <Input
              aria-label={`数据项 ${index + 1} 名称`}
              value={metric.label}
              maxLength={80}
              disabled={disabled}
              placeholder="展示名称"
              onChange={(event) =>
                patchMetric(index, { label: event.target.value })
              }
            />
            <Input
              aria-label={`数据项 ${index + 1} 数值`}
              value={String(metric.value)}
              disabled={disabled}
              placeholder="数值"
              onChange={(event) =>
                patchMetric(index, { value: event.target.value })
              }
            />
            <Input
              aria-label={`数据项 ${index + 1} 单位`}
              value={metric.unit || ""}
              maxLength={24}
              disabled={disabled}
              placeholder="单位"
              onChange={(event) =>
                patchMetric(index, { unit: event.target.value })
              }
            />
            <Input
              aria-label={`数据项 ${index + 1} 说明`}
              value={metric.note || ""}
              maxLength={160}
              disabled={disabled}
              placeholder="数据口径或备注"
              onChange={(event) =>
                patchMetric(index, { note: event.target.value })
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`删除数据项 ${metric.label}`}
              disabled={disabled}
              onClick={() =>
                onChange(
                  metrics.filter((_, metricIndex) => metricIndex !== index),
                )
              }
            >
              <Trash2 className="h-4 w-4 text-[#a33b58]" />
            </Button>
          </div>
        ))}
      </div>
    </PortalCard>
  );
}

function SectionEditor({
  sections,
  disabled,
  importingKey,
  tableImportDisabled,
  onChange,
  onImportTable,
}: {
  sections: DashboardPayload["sections"];
  disabled: boolean;
  importingKey: string;
  tableImportDisabled: boolean;
  onChange: (sections: DashboardPayload["sections"]) => void;
  onImportTable: (sectionId: string, file: File) => void;
}) {
  const patchSection = (
    sectionIndex: number,
    patch: Partial<DashboardPayload["sections"][number]>,
  ) => {
    onChange(
      sections.map((section, index) =>
        index === sectionIndex ? { ...section, ...patch } : section,
      ),
    );
  };

  return (
    <PortalCard className="p-5 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <LayoutTemplate className="h-5 w-5 text-[#5b2a86]" />
            <h3 className="font-semibold text-[#171321]">页面内容</h3>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#716a80]">
            对应上方预览中的每一块内容。可填写说明正文、图文内容和数据表格。
          </p>
        </div>
        <Button
          variant="outline"
          disabled={disabled || sections.length >= 40}
          onClick={() =>
            onChange([
              ...sections,
              {
                id: nextSectionId(sections),
                title: "新展示区域",
                subtitle: "",
                body: "",
                items: [],
                tables: [],
              },
            ])
          }
        >
          <Plus className="h-4 w-4" />
          添加内容区域
        </Button>
      </div>

      <div className="mt-5 space-y-4">
        {sections.map((section, sectionIndex) => (
          <div
            key={sectionIndex}
            className="rounded-2xl border border-[#e3dae9] bg-white p-4 shadow-sm sm:p-5"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="rounded-md bg-[#5b2a86]/8 px-2 py-1 font-mono text-xs text-[#5b2a86]">
                  {section.id}
                </span>
                <p className="mt-2 text-xs text-[#9a94a8]">
                  {section.items.length} 条图文内容 ·{" "}
                  {(section.tables || []).length} 张表格
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`删除内容区域 ${section.title}`}
                disabled={disabled}
                onClick={() =>
                  onChange(
                    sections.filter((_, index) => index !== sectionIndex),
                  )
                }
              >
                <Trash2 className="h-4 w-4 text-[#a33b58]" />
              </Button>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              <EditorField label="区域标识（用于数据关联）">
                <Input
                  value={section.id}
                  maxLength={80}
                  disabled={disabled}
                  onChange={(event) =>
                    patchSection(sectionIndex, { id: event.target.value })
                  }
                />
              </EditorField>
              <EditorField label="区域标题">
                <Input
                  value={section.title}
                  maxLength={160}
                  disabled={disabled}
                  onChange={(event) =>
                    patchSection(sectionIndex, { title: event.target.value })
                  }
                />
              </EditorField>
            </div>
            <div className="mt-3">
              <EditorField label="区域副标题">
                <Input
                  value={section.subtitle || ""}
                  maxLength={300}
                  disabled={disabled}
                  onChange={(event) =>
                    patchSection(sectionIndex, {
                      subtitle: event.target.value,
                    })
                  }
                />
              </EditorField>
            </div>
            <div className="mt-3">
              <EditorField label="区域正文（支持 Markdown）">
                <Textarea
                  value={section.body || ""}
                  rows={4}
                  maxLength={20_000}
                  disabled={disabled}
                  className="resize-y"
                  onChange={(event) =>
                    patchSection(sectionIndex, { body: event.target.value })
                  }
                />
              </EditorField>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-[#eee8f2] pt-4">
              <strong className="text-xs text-[#716a80]">区域图文内容</strong>
              <div className="flex flex-wrap gap-2">
                <SectionTableUploadButton
                  sectionId={section.id}
                  disabled={disabled || tableImportDisabled}
                  importing={importingKey === `section-table:${section.id}`}
                  onFile={(file) => onImportTable(section.id, file)}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={disabled || section.items.length >= 100}
                  onClick={() =>
                    patchSection(sectionIndex, {
                      items: [
                        ...section.items,
                        {
                          title: "新卡片",
                          description: "",
                          meta: "",
                          imageUrl: "",
                        },
                      ],
                    })
                  }
                >
                  <Plus className="h-3.5 w-3.5" />
                  添加图文内容
                </Button>
              </div>
            </div>

            {section.items.length > 0 && (
              <div className="mt-3 grid gap-3 lg:grid-cols-2">
                {section.items.map((item, itemIndex) => (
                  <div
                    key={itemIndex}
                    className="rounded-xl border border-[#eee8f2] bg-[#fbf9fd] p-3"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-xs text-[#716a80]">
                        卡片 {itemIndex + 1}
                      </strong>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        aria-label={`删除卡片 ${item.title}`}
                        disabled={disabled}
                        onClick={() =>
                          patchSection(sectionIndex, {
                            items: section.items.filter(
                              (_, index) => index !== itemIndex,
                            ),
                          })
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5 text-[#a33b58]" />
                      </Button>
                    </div>
                    <div className="mt-2 space-y-2">
                      <Input
                        aria-label={`板块 ${sectionIndex + 1} 卡片 ${itemIndex + 1} 标题`}
                        value={item.title}
                        maxLength={160}
                        disabled={disabled}
                        placeholder="卡片标题"
                        onChange={(event) =>
                          patchSection(sectionIndex, {
                            items: section.items.map((candidate, index) =>
                              index === itemIndex
                                ? { ...candidate, title: event.target.value }
                                : candidate,
                            ),
                          })
                        }
                      />
                      <Textarea
                        aria-label={`板块 ${sectionIndex + 1} 卡片 ${itemIndex + 1} 内容`}
                        value={item.description || ""}
                        rows={3}
                        maxLength={4_000}
                        disabled={disabled}
                        placeholder="卡片内容"
                        onChange={(event) =>
                          patchSection(sectionIndex, {
                            items: section.items.map((candidate, index) =>
                              index === itemIndex
                                ? {
                                    ...candidate,
                                    description: event.target.value,
                                  }
                                : candidate,
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label={`板块 ${sectionIndex + 1} 卡片 ${itemIndex + 1} 备注`}
                        value={item.meta || ""}
                        maxLength={160}
                        disabled={disabled}
                        placeholder="时间、来源或状态说明"
                        onChange={(event) =>
                          patchSection(sectionIndex, {
                            items: section.items.map((candidate, index) =>
                              index === itemIndex
                                ? { ...candidate, meta: event.target.value }
                                : candidate,
                            ),
                          })
                        }
                      />
                      <Input
                        aria-label={`板块 ${sectionIndex + 1} 卡片 ${itemIndex + 1} 图片`}
                        value={item.imageUrl || ""}
                        maxLength={2_048}
                        disabled={disabled}
                        placeholder="图片 URL"
                        onChange={(event) =>
                          patchSection(sectionIndex, {
                            items: section.items.map((candidate, index) =>
                              index === itemIndex
                                ? {
                                    ...candidate,
                                    imageUrl: event.target.value,
                                  }
                                : candidate,
                            ),
                          })
                        }
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </PortalCard>
  );
}

function SectionTableUploadButton({
  sectionId,
  disabled,
  importing,
  onFile,
}: {
  sectionId: string;
  disabled: boolean;
  importing: boolean;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={disabled || importing || !sectionId.trim()}
        onClick={() => inputRef.current?.click()}
      >
        {importing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Table2 className="h-3.5 w-3.5" />
        )}
        上传板块表格
      </Button>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".csv,.xlsx,text/csv"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </>
  );
}

function KnowledgeInlineActions({
  uploading,
  onFile,
}: {
  uploading: boolean;
  onFile: (file: File) => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button
        size="sm"
        className="bg-[#5b2a86] hover:bg-[#49216c]"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        {uploading ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <UploadCloud className="h-3.5 w-3.5" />
        )}
        上传知识库
      </Button>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept=".zip,.md,.markdown,.txt,.json,.csv,.html,.htm"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void onFile(file);
          event.target.value = "";
        }}
      />
    </>
  );
}

function ModuleInlineActions({
  definition,
  disabled,
  importing,
  onTemplate,
  onFile,
}: {
  definition: ImportCardDefinition;
  disabled: boolean;
  importing: boolean;
  onTemplate: () => void;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <span className="text-xs font-semibold text-[#5b2a86]">
        {definition.title}
      </span>
      <Button
        size="sm"
        variant="outline"
        disabled={importing}
        onClick={onTemplate}
      >
        下载当前数据
      </Button>
      <Button
        size="sm"
        className="bg-[#5b2a86] hover:bg-[#49216c]"
        disabled={disabled || importing}
        onClick={() => inputRef.current?.click()}
      >
        {importing ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <UploadCloud className="h-3.5 w-3.5" />
        )}
        上传修改
      </Button>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept={definition.accept}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </div>
  );
}

function ModuleUploadCard({
  definition,
  disabled,
  importing,
  onPreview,
  onTemplate,
  onFile,
}: {
  definition: ImportCardDefinition;
  disabled: boolean;
  importing: boolean;
  onPreview: () => void;
  onTemplate: () => void;
  onFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const Icon = definition.icon;
  return (
    <article className="flex min-h-[210px] flex-col rounded-2xl border border-[#e5ddea] bg-[#fbf9fd] p-4">
      <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#5b2a86]/10 text-[#5b2a86]">
        <Icon className="h-5 w-5" />
      </span>
      <strong className="mt-4 text-sm text-[#221a33]">
        {definition.title}
      </strong>
      <p className="mt-2 flex-1 text-xs leading-5 text-[#716a80]">
        {definition.description}
      </p>
      <div className="mt-4 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-[#9a94a8]">
          {definition.format}
        </span>
        <div className="flex gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            disabled={importing}
            onClick={onPreview}
          >
            <Eye className="h-3.5 w-3.5" />
            预览
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={importing}
            onClick={onTemplate}
          >
            下载当前内容模板
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || importing}
            onClick={() => inputRef.current?.click()}
          >
            {importing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <UploadCloud className="h-3.5 w-3.5" />
            )}
            上传并预览
          </Button>
        </div>
      </div>
      <input
        ref={inputRef}
        hidden
        type="file"
        accept={definition.accept}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFile(file);
          event.target.value = "";
        }}
      />
    </article>
  );
}

function dashboardModulesForSection(
  section: CustomerDashboardMirrorSection,
): Array<Exclude<DashboardImportModule, "section-table">> {
  if (section === "home") return ["profile", "metrics", "sections"];
  if (section === "keywords") return ["keywords"];
  if (section === "questions") return ["questions"];
  if (section === "response-logic") return ["response-logic"];
  if (section === "monitoring") return ["monitoring"];
  if (section === "report") return ["optimization-report"];
  if (section === "content") return ["content-assets"];
  return [];
}

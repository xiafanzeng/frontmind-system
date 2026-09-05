import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronRight,
  ExternalLink,
  FileText,
  History,
  Inbox,
  Link2,
  Loader2,
  LockKeyhole,
  MessageSquare,
  Paperclip,
  PanelRightOpen,
  RefreshCw,
  Save,
  Search,
  Send,
  SlidersHorizontal,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";
import { useLocation } from "wouter";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { uploadFile } from "@/lib/frontmind-api";
import { deliveryTicketDisplayDescription } from "@/lib/delivery-workflow";
import { trpc } from "@/lib/trpc";
import { deliveryWorkbenchHref } from "@/pages/DeliveryMemberDashboard";
import { type DeliveryTicketStatus } from "@shared/delivery-ticket";
import { getDeliveryOperationSpec } from "@shared/delivery-operation-spec";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
  type DeliveryWorkflowOperation,
} from "@shared/delivery-roles";
import {
  deliveryActorRoleLabel,
  deliveryCategoryLabel,
  deliveryEventDisplayMessage,
  deliveryOperationLabel,
  deliveryStatusTransitionLabel,
  deliveryTicketPresentationTitle,
  deliveryTicketPresentationTopic,
  deliveryTicketStatusLabel,
} from "@shared/delivery-ticket-presentation";

import "./admin-delivery-ticket-workspace.css";

const CUSTOMER_DASHBOARD_BUTTON_CLASS =
  "border-blue-600 bg-blue-600 text-white hover:border-blue-700 hover:bg-blue-700 hover:text-white focus-visible:border-blue-600 focus-visible:ring-blue-600/30 dark:border-blue-500 dark:bg-blue-600 dark:hover:bg-blue-700";

export type AdminDeliveryTicket = {
  id: string;
  userId?: number | null;
  enterpriseName?: string | null;
  assignedAdminId?: number | null;
  assignedAdminName?: string | null;
  type: "content_asset" | "website_operation" | "knowledge_base";
  category?: string | null;
  categoryLabel?: string | null;
  parentTicketId?: string | null;
  rootTicketId?: string | null;
  isWorkflowContainer?: boolean | null;
  workflowDomain?: DeliveryRoleType | null;
  operation?: DeliveryWorkflowOperation | null;
  assignedProjectAssignmentId?: string | null;
  assignedMemberId?: number | null;
  assignedMemberName?: string | null;
  priority?: "low" | "normal" | "high" | "urgent" | null;
  title?: string | null;
  topic?: string | null;
  description?: string | null;
  targetUrl?: string | null;
  targetPage?: string | null;
  knowledgeSnapshotId?: string | null;
  status: DeliveryTicketStatus | "unknown";
  publicStatus?: "pending" | "completed" | null;
  publicStatusLabel?: string | null;
  preferredMedia?: string | null;
  icpDeclarations?: {
    icpNumber?: string | null;
  } | null;
  publicSummary?: string | null;
  deliveryLinks?: Array<{ label: string; url: string }>;
  quotaPool?: string | null;
  quotaState?: "reserved" | "consumed" | "released" | null;
  revision: number;
  createdAt?: number | string | Date | null;
  updatedAt?: number | string | Date | null;
  resultUrl?: string | null;
  resultSummary?: string | null;
};

type AdminDeliveryTicketEvent = {
  id: string;
  visibility: "customer" | "internal";
  actorRole?: string | null;
  eventType?: string | null;
  message?: string | null;
  statusFrom?: string | null;
  statusTo?: string | null;
  actorLabel?: string | null;
  createdAt?: number | string | Date | null;
  attachments?: Array<{
    id?: string;
    filename?: string | null;
    url?: string | null;
    fileId?: string | null;
  }>;
};

type TicketDetailPayload = {
  ticket: AdminDeliveryTicket;
  events: AdminDeliveryTicketEvent[];
  attachments?: AdminDeliveryTicketEvent["attachments"];
  deliveryRecords?: Array<{
    id: string;
    platform?: string | null;
    targetUrl?: string | null;
    executedAt?: number | string | Date | null;
    resultStatus?: "success" | "failed" | "pending_confirmation" | string;
    platformMessage?: string | null;
    attachments?: AdminDeliveryTicketEvent["attachments"];
  }>;
  workflowRelations?: {
    root: AdminDeliveryWorkflowRelation | null;
    children: AdminDeliveryWorkflowRelation[];
  };
};

type AdminDeliveryWorkflowRelation = {
  id: string;
  parentTicketId: string | null;
  rootTicketId: string | null;
  operation: string | null;
  status: string;
  workflowDomain: DeliveryRoleType | null;
  assignedMemberId: number | null;
  assignedMemberName: string | null;
};

export type AdminDeliveryTicketPreviewFixtures = {
  tickets: AdminDeliveryTicket[];
  events: AdminDeliveryTicketEvent[];
  periodId: string;
  revision: number;
  contentAssetQuota: {
    used: number;
    reserved: number;
    consumed: number;
    limit: number;
  };
  websiteContentQuota: {
    used: number;
    reserved: number;
    consumed: number;
    limit: number;
  };
};

const STATUS_ORDER: DeliveryTicketStatus[] = [
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
  "completed",
  "rejected",
  "cancelled",
];

const OPEN_TICKET_STATUSES = new Set<string>([
  "submitted",
  "needs_information",
  "scheduled",
  "in_progress",
]);

export type AdminDeliveryTicketPublicStatus = "pending" | "completed";

export const ADMIN_DELIVERY_TICKET_PUBLIC_STATUS_LABELS: Record<
  AdminDeliveryTicketPublicStatus,
  string
> = Object.freeze({
  pending: "待处理",
  completed: "已结束",
});

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === "object"
    ? (value as Record<string, any>)
    : {};
}

export function safeAdminDeliveryUrl(
  value: string | null | undefined,
  origin = typeof window === "undefined"
    ? "http://localhost"
    : window.location.origin,
) {
  if (!value) return null;
  try {
    const url = new URL(value, origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return value.startsWith("/")
      ? `${url.pathname}${url.search}${url.hash}`
      : url.toString();
  } catch {
    return null;
  }
}

export function normalizeAdminTicketList(
  value: unknown,
): AdminDeliveryTicket[] {
  const payload = asRecord(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(payload.tickets)
      ? payload.tickets
      : Array.isArray(payload.items)
        ? payload.items
        : [];
  return source
    .map((entry: unknown) => {
      const ticket = asRecord(entry);
      const status = STATUS_ORDER.includes(ticket.status)
        ? ticket.status
        : "unknown";
      const type =
        ticket.type === "website_operation" || ticket.type === "knowledge_base"
          ? ticket.type
          : "content_asset";
      return {
        ...ticket,
        id: String(ticket.id || ""),
        type,
        status,
        publicStatus:
          ticket.publicStatus === "completed" ||
          ticket.publicStatus === "pending"
            ? ticket.publicStatus
            : undefined,
        revision: Number(ticket.revision || 1),
        targetUrl: ticket.targetUrl ?? ticket.targetPage ?? null,
        preferredMedia: ticket.preferredMedia ?? null,
        publicSummary: ticket.publicSummary ?? ticket.resultSummary ?? null,
        deliveryLinks: Array.isArray(ticket.deliveryLinks)
          ? ticket.deliveryLinks
          : [],
      } as AdminDeliveryTicket;
    })
    .filter((ticket: AdminDeliveryTicket) => Boolean(ticket.id));
}

export function flattenAdminTicketPages(
  pages: readonly unknown[] | null | undefined,
) {
  const seen = new Set<string>();
  return (pages || [])
    .flatMap((page) => normalizeAdminTicketList(page))
    .filter((ticket) => {
      if (seen.has(ticket.id)) return false;
      seen.add(ticket.id);
      return true;
    });
}

export function mergeAdminTicketPages(
  pages: readonly unknown[] | null | undefined,
) {
  const firstPage = asRecord(pages?.[0]);
  return {
    ...firstPage,
    tickets: flattenAdminTicketPages(pages),
  };
}

export function buildAdminTicketListInput(input: {
  userId?: number | null;
  assignedAdminId?: number | string | null;
  query?: string | null;
  type?: string | null;
  status?: string | null;
  publicStatus?: string | null;
  limit?: number;
  order?: "updated_desc" | "created_asc";
}) {
  const result: {
    userId?: number;
    assignedAdminId?: number;
    query?: string;
    type?: AdminDeliveryTicket["type"];
    status?: DeliveryTicketStatus;
    publicStatus?: "pending" | "completed";
    limit: number;
    order?: "updated_desc" | "created_asc";
  } = {
    limit: Math.min(100, Math.max(1, input.limit ?? 20)),
  };
  if (Number.isInteger(input.userId) && Number(input.userId) > 0) {
    result.userId = Number(input.userId);
  }
  const assignedAdminId = Number(input.assignedAdminId);
  if (Number.isInteger(assignedAdminId) && assignedAdminId > 0) {
    result.assignedAdminId = assignedAdminId;
  }
  const query = input.query?.trim();
  if (query) result.query = query.slice(0, 100);
  if (
    input.type === "content_asset" ||
    input.type === "website_operation" ||
    input.type === "knowledge_base"
  ) {
    result.type = input.type;
  }
  if (
    input.status &&
    STATUS_ORDER.includes(input.status as DeliveryTicketStatus)
  ) {
    result.status = input.status as DeliveryTicketStatus;
  }
  if (input.publicStatus === "pending" || input.publicStatus === "completed") {
    result.publicStatus = input.publicStatus;
  }
  if (input.order) result.order = input.order;
  return result;
}

export function deliveryTicketPublicStatus(
  ticket:
    | Pick<AdminDeliveryTicket, "status" | "publicStatus">
    | null
    | undefined,
): "pending" | "completed" {
  if (
    ticket?.publicStatus === "pending" ||
    ticket?.publicStatus === "completed"
  ) {
    return ticket.publicStatus;
  }
  if (!ticket || ticket.status === "unknown") return "pending";
  return OPEN_TICKET_STATUSES.has(ticket.status) ? "pending" : "completed";
}

export function adminDeliveryTicketPublicStatusLabel(
  ticket:
    | Pick<AdminDeliveryTicket, "status" | "publicStatus">
    | null
    | undefined,
) {
  if (!ticket || ticket.status === "unknown") return "未知状态";
  return deliveryTicketStatusLabel(ticket.status, "internal");
}

export function adminDeliveryEventPublicStatusLabel(
  status: string | null | undefined,
) {
  if (!STATUS_ORDER.includes(status as DeliveryTicketStatus)) return null;
  return deliveryTicketStatusLabel(status, "internal");
}

export function adminDeliveryEventActorLabel(
  event: Pick<AdminDeliveryTicketEvent, "actorRole" | "actorLabel">,
) {
  const actorRole = event.actorRole?.trim();
  if (actorRole) return deliveryActorRoleLabel(actorRole, "internal");
  const actorLabel = event.actorLabel?.trim();
  if (!actorLabel) return "相关人员";
  return /[\u3400-\u9fff]/u.test(actorLabel) ? actorLabel : "相关人员";
}

export function normalizeTicketDetail(
  value: unknown,
  fallback?: AdminDeliveryTicket,
): TicketDetailPayload | null {
  const payload = asRecord(value);
  const ticketCandidate = payload.ticket ?? payload.item ?? fallback;
  if (!ticketCandidate) return null;
  const [ticket] = normalizeAdminTicketList([ticketCandidate]);
  if (!ticket) return null;
  const events = Array.isArray(payload.events)
    ? payload.events.map((event: unknown, index: number) => {
        const record = asRecord(event);
        return {
          ...record,
          id: String(record.id || `event-${index}`),
          visibility:
            record.visibility === "internal" ? "internal" : "customer",
          statusFrom: record.statusFrom ?? record.fromStatus ?? null,
          statusTo: record.statusTo ?? record.toStatus ?? null,
        } as AdminDeliveryTicketEvent;
      })
    : [];
  const normalizeWorkflowRelation = (
    value: unknown,
  ): AdminDeliveryWorkflowRelation | null => {
    const relation = asRecord(value);
    const id = typeof relation.id === "string" ? relation.id.trim() : "";
    if (!id) return null;
    const workflowDomain = [
      "ai_operations_engineer",
      "monitoring_optimization_engineer",
      "content_distribution_engineer",
    ].includes(String(relation.workflowDomain || ""))
      ? (relation.workflowDomain as DeliveryRoleType)
      : null;
    const assignedMemberId = Number(relation.assignedMemberId);
    return {
      id,
      parentTicketId:
        typeof relation.parentTicketId === "string"
          ? relation.parentTicketId
          : null,
      rootTicketId:
        typeof relation.rootTicketId === "string"
          ? relation.rootTicketId
          : null,
      operation:
        typeof relation.operation === "string" ? relation.operation : null,
      status: typeof relation.status === "string" ? relation.status : "unknown",
      workflowDomain,
      assignedMemberId:
        Number.isSafeInteger(assignedMemberId) && assignedMemberId > 0
          ? assignedMemberId
          : null,
      assignedMemberName:
        typeof relation.assignedMemberName === "string" &&
        relation.assignedMemberName.trim()
          ? relation.assignedMemberName.trim()
          : null,
    };
  };
  const workflowRelations = asRecord(payload.workflowRelations);
  const rootRelation = normalizeWorkflowRelation(workflowRelations.root);
  const childRelations = Array.isArray(workflowRelations.children)
    ? workflowRelations.children.flatMap((relation) => {
        const normalized = normalizeWorkflowRelation(relation);
        return normalized ? [normalized] : [];
      })
    : [];
  return {
    ticket,
    events,
    attachments: Array.isArray(payload.attachments)
      ? payload.attachments.map((attachment: unknown) => {
          const record = asRecord(attachment);
          return {
            ...record,
            url: record.url ?? record.downloadUrl ?? null,
          };
        })
      : [],
    deliveryRecords: Array.isArray(payload.deliveryRecords)
      ? payload.deliveryRecords
      : Array.isArray(payload.deliveries)
        ? payload.deliveries
        : Array.isArray(payload.operationRecords)
          ? payload.operationRecords
          : events
              .filter((event) => asRecord(event).operationResult)
              .map((event) => ({
                id: event.id,
                ...asRecord(asRecord(event).operationResult),
                executedAt:
                  asRecord(asRecord(event).operationResult).executedAt ??
                  event.createdAt,
              })),
    ...(rootRelation || childRelations.length
      ? {
          workflowRelations: {
            root: rootRelation,
            children: childRelations,
          },
        }
      : {}),
  };
}

export function isCustomerVisibleEvent(event: AdminDeliveryTicketEvent) {
  return event.visibility !== "internal";
}

export function formatAdminTicketDate(
  value: number | string | Date | null | undefined,
) {
  if (!value) return "时间未记录";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未记录";
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function presentedTicketTitle(ticket: {
  title?: string | null;
  topic?: string | null;
  type?: AdminDeliveryTicket["type"];
  operation?: string | null;
  category?: string | null;
  categoryLabel?: string | null;
}) {
  const rawTitle = ticket.title?.trim() || ticket.topic?.trim();
  if (rawTitle) {
    return deliveryTicketPresentationTitle({ ...ticket, title: rawTitle });
  }
  if (
    ticket.operation === "question_catalog" ||
    ticket.category === "question_catalog"
  ) {
    return deliveryTicketPresentationTitle(ticket);
  }
  return "未命名需求";
}

function ticketTitle(ticket: AdminDeliveryTicket) {
  return presentedTicketTitle(ticket);
}

function ticketTopic(ticket: AdminDeliveryTicket) {
  if (!ticket.topic?.trim()) return null;
  const topic = deliveryTicketPresentationTopic(ticket);
  return topic === ticketTitle(ticket) ? null : topic;
}

export function ticketTypeLabel(
  type: AdminDeliveryTicket["type"],
  operation?: AdminDeliveryTicket["operation"] | string | null,
) {
  const value = operation?.trim();
  const operationSpec = value ? getDeliveryOperationSpec(value) : null;
  if (operationSpec) return operationSpec.label;
  if (value) {
    const categoryLabel = deliveryCategoryLabel({ type, category: value });
    const genericCategoryLabel = deliveryCategoryLabel({ type });
    if (categoryLabel !== genericCategoryLabel) return categoryLabel;
    return "历史交付任务";
  }
  if (type === "knowledge_base") return "品牌知识库";
  return type === "website_operation" ? "官网运营" : "内容资产";
}

export function buildSystemAdminTicketWorkbenchHref(ticket: {
  id: string;
  operation?: string | null;
  category?: string | null;
  assignedProjectAssignmentId?: string | null;
}) {
  const projectAssignmentId = ticket.assignedProjectAssignmentId?.trim();
  if (!projectAssignmentId) return null;
  return deliveryWorkbenchHref({
    projectAssignmentId,
    ticketId: ticket.id,
    operation: ticket.operation ?? ticket.category,
    systemAdminMode: true,
  });
}

export function permanentDeliveryTicketDeletionConfirmation(ticket: {
  title?: string | null;
  topic?: string | null;
  operation?: string | null;
  category?: string | null;
}) {
  const title = presentedTicketTitle(ticket);
  return `确认永久删除需求“${title}”？关联附件、官网样例与需求处理记录也会永久删除；删除后用户、工程师和管理员的列表中都不再展示，且无法恢复。`;
}

function StatusPill({
  ticket,
}: {
  ticket: Pick<AdminDeliveryTicket, "status" | "publicStatus">;
}) {
  const status = deliveryTicketPublicStatus(ticket);
  const isPendingTicket = status === "pending";
  return (
    <span
      className={`admin-ticket-status is-${ticket.status}${isPendingTicket ? " is-pending-alert" : ""}`}
    >
      {adminDeliveryTicketPublicStatusLabel(ticket)}
    </span>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="admin-ticket-empty">
      <Inbox className="h-6 w-6" />
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}

function Timeline({
  title,
  description,
  events,
  internal = false,
}: {
  title: string;
  description: string;
  events: AdminDeliveryTicketEvent[];
  internal?: boolean;
}) {
  return (
    <section
      className={`admin-ticket-timeline ${internal ? "is-internal" : ""}`}
    >
      <header>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
        {internal ? (
          <LockKeyhole className="h-4 w-4" />
        ) : (
          <MessageSquare className="h-4 w-4" />
        )}
      </header>
      {events.length ? (
        <div className="admin-ticket-timeline-list">
          {events.map((event) => {
            const transitionLabel =
              event.statusFrom != null || event.statusTo != null
                ? deliveryStatusTransitionLabel(
                    event.statusFrom,
                    event.statusTo,
                    "internal",
                  )
                : null;
            const displayMessage = deliveryEventDisplayMessage(
              {
                message: event.message,
                eventType: event.eventType,
                fromStatus: event.statusFrom,
                toStatus: event.statusTo,
              },
              "internal",
            );
            return (
              <article key={event.id}>
                <div>
                  <strong>{adminDeliveryEventActorLabel(event)}</strong>
                  <time>{formatAdminTicketDate(event.createdAt)}</time>
                </div>
                {transitionLabel && (
                  <span className="admin-ticket-event-label">
                    {transitionLabel}
                  </span>
                )}
                {displayMessage !== transitionLabel && <p>{displayMessage}</p>}
                {event.attachments?.length ? (
                  <div className="admin-ticket-attachment-list">
                    {event.attachments.map((attachment, index) => (
                      <a
                        key={attachment.id || attachment.fileId || index}
                        href={safeAdminDeliveryUrl(attachment.url) || undefined}
                        target={
                          safeAdminDeliveryUrl(attachment.url)
                            ? "_blank"
                            : undefined
                        }
                        rel={
                          safeAdminDeliveryUrl(attachment.url)
                            ? "noopener noreferrer"
                            : undefined
                        }
                        aria-disabled={!safeAdminDeliveryUrl(attachment.url)}
                      >
                        <Paperclip className="h-3.5 w-3.5" />
                        {attachment.filename || "交付文件"}
                      </a>
                    ))}
                  </div>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <p className="admin-ticket-timeline-empty">
          {internal ? "暂无内部备注。" : "暂无客户可见交流记录。"}
        </p>
      )}
    </section>
  );
}

export default function AdminDeliveryTicketWorkspace({
  userId,
  enterpriseName,
  customerUsername,
  servicePlanCode,
  serviceStatus,
  canAdjustQuota = false,
  canExecuteDelivery = false,
  onOpenCustomerDashboard,
  preview = false,
  previewFixtures,
}: {
  userId: number;
  enterpriseName?: string | null;
  customerUsername?: string | null;
  servicePlanCode?: string | null;
  serviceStatus?: string | null;
  canAdjustQuota?: boolean;
  canExecuteDelivery?: boolean;
  onOpenCustomerDashboard?: () => void;
  preview?: boolean;
  previewFixtures?: AdminDeliveryTicketPreviewFixtures;
}) {
  const previewMode = import.meta.env.DEV && preview;
  const [, setLocation] = useLocation();
  const api = (trpc.admin as any).deliveryTickets;
  const quotaAdmin = canAdjustQuota;
  const [previewQuotaLimits, setPreviewQuotaLimits] = useState({
    contentAssetPublishLimit: previewFixtures?.contentAssetQuota.limit ?? 0,
    websiteContentPublishLimit: previewFixtures?.websiteContentQuota.limit ?? 0,
    revision: previewFixtures?.revision ?? 0,
  });
  const initialTicketId = useMemo(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("ticketId") || "";
  }, []);
  const [selectedTicketId, setSelectedTicketId] = useState(initialTicketId);
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState<
    "all" | AdminDeliveryTicketPublicStatus
  >("all");
  const [keyword, setKeyword] = useState("");
  const [debouncedKeyword, setDebouncedKeyword] = useState("");

  useEffect(() => {
    const timeout = window.setTimeout(
      () => setDebouncedKeyword(keyword.trim()),
      250,
    );
    return () => window.clearTimeout(timeout);
  }, [keyword]);

  const listInput = useMemo(
    () =>
      buildAdminTicketListInput({
        userId,
        query: debouncedKeyword,
        type: typeFilter,
        publicStatus: statusFilter,
        limit: 20,
      }),
    [debouncedKeyword, statusFilter, typeFilter, userId],
  );
  const listQuery = api.list.useInfiniteQuery(listInput, {
    enabled: !previewMode && userId > 0,
    retry: false,
    getNextPageParam: (lastPage: any) => lastPage?.nextCursor || undefined,
  });
  const adjustQuotaMutation = api.adjustQuota.useMutation();
  const previewListData = {
    tickets: previewFixtures?.tickets ?? [],
    quotas: {
      contentAssetPublish: {
        allowed: true,
        used: previewFixtures?.contentAssetQuota.used ?? 0,
        reserved: previewFixtures?.contentAssetQuota.reserved ?? 0,
        consumed: previewFixtures?.contentAssetQuota.consumed ?? 0,
        limit: previewQuotaLimits.contentAssetPublishLimit,
        periodId: previewFixtures?.periodId ?? "",
        revision: previewQuotaLimits.revision,
      },
      websiteContentPublish: {
        allowed: true,
        used: previewFixtures?.websiteContentQuota.used ?? 0,
        reserved: previewFixtures?.websiteContentQuota.reserved ?? 0,
        consumed: previewFixtures?.websiteContentQuota.consumed ?? 0,
        limit: previewQuotaLimits.websiteContentPublishLimit,
        periodId: previewFixtures?.periodId ?? "",
        revision: previewQuotaLimits.revision,
      },
    },
  };
  const listPages = (listQuery.data?.pages || []) as unknown[];
  const listData = previewMode
    ? previewListData
    : mergeAdminTicketPages(listPages);
  const quotaPayload = asRecord(asRecord(listData).quotas);
  const contentQuota = asRecord(
    quotaPayload.contentAssetPublish ||
      quotaPayload.content_asset_publish ||
      quotaPayload.contentAsset,
  );
  const websiteQuota = asRecord(
    quotaPayload.websiteContentPublish ||
      quotaPayload.website_content_publish ||
      quotaPayload.websiteContent,
  );
  const quotaPeriodId = String(
    contentQuota.periodId || websiteQuota.periodId || "",
  );
  const quotaRevision = Number(
    contentQuota.revision ?? websiteQuota.revision ?? 0,
  );
  // The administrator overview is intentionally read-only. Quota and delivery
  // mutations remain available only in the dedicated role workbenches.
  const quotaAdjustmentAvailable = false;
  const [quotaEditing, setQuotaEditing] = useState(false);
  const [contentQuotaLimit, setContentQuotaLimit] = useState(0);
  const [websiteQuotaLimit, setWebsiteQuotaLimit] = useState(0);
  const tickets = useMemo(
    () =>
      previewMode
        ? normalizeAdminTicketList(previewListData)
        : flattenAdminTicketPages(listPages),
    [listPages, previewMode],
  );
  const ticketListResolved = previewMode || listQuery.data !== undefined;
  useEffect(() => {
    if (!ticketListResolved || selectedTicketId) return;
    setSelectedTicketId(tickets[0]?.id || "");
  }, [selectedTicketId, ticketListResolved, tickets]);

  useEffect(() => {
    if (quotaEditing) return;
    setContentQuotaLimit(Number(contentQuota.limit ?? 0));
    setWebsiteQuotaLimit(Number(websiteQuota.limit ?? 0));
  }, [contentQuota.limit, quotaEditing, websiteQuota.limit]);

  const selectedTicket =
    tickets.find((ticket) => ticket.id === selectedTicketId) || null;
  const detailQuery = api.detail.useQuery(
    {
      userId,
      ticketId: selectedTicketId || "00000000-0000-0000-0000-000000000000",
    },
    {
      enabled: !previewMode && Boolean(selectedTicketId),
      retry: false,
    },
  );
  const deleteMutation = api.delete.useMutation();
  const detail = previewMode
    ? selectedTicket
      ? {
          ticket: selectedTicket,
          events: previewFixtures?.events ?? [],
        }
      : null
    : normalizeTicketDetail(detailQuery.data, selectedTicket || undefined);
  const isDomainApplication = detail?.ticket.category === "domain_application";
  const updateMutation = api.update.useMutation();
  const addMessageMutation = api.addMessage.useMutation();
  const recordDeliveryMutation = api.recordDelivery.useMutation();
  const [publicReply, setPublicReply] = useState("");
  const [publicSummary, setPublicSummary] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [publicFiles, setPublicFiles] = useState<File[]>([]);
  const [deliveryPlatform, setDeliveryPlatform] = useState("");
  const [deliveryTargetUrl, setDeliveryTargetUrl] = useState("");
  const [deliveryExecutedAt, setDeliveryExecutedAt] = useState("");
  const [deliveryResultStatus, setDeliveryResultStatus] = useState<
    "success" | "failed" | "pending_confirmation"
  >("pending_confirmation");
  const [deliveryPlatformMessage, setDeliveryPlatformMessage] = useState("");
  const [deliveryFiles, setDeliveryFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [maintenanceUploading, setMaintenanceUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deliveryFileInputRef = useRef<HTMLInputElement>(null);
  const maintenanceFileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setPublicReply("");
    setPublicSummary(detail?.ticket.publicSummary || "");
    setInternalNote("");
    setPublicFiles([]);
    setDeliveryPlatform(detail?.ticket.deliveryLinks?.[0]?.label || "");
    setDeliveryTargetUrl(detail?.ticket.deliveryLinks?.[0]?.url || "");
    setDeliveryExecutedAt("");
    setDeliveryResultStatus("pending_confirmation");
    setDeliveryPlatformMessage("");
    setDeliveryFiles([]);
  }, [
    detail?.ticket.deliveryLinks?.[0]?.label,
    detail?.ticket.deliveryLinks?.[0]?.url,
    detail?.ticket.id,
    detail?.ticket.publicSummary,
    detail?.ticket.status,
  ]);

  const filteredTickets = useMemo(() => {
    if (!previewMode) return tickets;
    return tickets.filter((ticket) => {
      if (typeFilter !== "all" && ticket.type !== typeFilter) return false;
      if (
        statusFilter !== "all" &&
        deliveryTicketPublicStatus(ticket) !== statusFilter
      ) {
        return false;
      }
      const query = keyword.trim().toLocaleLowerCase("zh-CN");
      if (!query) return true;
      return [
        ticket.enterpriseName,
        ticket.title,
        ticket.topic,
        ticket.category,
      ].some((value) =>
        String(value || "")
          .toLocaleLowerCase("zh-CN")
          .includes(query),
      );
    });
  }, [keyword, previewMode, statusFilter, tickets, typeFilter]);

  const refresh = async () => {
    if (previewMode) return;
    await Promise.all([
      listQuery.refetch(),
      selectedTicketId ? detailQuery.refetch() : Promise.resolve(),
    ]);
  };

  const saveQuotaLimits = async () => {
    const contentUsed = Number(contentQuota.used ?? 0);
    const websiteUsed = Number(websiteQuota.used ?? 0);
    if (
      !Number.isInteger(contentQuotaLimit) ||
      !Number.isInteger(websiteQuotaLimit) ||
      contentQuotaLimit < 0 ||
      websiteQuotaLimit < 0
    ) {
      toast.error("额度必须填写为非负整数");
      return;
    }
    if (contentQuotaLimit < contentUsed || websiteQuotaLimit < websiteUsed) {
      toast.error("新额度不能低于当前已消耗与已预留数量");
      return;
    }
    if (previewMode) {
      setPreviewQuotaLimits((current) => ({
        contentAssetPublishLimit: contentQuotaLimit,
        websiteContentPublishLimit: websiteQuotaLimit,
        revision: current.revision + 1,
      }));
      setQuotaEditing(false);
      toast.success("服务周期额度已更新（预览）");
      return;
    }
    if (!quotaPeriodId || quotaRevision < 1) {
      toast.error("当前服务周期尚未同步，暂时不能调整额度");
      return;
    }
    try {
      await adjustQuotaMutation.mutateAsync({
        userId,
        quotaPeriodId,
        expectedRevision: quotaRevision,
        contentAssetPublishLimit: contentQuotaLimit,
        websiteContentPublishLimit: websiteQuotaLimit,
        reason: "系统管理员在客户交付工作台调整服务周期额度",
      });
      await refresh();
      setQuotaEditing(false);
      toast.success("服务周期额度已更新");
    } catch (error) {
      toast.error("额度调整失败", {
        description: error instanceof Error ? error.message : "请刷新后重试。",
      });
    }
  };

  const selectTicket = (ticket: AdminDeliveryTicket) => {
    const workbenchHref =
      canExecuteDelivery && deliveryTicketPublicStatus(ticket) === "pending"
        ? buildSystemAdminTicketWorkbenchHref(ticket)
        : null;
    if (workbenchHref) {
      setLocation(workbenchHref);
      return;
    }
    const ticketId = ticket.id;
    setSelectedTicketId(ticketId);
    if (!previewMode) {
      setLocation(
        `/admin/customers/${userId}/workspace?ticketId=${encodeURIComponent(ticketId)}`,
      );
    }
  };

  const deleteTicket = async (ticket: AdminDeliveryTicket) => {
    if (!canExecuteDelivery) return;
    if (!window.confirm(permanentDeliveryTicketDeletionConfirmation(ticket))) {
      return;
    }
    if (previewMode) {
      toast.info("预览环境不会删除需求");
      return;
    }
    try {
      await deleteMutation.mutateAsync({
        userId,
        ticketId: ticket.id,
        expectedRevision: ticket.revision,
        confirmation: "DELETE_TICKET",
      });
      if (selectedTicketId === ticket.id) setSelectedTicketId("");
      await listQuery.refetch();
      toast.success("需求已永久删除");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "需求删除失败，请刷新后重试",
      );
    }
  };

  const updateStatus = async () => {
    if (!detail?.ticket) return;
    const summary = publicSummary.trim();
    const contentAssetTicket = detail.ticket.type === "content_asset";
    const platform = contentAssetTicket ? deliveryPlatform.trim() : "";
    const targetUrl = contentAssetTicket ? deliveryTargetUrl.trim() : "";
    if (!summary) {
      toast.error(
        isDomainApplication
          ? "完成域名需求前请填写要返回给客户的备案服务码"
          : "完成需求前请填写公开内容总结",
      );
      return;
    }
    if ((platform && !targetUrl) || (!platform && targetUrl)) {
      toast.error("发布媒体名称与媒体链接需要同时填写");
      return;
    }
    let deliveryLinks: Array<{ label: string; url: string }> | undefined;
    if (platform && targetUrl) {
      try {
        deliveryLinks = [
          { label: platform, url: new URL(targetUrl).toString() },
        ];
      } catch {
        toast.error("媒体链接格式不正确");
        return;
      }
    }
    if (previewMode) {
      toast.success("需求状态已更新（预览）");
      return;
    }
    const publicMessage = contentAssetTicket ? publicReply.trim() : "";
    try {
      await updateMutation.mutateAsync({
        userId,
        ticketId: detail.ticket.id,
        expectedRevision: detail.ticket.revision,
        status: "completed",
        publicMessage: publicMessage || undefined,
        publicSummary: summary || undefined,
        deliveryLinks: contentAssetTicket ? deliveryLinks : undefined,
        internalNote: internalNote.trim() || undefined,
      });
      await refresh();
      setPublicReply("");
      setPublicSummary("");
      setInternalNote("");
      toast.success("需求状态已更新");
    } catch (error) {
      toast.error("状态更新失败", {
        description: error instanceof Error ? error.message : "请刷新后重试。",
      });
    }
  };

  const uploadKnowledgeMaintenanceArchive = async (file: File) => {
    if (
      !detail?.ticket ||
      detail.ticket.category !== "knowledge_base_maintenance"
    ) {
      return;
    }
    if (!file.name.toLowerCase().endsWith(".zip")) {
      toast.error("知识库维护只接受 ZIP 文件");
      return;
    }
    setMaintenanceUploading(true);
    try {
      const response = await fetch(`/api/dashboard/import/${userId}`, {
        method: "PUT",
        credentials: "include",
        headers: {
          "Content-Type": "application/octet-stream",
          "x-file-name": encodeURIComponent(file.name),
          "x-import-mode": "knowledge",
          "x-maintenance-ticket-id": detail.ticket.id,
        },
        body: file,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(
          payload?.error?.message ||
            payload?.message ||
            `上传失败 (${response.status})`,
        );
      }
      await refresh();
      toast.success("新知识库版本已通过校验并发布", {
        description:
          "正式数据已发布，需求尚未完成。请核对客户看板并填写交付结果。",
      });
    } catch (error) {
      toast.error("知识库维护版本上传失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setMaintenanceUploading(false);
      if (maintenanceFileInputRef.current) {
        maintenanceFileInputRef.current.value = "";
      }
    }
  };

  const sendMessage = async (visibility: "customer" | "internal") => {
    if (!detail?.ticket) return;
    const message =
      visibility === "customer" ? publicReply.trim() : internalNote.trim();
    if (!message && !(visibility === "customer" && publicFiles.length)) {
      toast.error(
        visibility === "customer"
          ? "请填写公开回复或选择交付文件"
          : "请填写内部备注",
      );
      return;
    }
    if (previewMode) {
      visibility === "customer" ? setPublicReply("") : setInternalNote("");
      setPublicFiles([]);
      toast.success(
        visibility === "customer"
          ? "客户可见回复已发送（预览）"
          : "内部备注已保存（预览）",
      );
      return;
    }
    try {
      setUploading(true);
      const attachments =
        visibility === "customer"
          ? await Promise.all(
              publicFiles.map(async (file) => {
                const uploaded = await uploadFile(file);
                return {
                  ...uploaded,
                  mimeType: file.type || undefined,
                  sizeBytes: file.size,
                };
              }),
            )
          : [];
      await addMessageMutation.mutateAsync({
        userId,
        ticketId: detail.ticket.id,
        clientRequestId: crypto.randomUUID(),
        visibility,
        attachmentKind: "deliverable",
        message: message || "已上传交付文件。",
        attachments,
      });
      await refresh();
      visibility === "customer" ? setPublicReply("") : setInternalNote("");
      if (visibility === "customer") setPublicFiles([]);
      toast.success(
        visibility === "customer" ? "客户可见回复已发送" : "内部备注已保存",
      );
    } catch (error) {
      toast.error("消息保存失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setUploading(false);
    }
  };

  const saveDeliveryRecord = async () => {
    if (!detail?.ticket) return;
    if (!deliveryPlatform.trim() || !deliveryTargetUrl.trim()) {
      toast.error("请填写操作平台和目标 URL");
      return;
    }
    let normalizedUrl = "";
    try {
      normalizedUrl = new URL(deliveryTargetUrl.trim()).toString();
    } catch {
      toast.error("目标 URL 格式不正确");
      return;
    }
    if (previewMode) {
      toast.info("预览环境不写入交付记录");
      return;
    }
    try {
      setUploading(true);
      const attachments = await Promise.all(
        deliveryFiles.map(async (file) => {
          const uploaded = await uploadFile(file);
          return {
            ...uploaded,
            mimeType: file.type || undefined,
            sizeBytes: file.size,
          };
        }),
      );
      await recordDeliveryMutation.mutateAsync({
        userId,
        ticketId: detail.ticket.id,
        expectedRevision: detail.ticket.revision,
        clientRequestId: crypto.randomUUID(),
        result: {
          platform: deliveryPlatform.trim(),
          targetUrl: normalizedUrl,
          executedAt: deliveryExecutedAt
            ? new Date(deliveryExecutedAt).getTime()
            : Date.now(),
          resultStatus: deliveryResultStatus,
          platformMessage: deliveryPlatformMessage.trim() || undefined,
          screenshotFileId: attachments[0]?.fileId,
        },
        attachments,
      });
      await refresh();
      setDeliveryPlatform("");
      setDeliveryTargetUrl("");
      setDeliveryExecutedAt("");
      setDeliveryResultStatus("pending_confirmation");
      setDeliveryPlatformMessage("");
      setDeliveryFiles([]);
      toast.success("交付执行记录已保存");
    } catch (error) {
      toast.error("交付记录保存失败", {
        description: error instanceof Error ? error.message : "请稍后重试。",
      });
    } finally {
      setUploading(false);
    }
  };

  const publicEvents = (detail?.events || []).filter(isCustomerVisibleEvent);
  const internalEvents = (detail?.events || []).filter(
    (event) => event.visibility === "internal",
  );
  const isKnowledgeTicket = detail?.ticket.type === "knowledge_base";
  const isKnowledgeReset = detail?.ticket.category === "knowledge_reset";
  const selectedWorkflowDomain =
    detail?.ticket.workflowDomain ?? selectedTicket?.workflowDomain ?? null;
  const selectedProjectAssignmentId =
    detail?.ticket.assignedProjectAssignmentId ??
    selectedTicket?.assignedProjectAssignmentId ??
    null;
  const canExecuteSelectedTicket = false;
  const systemAdminWorkbenchHref = detail?.ticket
    ? buildSystemAdminTicketWorkbenchHref(detail.ticket)
    : selectedTicket
      ? buildSystemAdminTicketWorkbenchHref(selectedTicket)
      : null;
  const canOpenSystemAdminWorkbench =
    canExecuteDelivery &&
    deliveryTicketPublicStatus(detail?.ticket ?? selectedTicket) ===
      "pending" &&
    Boolean(selectedWorkflowDomain) &&
    Boolean(selectedProjectAssignmentId) &&
    Boolean(systemAdminWorkbenchHref);

  return (
    <div className="admin-delivery-workspace">
      <div className="admin-delivery-toolbar">
        <div>
          <p>客户需求</p>
          <h2>{enterpriseName || "客户"}需求记录</h2>
          <span>
            需求仅用于任务提醒与历史追溯；上传、回复、备注、交付与完成操作统一在对应客户工作台进行。
          </span>
        </div>
        {onOpenCustomerDashboard && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className={CUSTOMER_DASHBOARD_BUTTON_CLASS}
            onClick={onOpenCustomerDashboard}
          >
            进入客户看板
            <PanelRightOpen className="h-4 w-4" />
          </Button>
        )}
      </div>
      {selectedTicket && (
        <div className="admin-ticket-closed-notice">
          <LockKeyhole className="h-4 w-4" />
          <span>
            {selectedWorkflowDomain && selectedProjectAssignmentId
              ? `当前为只读总览：该需求由${DELIVERY_ROLE_LABELS[selectedWorkflowDomain]}处理。`
              : selectedWorkflowDomain
                ? "项目岗位尚未同步，本页只读；请先同步项目岗位后，再进入对应客户工作台处理。"
                : "旧版需求未关联项目岗位，本页只读；请先同步项目岗位后，再进入对应客户工作台处理。"}
          </span>
        </div>
      )}
      {canOpenSystemAdminWorkbench && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#5b2a86]/25 bg-[#5b2a86]/[0.045] px-4 py-3">
          <div>
            <strong className="text-sm text-[#484057]">
              使用完整岗位处理流程
            </strong>
            <p className="mt-1 text-xs leading-5 text-[#716a80]">
              当前需求属于
              {selectedWorkflowDomain
                ? DELIVERY_ROLE_LABELS[selectedWorkflowDomain]
                : "对应岗位"}
              ，请在系统管理员处理工作台执行、上传成果并完成需求。
            </p>
          </div>
          <Button asChild size="sm" variant="operator">
            <a href={systemAdminWorkbenchHref || "/admin/delivery-workbench"}>
              进入系统管理员处理工作台
              <ExternalLink className="h-4 w-4" />
            </a>
          </Button>
        </div>
      )}
      {(Object.keys(contentQuota).length > 0 ||
        Object.keys(websiteQuota).length > 0) && (
        <div className="admin-delivery-quota-panel">
          <div className="admin-delivery-quota-heading">
            <div>
              <strong>当前服务周期发布额度</strong>
              <span>提交时预留，需求完成后正式消耗；交付管理员仅可查看。</span>
            </div>
            {quotaAdjustmentAvailable && !quotaEditing && (
              <Button
                type="button"
                variant="operatorOutline"
                size="sm"
                onClick={() => setQuotaEditing(true)}
              >
                <SlidersHorizontal className="h-4 w-4" />
                调整额度
              </Button>
            )}
          </div>
          <div className="admin-delivery-quota-summary">
            {[
              ["内容资产发布", contentQuota],
              ["官网内容发布", websiteQuota],
            ].map(([label, quota]) => {
              const values = quota as Record<string, any>;
              const reserved = Number(values.reserved ?? 0);
              const consumed = Number(values.consumed ?? 0);
              const used = Number(values.used ?? consumed + reserved);
              const limit = Number(values.limit ?? 0);
              return (
                <div key={String(label)}>
                  <span>{String(label)}</span>
                  <strong>
                    {used} / {limit}
                  </strong>
                  <small>
                    已消耗 {consumed}
                    {reserved > 0 ? ` · 已预留 ${reserved}` : ""}
                  </small>
                </div>
              );
            })}
          </div>
          {quotaAdjustmentAvailable && quotaEditing && (
            <div className="admin-delivery-quota-editor">
              <label>
                <span>内容资产发布上限</span>
                <Input
                  type="number"
                  min={Number(contentQuota.used ?? 0)}
                  step={1}
                  value={contentQuotaLimit}
                  onChange={(event) =>
                    setContentQuotaLimit(Number(event.target.value))
                  }
                />
              </label>
              <label>
                <span>官网内容发布上限</span>
                <Input
                  type="number"
                  min={Number(websiteQuota.used ?? 0)}
                  step={1}
                  value={websiteQuotaLimit}
                  onChange={(event) =>
                    setWebsiteQuotaLimit(Number(event.target.value))
                  }
                />
              </label>
              <div>
                <Button
                  type="button"
                  variant="outline"
                  disabled={adjustQuotaMutation.isPending}
                  onClick={() => setQuotaEditing(false)}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  variant="operator"
                  disabled={adjustQuotaMutation.isPending}
                  onClick={() => void saveQuotaLimits()}
                >
                  {adjustQuotaMutation.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="h-4 w-4" />
                  )}
                  保存额度
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="admin-ticket-master-detail">
        <aside className="admin-ticket-list-panel">
          <div className="admin-ticket-list-header">
            <div>
              <strong>客户需求</strong>
              <span>
                {listQuery.isLoading && !previewMode
                  ? "读取中…"
                  : listQuery.hasNextPage && !previewMode
                    ? `已加载 ${filteredTickets.length} 张`
                    : `${filteredTickets.length} 张`}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              aria-label="刷新需求"
              disabled={listQuery.isFetching}
              onClick={() => void refresh()}
            >
              <RefreshCw
                className={`h-4 w-4 ${listQuery.isFetching ? "animate-spin" : ""}`}
              />
            </Button>
          </div>
          <div className="admin-ticket-filters">
            <label>
              <Search className="h-4 w-4" />
              <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder="搜索话题或类别"
              />
            </label>
            <div>
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                aria-label="筛选需求类型"
              >
                <option value="all">全部类型</option>
                <option value="knowledge_base">品牌知识库</option>
                <option value="content_asset">内容资产</option>
                <option value="website_operation">官网运营</option>
              </select>
              <select
                value={statusFilter}
                onChange={(event) =>
                  setStatusFilter(
                    event.target.value as
                      | "all"
                      | AdminDeliveryTicketPublicStatus,
                  )
                }
                aria-label="筛选需求状态"
              >
                <option value="all">全部状态</option>
                <option value="pending">待处理</option>
                <option value="completed">已结束</option>
              </select>
            </div>
          </div>
          {listQuery.error && !previewMode ? (
            <div className="admin-ticket-list-error">
              <AlertCircle className="h-5 w-5" />
              <strong>需求暂时无法读取</strong>
              <span>{listQuery.error.message || "请刷新后重试。"}</span>
            </div>
          ) : filteredTickets.length ? (
            <div className="admin-ticket-list">
              {filteredTickets.map((ticket) => {
                const pending =
                  deliveryTicketPublicStatus(ticket) === "pending";
                return (
                  <article
                    key={ticket.id}
                    data-pending-ticket={pending ? "true" : undefined}
                    className={[
                      ticket.id === selectedTicketId ? "is-selected" : "",
                      pending ? "is-pending-alert" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                  >
                    <button
                      type="button"
                      className="admin-ticket-list-main"
                      onClick={() => selectTicket(ticket)}
                    >
                      <div>
                        <span>
                          {ticketTypeLabel(
                            ticket.type,
                            ticket.isWorkflowContainer
                              ? ticket.category
                              : (ticket.operation ?? ticket.category),
                          )}
                        </span>
                        <StatusPill ticket={ticket} />
                      </div>
                      <strong>{ticketTitle(ticket)}</strong>
                      {ticketTopic(ticket) && <p>{ticketTopic(ticket)}</p>}
                      {ticket.type === "content_asset" &&
                        ticket.preferredMedia && (
                          <p>意向媒体：{ticket.preferredMedia}</p>
                        )}
                      <footer>
                        <time>{formatAdminTicketDate(ticket.updatedAt)}</time>
                        <ChevronRight className="h-4 w-4" />
                      </footer>
                    </button>
                    {canExecuteDelivery && (
                      <button
                        type="button"
                        className="admin-ticket-list-delete"
                        aria-label={`永久删除需求：${ticketTitle(ticket)}`}
                        disabled={deleteMutation.isPending}
                        onClick={() => void deleteTicket(ticket)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </article>
                );
              })}
              {listQuery.hasNextPage && !previewMode && (
                <Button
                  type="button"
                  variant="outline"
                  className="admin-ticket-load-more"
                  disabled={listQuery.isFetchingNextPage}
                  onClick={() => void listQuery.fetchNextPage()}
                >
                  {listQuery.isFetchingNextPage ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ChevronRight className="h-4 w-4 rotate-90" />
                  )}
                  {listQuery.isFetchingNextPage ? "正在加载…" : "加载更多需求"}
                </Button>
              )}
            </div>
          ) : (
            <EmptyState
              title="没有符合条件的需求"
              description="调整筛选条件，或等待客户提交新的交付需求。"
            />
          )}
        </aside>

        <main className="admin-ticket-detail-panel">
          {!selectedTicketId ? (
            <EmptyState
              title="请选择一张需求"
              description="右侧会只读展示需求、资料与历史处理记录。"
            />
          ) : detailQuery.isLoading && !previewMode ? (
            <div className="admin-ticket-loading">
              <Loader2 className="h-5 w-5 animate-spin" />
              正在读取需求详情…
            </div>
          ) : detailQuery.error && !previewMode ? (
            <div className="admin-ticket-detail-error">
              <AlertCircle className="h-5 w-5" />
              <strong>需求详情暂时无法读取</strong>
              <p>{detailQuery.error.message || "请刷新后重试。"}</p>
            </div>
          ) : detail ? (
            <>
              <header className="admin-ticket-detail-header">
                <div>
                  <div className="admin-ticket-detail-meta">
                    <span>
                      {ticketTypeLabel(
                        detail.ticket.type,
                        detail.ticket.isWorkflowContainer
                          ? detail.ticket.category
                          : (detail.ticket.operation ?? detail.ticket.category),
                      )}
                    </span>
                    <StatusPill ticket={detail.ticket} />
                  </div>
                  <h3>{ticketTitle(detail.ticket)}</h3>
                  {ticketTopic(detail.ticket) && (
                    <p>{ticketTopic(detail.ticket)}</p>
                  )}
                </div>
                <div className="admin-ticket-detail-time">
                  <CalendarClock className="h-4 w-4" />
                  更新于 {formatAdminTicketDate(detail.ticket.updatedAt)}
                </div>
                {canExecuteDelivery && (
                  <Button
                    type="button"
                    variant="destructive"
                    size="sm"
                    disabled={deleteMutation.isPending}
                    onClick={() => void deleteTicket(detail.ticket)}
                  >
                    <Trash2 className="h-4 w-4" />
                    {deleteMutation.isPending ? "正在删除…" : "永久删除需求"}
                  </Button>
                )}
              </header>
              <section className="admin-ticket-customer-card">
                <div>
                  <span>客户</span>
                  <strong>{enterpriseName || "客户名称未设置"}</strong>
                </div>
                <div>
                  <span>客户账号</span>
                  <strong>
                    {customerUsername ? `@${customerUsername}` : "未记录"}
                  </strong>
                </div>
                <div>
                  <span>客户编号</span>
                  <strong>#{userId}</strong>
                </div>
                <div>
                  <span>提交时间</span>
                  <strong>
                    {formatAdminTicketDate(detail.ticket.createdAt)}
                  </strong>
                </div>
                <div>
                  <span>执行岗位</span>
                  <strong>
                    {detail.ticket.workflowDomain
                      ? DELIVERY_ROLE_LABELS[detail.ticket.workflowDomain]
                      : "旧版需求"}
                  </strong>
                </div>
                <div>
                  <span>岗位负责人</span>
                  <strong>
                    {detail.ticket.assignedMemberId
                      ? detail.ticket.assignedMemberName ||
                        `工程师 #${detail.ticket.assignedMemberId}`
                      : detail.ticket.workflowDomain
                        ? "岗位归属同步异常"
                        : "无岗位"}
                  </strong>
                </div>
              </section>
              {detail.workflowRelations &&
                (detail.workflowRelations.root ||
                  detail.workflowRelations.children.length > 0) && (
                  <section
                    className="rounded-xl border border-[#ded5e6] bg-[#fbf9fd] p-4"
                    aria-label="内部工单链路"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <span className="text-xs font-medium text-[#716a80]">
                          父子关系
                        </span>
                        <h3 className="mt-1 text-sm font-semibold text-[#332842]">
                          内部工单链路
                        </h3>
                      </div>
                      <span className="rounded-full bg-white px-2.5 py-1 text-xs text-[#716a80]">
                        客户仅看到原始需求
                      </span>
                    </div>
                    <div className="mt-3 space-y-2">
                      {detail.workflowRelations.root && (
                        <button
                          type="button"
                          className="flex w-full items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 text-left disabled:cursor-default"
                          data-ticket-id={detail.workflowRelations.root.id}
                          disabled={
                            detail.workflowRelations.root.id ===
                            detail.ticket.id
                          }
                          onClick={() =>
                            setSelectedTicketId(
                              detail.workflowRelations!.root!.id,
                            )
                          }
                        >
                          <span>
                            <strong className="block text-sm text-[#332842]">
                              客户原始需求
                            </strong>
                            <small className="text-[#857e91]">
                              流程容器 · 不分配工程师
                            </small>
                          </span>
                          <span className="text-xs font-medium text-[#5b2a86]">
                            {deliveryTicketStatusLabel(
                              detail.workflowRelations.root.status,
                              "internal",
                            )}
                          </span>
                        </button>
                      )}
                      {detail.workflowRelations.children.map(
                        (relation, index) => (
                          <button
                            key={relation.id}
                            type="button"
                            className="flex w-full items-center justify-between gap-3 rounded-lg border bg-white px-3 py-2 text-left disabled:cursor-default"
                            data-ticket-id={relation.id}
                            disabled={relation.id === detail.ticket.id}
                            onClick={() => setSelectedTicketId(relation.id)}
                          >
                            <span className="min-w-0">
                              <strong className="block truncate text-sm text-[#332842]">
                                第 {index + 1} 步 ·{" "}
                                {deliveryOperationLabel(relation.operation)}
                              </strong>
                              <small className="block truncate text-[#857e91]">
                                {relation.workflowDomain
                                  ? DELIVERY_ROLE_LABELS[
                                      relation.workflowDomain
                                    ]
                                  : "系统流程"}
                                {relation.assignedMemberName
                                  ? ` · ${relation.assignedMemberName}`
                                  : ""}
                              </small>
                            </span>
                            <span className="shrink-0 text-xs font-medium text-[#5b2a86]">
                              {deliveryTicketStatusLabel(
                                relation.status,
                                "internal",
                              )}
                            </span>
                          </button>
                        ),
                      )}
                    </div>
                  </section>
                )}
              {!OPEN_TICKET_STATUSES.has(detail.ticket.status) && (
                <div className="admin-ticket-closed-notice">
                  <LockKeyhole className="h-4 w-4" />
                  <span>
                    该需求已结束，当前仅展示与该需求直接相关的处理记录。
                  </span>
                </div>
              )}

              <section className="admin-ticket-request-card">
                <div className="admin-ticket-section-heading">
                  <div>
                    <span>{isKnowledgeTicket ? "知识库事项" : "客户需求"}</span>
                    <h3>
                      {isKnowledgeReset
                        ? "知识库重置申请"
                        : isKnowledgeTicket
                          ? "品牌全域知识库交付"
                          : "需求正文与提交资料"}
                    </h3>
                  </div>
                  <FileText className="h-5 w-5" />
                </div>
                {deliveryTicketDisplayDescription(detail.ticket) ? (
                  <p>{deliveryTicketDisplayDescription(detail.ticket)}</p>
                ) : (
                  <p className="is-empty">
                    {isKnowledgeReset
                      ? "客户未填写重置原因。"
                      : isKnowledgeTicket
                        ? "该记录由知识库发布流程自动生成。"
                        : "客户未填写补充说明。"}
                  </p>
                )}
                {detail.ticket.type === "content_asset" && (
                  <p>
                    <strong>意向媒体：</strong>
                    {detail.ticket.preferredMedia || "暂不指定"}
                  </p>
                )}
                {detail.ticket.type === "website_operation" &&
                  detail.ticket.category === "icp_filing" &&
                  detail.ticket.icpDeclarations && (
                    <div className="admin-ticket-icp-declarations">
                      <p>
                        <strong>ICP 主体备案号：</strong>
                        {detail.ticket.icpDeclarations.icpNumber || "未填写"}
                      </p>
                    </div>
                  )}
                {safeAdminDeliveryUrl(detail.ticket.targetUrl) && (
                  <a
                    href={safeAdminDeliveryUrl(detail.ticket.targetUrl)!}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Link2 className="h-4 w-4" />
                    {detail.ticket.targetUrl}
                    <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                )}
                {detail.attachments?.length ? (
                  <div className="admin-ticket-request-attachments">
                    {detail.attachments.map((attachment, index) => (
                      <a
                        key={attachment.id || attachment.fileId || index}
                        href={safeAdminDeliveryUrl(attachment.url) || undefined}
                        target={
                          safeAdminDeliveryUrl(attachment.url)
                            ? "_blank"
                            : undefined
                        }
                        rel={
                          safeAdminDeliveryUrl(attachment.url)
                            ? "noopener noreferrer"
                            : undefined
                        }
                      >
                        <Paperclip className="h-4 w-4" />
                        {attachment.filename || "客户资料"}
                      </a>
                    ))}
                  </div>
                ) : null}
              </section>

              <div
                className={`admin-ticket-timelines${isKnowledgeTicket ? " is-single" : ""}`}
              >
                {(detail.ticket.type === "content_asset" ||
                  isKnowledgeTicket) && (
                  <Timeline
                    title={isKnowledgeTicket ? "处理记录" : "客户可见交流"}
                    description={
                      isKnowledgeTicket
                        ? "仅保留该知识库事项的提交、审批与交付结果。"
                        : "此处内容与交付结果会同步给客户。"
                    }
                    events={publicEvents}
                  />
                )}
                {!isKnowledgeTicket && (
                  <Timeline
                    title="管理员内部记录"
                    description="仅管理员可见，绝不返回用户端。"
                    events={internalEvents}
                    internal
                  />
                )}
              </div>

              {canExecuteSelectedTicket && !isKnowledgeTicket && (
                <div className="admin-ticket-compose-grid">
                  {detail.ticket.type === "content_asset" && (
                    <section className="admin-ticket-compose">
                      <div>
                        <MessageSquare className="h-4 w-4" />
                        <strong>回复客户与回传成果</strong>
                      </div>
                      <Textarea
                        value={publicReply}
                        onChange={(event) => setPublicReply(event.target.value)}
                        placeholder="填写客户可见回复或交付说明"
                      />
                      <input
                        ref={fileInputRef}
                        className="hidden"
                        type="file"
                        multiple
                        onChange={(event) =>
                          setPublicFiles(Array.from(event.target.files || []))
                        }
                      />
                      <div className="admin-ticket-file-row">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                        >
                          <UploadCloud className="h-4 w-4" />
                          选择交付文件
                        </button>
                        <span>
                          {publicFiles.length
                            ? `已选择 ${publicFiles.length} 个文件`
                            : "可上传报告、截图或成果文件"}
                        </span>
                      </div>
                      <Button
                        variant="operator"
                        disabled={
                          uploading ||
                          addMessageMutation.isPending ||
                          !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                        }
                        onClick={() => void sendMessage("customer")}
                      >
                        {uploading || addMessageMutation.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Send className="h-4 w-4" />
                        )}
                        发送客户可见回复
                      </Button>
                    </section>
                  )}

                  <section className="admin-ticket-compose is-internal">
                    <div>
                      <LockKeyhole className="h-4 w-4" />
                      <strong>内部备注</strong>
                    </div>
                    <Textarea
                      value={internalNote}
                      onChange={(event) => setInternalNote(event.target.value)}
                      placeholder="记录内部判断、协作人或风险边界"
                    />
                    <div className="admin-ticket-notice">
                      <LockKeyhole className="h-4 w-4" />
                      <span>内部备注不会出现在用户看板或客户接口中。</span>
                    </div>
                    <Button
                      variant="outline"
                      disabled={
                        addMessageMutation.isPending ||
                        !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                      }
                      onClick={() => void sendMessage("internal")}
                    >
                      <Save className="h-4 w-4" />
                      保存内部备注
                    </Button>
                  </section>
                </div>
              )}

              {detail.ticket.type === "content_asset" && (
                <section className="admin-ticket-delivery-card">
                  <div className="admin-ticket-section-heading">
                    <div>
                      <span>结构化交付记录</span>
                      <h3>发布、推送与复检结果</h3>
                      <p>
                        平台提交成功只表示请求已发送，不等同于内容已收录或被 AI
                        引用。
                      </p>
                    </div>
                    <Send className="h-5 w-5" />
                  </div>
                  {detail.deliveryRecords?.length ? (
                    <div className="admin-delivery-record-list">
                      {detail.deliveryRecords.map((record) => (
                        <article key={record.id}>
                          <div>
                            <strong>{record.platform || "平台未记录"}</strong>
                            <span
                              className={`is-${record.resultStatus || "pending_confirmation"}`}
                            >
                              {record.resultStatus === "success"
                                ? "成功"
                                : record.resultStatus === "failed"
                                  ? "失败"
                                  : "待确认"}
                            </span>
                          </div>
                          {safeAdminDeliveryUrl(record.targetUrl) && (
                            <a
                              href={safeAdminDeliveryUrl(record.targetUrl)!}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {record.targetUrl}
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                          <p>
                            {record.platformMessage || "未记录平台返回信息。"}
                          </p>
                          <time>
                            {formatAdminTicketDate(record.executedAt)}
                          </time>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="admin-delivery-record-empty">
                      暂无结构化发布、推送或复检记录。
                    </p>
                  )}
                  {canExecuteSelectedTicket && (
                    <div className="admin-delivery-record-form">
                      <label>
                        <span>操作平台</span>
                        <Input
                          value={deliveryPlatform}
                          onChange={(event) =>
                            setDeliveryPlatform(event.target.value)
                          }
                          placeholder="行业媒体、百度站长平台等"
                        />
                      </label>
                      <label>
                        <span>目标 URL</span>
                        <Input
                          value={deliveryTargetUrl}
                          onChange={(event) =>
                            setDeliveryTargetUrl(event.target.value)
                          }
                          placeholder="https://..."
                        />
                      </label>
                      <label>
                        <span>执行时间</span>
                        <Input
                          type="datetime-local"
                          value={deliveryExecutedAt}
                          onChange={(event) =>
                            setDeliveryExecutedAt(event.target.value)
                          }
                        />
                      </label>
                      <label>
                        <span>执行结果</span>
                        <select
                          value={deliveryResultStatus}
                          onChange={(event) =>
                            setDeliveryResultStatus(
                              event.target.value as typeof deliveryResultStatus,
                            )
                          }
                        >
                          <option value="pending_confirmation">待确认</option>
                          <option value="success">成功</option>
                          <option value="failed">失败</option>
                        </select>
                      </label>
                      <label className="is-wide">
                        <span>平台返回信息</span>
                        <Textarea
                          value={deliveryPlatformMessage}
                          onChange={(event) =>
                            setDeliveryPlatformMessage(event.target.value)
                          }
                          placeholder="记录平台响应、失败原因或复检结论"
                        />
                      </label>
                      <input
                        ref={deliveryFileInputRef}
                        className="hidden"
                        type="file"
                        multiple
                        onChange={(event) =>
                          setDeliveryFiles(Array.from(event.target.files || []))
                        }
                      />
                      <div className="admin-ticket-file-row is-wide">
                        <button
                          type="button"
                          onClick={() => deliveryFileInputRef.current?.click()}
                        >
                          <UploadCloud className="h-4 w-4" />
                          上传截图或复检材料
                        </button>
                        <span>
                          {deliveryFiles.length
                            ? `已选择 ${deliveryFiles.length} 个文件`
                            : "可选"}
                        </span>
                      </div>
                      <div className="admin-ticket-form-actions is-wide">
                        <Button
                          variant="operator"
                          disabled={
                            recordDeliveryMutation.isPending ||
                            uploading ||
                            !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                          }
                          onClick={() => void saveDeliveryRecord()}
                        >
                          {recordDeliveryMutation.isPending || uploading ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Save className="h-4 w-4" />
                          )}
                          保存交付记录
                        </Button>
                      </div>
                    </div>
                  )}
                </section>
              )}

              {canExecuteSelectedTicket &&
                detail.ticket.category === "knowledge_base_maintenance" && (
                  <section className="admin-ticket-delivery-card">
                    <div className="admin-ticket-section-heading">
                      <div>
                        <span>知识库替换版本</span>
                        <h3>上传并发布通过校验的新知识库 ZIP</h3>
                        <p>
                          新版本会直接替换客户当前展示知识库，并与本维护需求绑定；发布成功后才能完成需求。
                        </p>
                      </div>
                      <UploadCloud className="h-5 w-5" />
                    </div>
                    <input
                      ref={maintenanceFileInputRef}
                      className="hidden"
                      type="file"
                      accept=".zip,application/zip"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadKnowledgeMaintenanceArchive(file);
                      }}
                    />
                    <div className="admin-ticket-status-action">
                      <Button
                        variant="operator"
                        disabled={
                          maintenanceUploading ||
                          !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                        }
                        onClick={() => maintenanceFileInputRef.current?.click()}
                      >
                        {maintenanceUploading ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <UploadCloud className="h-4 w-4" />
                        )}
                        {maintenanceUploading
                          ? "正在校验并发布"
                          : "上传知识库 ZIP"}
                      </Button>
                    </div>
                  </section>
                )}

              {isKnowledgeTicket && (
                <section className="admin-ticket-status-card">
                  <div className="admin-ticket-section-heading">
                    <div>
                      <span>处理结果</span>
                      <h3>
                        {isKnowledgeReset
                          ? "重置处理结果"
                          : "品牌全域知识库交付结果"}
                      </h3>
                      <p>
                        {detail.ticket.publicSummary ||
                          (OPEN_TICKET_STATUSES.has(detail.ticket.status)
                            ? "该事项正在由专用知识库流程处理。"
                            : "该事项已结束。")}
                      </p>
                    </div>
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                  {detail.ticket.knowledgeSnapshotId && (
                    <p className="mt-4 break-all text-xs text-[#716a80]">
                      知识库版本标识：{detail.ticket.knowledgeSnapshotId}
                    </p>
                  )}
                </section>
              )}

              {!isKnowledgeTicket && canExecuteSelectedTicket && (
                <section className="admin-ticket-status-card">
                  <div className="admin-ticket-section-heading">
                    <div>
                      <span>处理状态</span>
                      <h3>
                        {isDomainApplication
                          ? "完成域名需求并返回备案服务码"
                          : "完成需求并发布内容总结"}
                      </h3>
                      <p>
                        {isDomainApplication
                          ? "请确认域名状态正常，再将备案服务码写入下方处理结果；客户会在已完成需求中领取。"
                          : "用户列表只显示待处理或已完成；完成摘要会进入用户历史记录。"}
                      </p>
                    </div>
                    <History className="h-5 w-5" />
                  </div>
                  <label className="mt-4 block">
                    <span className="text-sm font-semibold text-[#484057]">
                      {isDomainApplication
                        ? "备案服务码处理结果"
                        : "公开内容总结"}
                    </span>
                    <Textarea
                      className="mt-2 min-h-28"
                      value={publicSummary}
                      onChange={(event) => setPublicSummary(event.target.value)}
                      placeholder={
                        isDomainApplication
                          ? "例如：备案服务码：XXXXXXXX（请复制核对无误后再完成需求）"
                          : "完成需求时必填，简要说明实际完成的内容与结果"
                      }
                    />
                  </label>
                  <div className="admin-ticket-status-action">
                    <Button
                      variant="operator"
                      disabled={
                        updateMutation.isPending ||
                        !publicSummary.trim() ||
                        !OPEN_TICKET_STATUSES.has(detail.ticket.status)
                      }
                      onClick={() => void updateStatus()}
                    >
                      {updateMutation.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" />
                      )}
                      完成需求
                    </Button>
                  </div>
                </section>
              )}
            </>
          ) : null}
        </main>
      </div>
    </div>
  );
}

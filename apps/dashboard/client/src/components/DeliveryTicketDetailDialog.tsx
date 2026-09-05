import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  FileText,
  Loader2,
  MessageSquareText,
  Paperclip,
  RefreshCw,
  Send,
  Upload,
} from "lucide-react";
import {
  FormEvent,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useState,
} from "react";
import {
  type DeliveryTicketAttachmentInput,
  type DeliveryTicketStatus,
} from "@shared/delivery-ticket";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { deliveryProjectHeaders, uploadFile } from "@/lib/frontmind-api";

import "./delivery-ticket-detail-dialog.css";

export type TicketDetail = {
  ticket?: {
    id: string;
    type: "content_asset" | "website_operation";
    category?: string | null;
    categoryLabel?: string | null;
    topic?: string | null;
    title?: string | null;
    description?: string | null;
    targetPage?: string | null;
    materialUrls?: string[];
    status?: DeliveryTicketStatus;
    publicStatus?: "pending" | "completed" | null;
    statusLabel?: string | null;
    publicStatusLabel?: string | null;
    publicStage?:
      | "awaiting_service"
      | "processing"
      | "action_required"
      | "completed"
      | "closed"
      | null;
    publicStageLabel?: string | null;
    preferredMedia?: string | null;
    publicSummary?: string | null;
    deliveryLinks?: Array<{ label: string; url: string }>;
    revision: number;
    canReply?: boolean;
    canAttach?: boolean;
    submittedAt?: string | number | Date | null;
    updatedAt?: string | number | Date | null;
    resolvedAt?: string | number | Date | null;
    scheduledAt?: string | number | Date | null;
  };
  events?: Array<{
    id: string;
    visibility?: "customer" | "internal" | string;
    eventType?: string | null;
    actorRole?: string | null;
    actorLabel?: string | null;
    message?: string | null;
    fromStatus?: DeliveryTicketStatus | null;
    toStatus?: DeliveryTicketStatus | null;
    operationResult?: {
      platform?: string | null;
      targetUrl?: string | null;
      executedAt?: string | number | Date | null;
      resultStatus?: string | null;
      platformMessage?: string | null;
    } | null;
    createdAt?: string | number | Date | null;
  }>;
  attachments?: Array<{
    id: string;
    filename: string;
    mimeType?: string | null;
    sizeBytes?: number | null;
    purpose?: string | null;
    authorization?: string | null;
    copyrightNote?: string | null;
    kind?: "input" | "deliverable" | null;
    visibility?: "customer" | "internal" | string | null;
    createdAt?: string | number | Date | null;
    downloadUrl?: string | null;
  }>;
};

export type DeliveryTicketDetailDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ticketId?: string | null;
  detail?: TicketDetail | null;
  loading?: boolean;
  error?: string | null;
  canMutate?: boolean;
  mutationPending?: boolean;
  readOnlyReason?: string | null;
  onRefresh?: () => Promise<void> | void;
  onAddMessage?: (input: {
    message: string;
    attachmentFiles: File[];
  }) => Promise<void> | void;
  onSubmitMessage?: (input: {
    ticketId: string;
    clientRequestId: string;
    message: string;
    attachments: DeliveryTicketAttachmentInput[];
  }) => Promise<void> | void;
  onChanged?: () => Promise<void> | void;
};

const TERMINAL_STATUSES = new Set<DeliveryTicketStatus>([
  "completed",
  "rejected",
  "cancelled",
]);

function ticketPublicStatus(
  ticket: TicketDetail["ticket"],
): "pending" | "completed" {
  if (
    ticket?.publicStatus === "pending" ||
    ticket?.publicStatus === "completed"
  ) {
    return ticket.publicStatus;
  }
  return ticket?.status && TERMINAL_STATUSES.has(ticket.status)
    ? "completed"
    : "pending";
}

const AUTHORIZATION_LABELS: Record<string, string> = {
  owned: "企业自有",
  licensed: "已获授权",
  public: "公开可用",
  authorization_pending: "授权待确认",
};

function displayDateTime(value: string | number | Date | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function fileSize(value: number | null | undefined) {
  if (!value || value <= 0) return "";
  if (value < 1024 * 1024) return `${Math.ceil(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function customerVisibleTicketEvents(
  events: NonNullable<TicketDetail["events"]> | null | undefined,
) {
  return (events || []).filter(
    (event) =>
      event.visibility === undefined || event.visibility === "customer",
  );
}

export function safeDeliveryAttachmentUrl(
  value: string | null | undefined,
  origin = typeof window === "undefined"
    ? "http://localhost"
    : window.location.origin,
) {
  if (!value) return null;
  try {
    const base = new URL(origin);
    const url = new URL(value, base);
    if (url.origin !== base.origin) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (
      segments.length !== 4 ||
      segments[0] !== "api" ||
      segments[1] !== "delivery-ticket-attachments" ||
      !/^[a-zA-Z0-9_-]{8,128}$/.test(segments[2]) ||
      segments[3] !== "content"
    ) {
      return null;
    }
    return `${url.pathname}${url.search}`;
  } catch {
    return null;
  }
}

export function safeExternalResultUrl(value: string | null | undefined) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export default function DeliveryTicketDetailDialog({
  open,
  onOpenChange,
  ticketId = null,
  detail = null,
  loading = false,
  error = null,
  canMutate,
  mutationPending = false,
  readOnlyReason = null,
  onRefresh,
  onAddMessage,
  onSubmitMessage,
  onChanged,
}: DeliveryTicketDetailDialogProps) {
  const [message, setMessage] = useState("");
  const [attachmentFiles, setAttachmentFiles] = useState<File[]>([]);
  const [formError, setFormError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [attachmentDownloadError, setAttachmentDownloadError] = useState("");
  const [downloadingAttachmentId, setDownloadingAttachmentId] = useState<
    string | null
  >(null);
  const ticket = detail?.ticket;
  const effectiveTicketId = ticketId || ticket?.id || null;
  const events = customerVisibleTicketEvents(detail?.events);
  const attachments = Array.isArray(detail?.attachments)
    ? detail.attachments.filter(
        (attachment) => attachment.visibility !== "internal",
      )
    : [];
  const mutationAllowed = canMutate ?? Boolean(onAddMessage || onSubmitMessage);
  const terminal = ticket ? ticketPublicStatus(ticket) === "completed" : true;
  const canAttach = ticket?.canAttach ?? ticket?.type !== "website_operation";
  const canReply = Boolean(
    mutationAllowed &&
      ticket &&
      effectiveTicketId &&
      !terminal &&
      (ticket.canReply ?? true) &&
      !readOnlyReason &&
      (onAddMessage || onSubmitMessage),
  );
  useEffect(() => {
    if (!open) return;
    setMessage("");
    setAttachmentFiles([]);
    setFormError("");
    setUploading(false);
    setUploadProgress(null);
    setAttachmentDownloadError("");
    setDownloadingAttachmentId(null);
  }, [open, ticket?.id]);

  async function downloadProjectAttachment(
    event: ReactMouseEvent<HTMLAnchorElement>,
    attachment: NonNullable<TicketDetail["attachments"]>[number],
    downloadUrl: string,
  ) {
    const headers = deliveryProjectHeaders();
    if (!headers["x-delivery-project-assignment-id"]) return;

    event.preventDefault();
    if (downloadingAttachmentId) return;
    setAttachmentDownloadError("");
    setDownloadingAttachmentId(attachment.id);
    try {
      const response = await fetch(downloadUrl, {
        credentials: "include",
        headers,
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error?.message || "附件下载失败");
      }
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = attachment.filename;
      anchor.click();
      URL.revokeObjectURL(objectUrl);
    } catch (downloadError) {
      setAttachmentDownloadError(
        downloadError instanceof Error
          ? downloadError.message
          : "附件下载失败，请稍后重试。",
      );
    } finally {
      setDownloadingAttachmentId(null);
    }
  }

  async function submitMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = message.trim();
    if (!normalized && attachmentFiles.length === 0) {
      setFormError("请填写需要补充的说明或选择附件。");
      return;
    }
    if (
      (!onAddMessage && !onSubmitMessage) ||
      !effectiveTicketId ||
      mutationPending ||
      uploading
    ) {
      return;
    }
    setFormError("");
    setUploading(true);
    setUploadProgress(attachmentFiles.length ? 0 : null);
    try {
      if (onSubmitMessage) {
        const attachments = await Promise.all(
          attachmentFiles.map(async (file, index) => {
            const uploaded = await uploadFile(file, (percent) => {
              const completed = index / Math.max(attachmentFiles.length, 1);
              const current =
                percent / 100 / Math.max(attachmentFiles.length, 1);
              setUploadProgress(Math.round((completed + current) * 100));
            });
            return {
              ...uploaded,
              mimeType: file.type || undefined,
              sizeBytes: file.size,
            };
          }),
        );
        await onSubmitMessage({
          ticketId: effectiveTicketId,
          clientRequestId: crypto.randomUUID(),
          message: normalized || "已补充附件。",
          attachments,
        });
      } else {
        await onAddMessage?.({
          message: normalized || "已补充附件。",
          attachmentFiles,
        });
      }
      setMessage("");
      setAttachmentFiles([]);
      setUploadProgress(null);
      await onChanged?.();
    } catch (submissionError) {
      setFormError(
        submissionError instanceof Error
          ? submissionError.message
          : "补充资料失败，请稍后重试。",
      );
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="delivery-ticket-dialog max-h-[calc(100vh-2rem)] overflow-y-auto border-[#e5ddeb] bg-[#fdfcfe] p-0 sm:max-w-3xl">
        <DialogHeader className="border-b border-[#ece6f0] bg-[linear-gradient(135deg,#f8f2fb_0%,#fff_72%)] px-6 py-5 pr-12 text-left">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-[#5b2a86]/10 px-2.5 py-1 text-xs font-semibold text-[#5b2a86]">
              {ticket?.type === "website_operation"
                ? "官网运营工单"
                : "内容资产工单"}
            </span>
            {ticket && (
              <span
                className="rounded-full bg-white px-2.5 py-1 text-xs font-semibold text-[#665b70]"
                data-status={ticket.publicStage || ticketPublicStatus(ticket)}
              >
                {ticket.publicStageLabel ||
                  ticket.publicStatusLabel ||
                  (ticketPublicStatus(ticket) === "completed"
                    ? "已完成"
                    : "已提交")}
              </span>
            )}
          </div>
          <DialogTitle className="pt-2 text-xl font-semibold text-[#21162f]">
            {ticket?.topic || ticket?.title || "工单详情"}
          </DialogTitle>
          <DialogDescription className="pt-1 text-sm leading-6 text-[#6d6478]">
            查看需求详情、公开交流与实际交付内容。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="grid min-h-56 place-items-center gap-2 px-6 py-10 text-sm text-[#71687c]">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" />
            正在载入工单详情…
          </div>
        ) : error ? (
          <div className="grid gap-3 px-6 py-8">
            <div
              className="flex gap-3 rounded-xl bg-[#fff1f3] px-4 py-3 text-sm text-[#a1264f]"
              role="alert"
            >
              <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
              <span>{error}</span>
            </div>
            {onRefresh && (
              <Button variant="outline" onClick={() => void onRefresh()}>
                <RefreshCw className="h-4 w-4" />
                重新载入
              </Button>
            )}
          </div>
        ) : !ticket ? (
          <div className="px-6 py-10 text-center text-sm text-[#71687c]">
            请选择一条工单查看详情。
          </div>
        ) : (
          <div className="grid gap-6 px-6 py-5">
            {(readOnlyReason || terminal) && (
              <div className="delivery-ticket-readonly">
                <AlertCircle className="h-4 w-4" />
                <span>
                  {readOnlyReason || "该工单已经结束，交流与交付记录仅供查看。"}
                </span>
              </div>
            )}
            <>
              {(ticket.description ||
                ticket.targetPage ||
                (ticket.materialUrls || []).length > 0 ||
                (ticket.type === "content_asset" && ticket.preferredMedia)) && (
                <section className="grid gap-3 rounded-2xl border border-[#e7dfed] bg-white p-4">
                  <h3 className="text-base font-semibold text-[#281c35]">
                    需求内容
                  </h3>
                  {ticket.description && (
                    <p className="m-0 whitespace-pre-wrap text-sm leading-6 text-[#5f5569]">
                      {ticket.description}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {ticket.type !== "website_operation" &&
                      ticket.targetPage && (
                        <>
                          {safeExternalResultUrl(ticket.targetPage) && (
                            <a
                              href={safeExternalResultUrl(ticket.targetPage)!}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="inline-flex items-center gap-1 rounded-lg bg-[#f3edf7] px-2.5 py-1.5 text-xs font-semibold text-[#5b2a86]"
                            >
                              目标页面
                              <ExternalLink className="h-3.5 w-3.5" />
                            </a>
                          )}
                        </>
                      )}
                    {ticket.type !== "website_operation" &&
                      (ticket.materialUrls || []).map((url, index) => {
                        const safeUrl = safeExternalResultUrl(url);
                        return safeUrl ? (
                          <a
                            href={safeUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-[#f3edf7] px-2.5 py-1.5 text-xs font-semibold text-[#5b2a86]"
                            key={`${url}-${index}`}
                          >
                            参考链接 {index + 1}
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null;
                      })}
                  </div>
                  {ticket.type === "content_asset" && (
                    <p className="m-0 text-sm text-[#5f5569]">
                      意向媒体：{ticket.preferredMedia || "暂不指定"}
                    </p>
                  )}
                </section>
              )}

              {ticket.publicSummary && (
                <section className="grid gap-3 rounded-2xl border border-[#e7dfed] bg-white p-4">
                  <h3 className="text-base font-semibold text-[#281c35]">
                    内容总结
                  </h3>
                  <p className="m-0 whitespace-pre-wrap text-sm leading-7 text-[#5f5569]">
                    {ticket.publicSummary}
                  </p>
                  {ticket.type === "content_asset" &&
                  ticket.deliveryLinks?.length ? (
                    <div className="flex flex-wrap gap-2">
                      {ticket.deliveryLinks.map((link, index) => {
                        const url = safeExternalResultUrl(link.url);
                        return url ? (
                          <a
                            key={`${link.label}-${index}`}
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 rounded-lg bg-[#f3edf7] px-2.5 py-1.5 text-xs font-semibold text-[#5b2a86]"
                          >
                            {link.label || "发布媒体"}
                            <ExternalLink className="h-3.5 w-3.5" />
                          </a>
                        ) : null;
                      })}
                    </div>
                  ) : null}
                </section>
              )}

              <section className="grid gap-3">
                <h3 className="text-base font-semibold text-[#281c35]">
                  处理时间线
                </h3>
                {events.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[#d9cfdf] bg-white px-4 py-6 text-center text-sm text-[#71687c]">
                    暂无公开处理记录。
                  </div>
                ) : (
                  <ol className="grid gap-3 p-0">
                    {events.map((event) => {
                      const operationUrl = safeExternalResultUrl(
                        event.operationResult?.targetUrl,
                      );
                      const operationStatus =
                        event.operationResult?.resultStatus === "success"
                          ? "成功"
                          : event.operationResult?.resultStatus === "failed"
                            ? "失败"
                            : "待确认";
                      return (
                        <li
                          key={event.id}
                          className="delivery-ticket-dialog-timeline-item grid grid-cols-[32px_minmax(0,1fr)] gap-3 rounded-xl border border-[#e7dfed] bg-white p-4"
                        >
                          <span className="grid h-8 w-8 place-items-center rounded-lg bg-[#f2eaf8] text-[#5b2a86]">
                            {event.toStatus === "completed" ? (
                              <CheckCircle2 className="h-4 w-4" />
                            ) : (
                              <MessageSquareText className="h-4 w-4" />
                            )}
                          </span>
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <strong className="text-sm font-semibold text-[#281c35]">
                                {event.actorLabel ||
                                  (event.actorRole === "user"
                                    ? "企业用户"
                                    : "服务团队")}
                              </strong>
                              <time className="text-xs text-[#81788a]">
                                {displayDateTime(event.createdAt)}
                              </time>
                            </div>
                            {event.message && (
                              <p className="mb-0 mt-1 whitespace-pre-wrap text-sm leading-6 text-[#5f5569]">
                                {event.message}
                              </p>
                            )}
                            {event.operationResult &&
                              ticket.type === "content_asset" && (
                                <div className="delivery-ticket-operation-result">
                                  <div>
                                    <strong>
                                      {event.operationResult.platform ||
                                        "交付执行结果"}
                                    </strong>
                                    <span
                                      data-result={
                                        event.operationResult.resultStatus ||
                                        "pending_confirmation"
                                      }
                                    >
                                      {operationStatus}
                                    </span>
                                  </div>
                                  {event.operationResult.platformMessage && (
                                    <p>
                                      {event.operationResult.platformMessage}
                                    </p>
                                  )}
                                  <div>
                                    <time>
                                      {displayDateTime(
                                        event.operationResult.executedAt ||
                                          event.createdAt,
                                      )}
                                    </time>
                                    {operationUrl && (
                                      <a
                                        href={operationUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                      >
                                        查看目标页面
                                        <ExternalLink className="h-3.5 w-3.5" />
                                      </a>
                                    )}
                                  </div>
                                </div>
                              )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </section>

              {detail?.attachments !== undefined && (
                <section className="grid gap-3">
                  <h3 className="text-base font-semibold text-[#281c35]">
                    附件与交付文件
                  </h3>
                  {attachments.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-[#d9cfdf] bg-white px-4 py-6 text-center text-sm text-[#71687c]">
                      暂无附件或交付文件。
                    </div>
                  ) : (
                    <div className="grid gap-2">
                      {attachmentDownloadError && (
                        <p
                          className="m-0 rounded-xl bg-[#fff1f3] px-4 py-3 text-sm text-[#a1264f]"
                          role="alert"
                        >
                          {attachmentDownloadError}
                        </p>
                      )}
                      {attachments.map((attachment) => {
                        const safeDownloadUrl = safeDeliveryAttachmentUrl(
                          attachment.downloadUrl,
                        );
                        const body = (
                          <>
                            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#f2eaf8] text-[#5b2a86]">
                              <FileText className="h-4 w-4" />
                            </span>
                            <span className="min-w-0 flex-1">
                              <strong className="block truncate text-sm font-semibold text-[#281c35]">
                                {attachment.filename}
                              </strong>
                              <small className="text-xs text-[#81788a]">
                                {attachment.kind === "deliverable"
                                  ? "交付文件"
                                  : "需求附件"}
                                {fileSize(attachment.sizeBytes)
                                  ? ` · ${fileSize(attachment.sizeBytes)}`
                                  : ""}
                                {attachment.authorization
                                  ? ` · ${
                                      AUTHORIZATION_LABELS[
                                        attachment.authorization
                                      ] || attachment.authorization
                                    }`
                                  : ""}
                              </small>
                              {(attachment.purpose ||
                                attachment.copyrightNote) && (
                                <small className="mt-1 block whitespace-normal text-xs leading-5 text-[#81788a]">
                                  {[
                                    attachment.purpose,
                                    attachment.copyrightNote,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ")}
                                </small>
                              )}
                            </span>
                            {safeDownloadUrl &&
                              (downloadingAttachmentId === attachment.id ? (
                                <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                              ) : (
                                <ExternalLink className="h-4 w-4 shrink-0" />
                              ))}
                          </>
                        );
                        return safeDownloadUrl ? (
                          <a
                            key={attachment.id}
                            href={safeDownloadUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(event) =>
                              downloadProjectAttachment(
                                event,
                                attachment,
                                safeDownloadUrl,
                              )
                            }
                            className="delivery-ticket-safe-attachment flex items-center gap-3 rounded-xl border border-[#e7dfed] bg-white p-3 text-[#5b2a86] no-underline"
                          >
                            {body}
                          </a>
                        ) : (
                          <div
                            key={attachment.id}
                            className="delivery-ticket-unsafe-attachment flex items-center gap-3 rounded-xl border border-[#e7dfed] bg-white p-3"
                          >
                            {body}
                            <small className="shrink-0 text-xs text-[#a02652]">
                              下载地址不可用
                            </small>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}

              {canReply && (
                <form
                  className="grid gap-3 rounded-2xl border border-[#e7dfed] bg-white p-4"
                  onSubmit={submitMessage}
                >
                  <div>
                    <h3 className="m-0 text-base font-semibold text-[#281c35]">
                      补充资料
                    </h3>
                    <p className="mb-0 mt-1 text-sm leading-6 text-[#71687c]">
                      {canAttach
                        ? "补充说明和附件会进入此工单，不会创建新的需求。"
                        : "补充说明会回到当前工程师的待处理队列，不会创建新的需求。"}
                    </p>
                  </div>
                  <Textarea
                    aria-label="补充说明"
                    value={message}
                    disabled={mutationPending || uploading}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="填写需要补充的企业事实、修改意见或资料说明"
                    className="min-h-24 resize-y"
                  />
                  {canAttach ? (
                    <label className="flex cursor-pointer items-center justify-between gap-3 rounded-xl border border-dashed border-[#cfc1da] bg-[#fbf8fd] px-4 py-3 text-sm text-[#665c71]">
                      <span className="inline-flex min-w-0 items-center gap-2">
                        <Upload className="h-4 w-4 shrink-0 text-[#5b2a86]" />
                        {attachmentFiles.length
                          ? `已选择 ${attachmentFiles.length} 个文件`
                          : "选择补充附件（选填）"}
                      </span>
                      <input
                        className="sr-only"
                        type="file"
                        multiple
                        aria-label="上传补充资料"
                        disabled={mutationPending || uploading}
                        onChange={(event) =>
                          setAttachmentFiles(
                            Array.from(event.target.files || []),
                          )
                        }
                      />
                    </label>
                  ) : (
                    <p className="m-0 rounded-xl bg-[#f8f4fa] px-4 py-3 text-xs leading-5 text-[#71687c]">
                      此工单只接收文字补充。请勿上传证件、密码、负责人照片或其他备案材料。
                    </p>
                  )}
                  {uploadProgress !== null && (
                    <p
                      className="m-0 text-xs font-medium text-[#71687c]"
                      role="status"
                    >
                      附件上传进度 {uploadProgress}%
                    </p>
                  )}
                  {formError && (
                    <p
                      className="m-0 rounded-xl bg-[#fff1f3] px-4 py-3 text-sm text-[#a1264f]"
                      role="alert"
                    >
                      {formError}
                    </p>
                  )}
                  <div className="flex justify-end">
                    <Button
                      type="submit"
                      disabled={
                        mutationPending ||
                        uploading ||
                        (!message.trim() && attachmentFiles.length === 0)
                      }
                    >
                      {mutationPending || uploading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Send className="h-4 w-4" />
                      )}
                      提交补充资料
                    </Button>
                  </div>
                </form>
              )}

              {formError && !canReply && (
                <p
                  className="m-0 rounded-xl bg-[#fff1f3] px-4 py-3 text-sm text-[#a1264f]"
                  role="alert"
                >
                  {formError}
                </p>
              )}
            </>
          </div>
        )}

        {ticket && !loading && !error && (
          <DialogFooter className="border-t border-[#ece6f0] px-6 py-4">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              关闭
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

import { ExternalLink, FileText, Loader2, RefreshCw } from "lucide-react";
import { type DeliveryTicketStatus } from "@shared/delivery-ticket";

export type ContentAssetTicket = {
  id: string;
  type: "content_asset";
  category?: string | null;
  categoryLabel?: string | null;
  topic?: string | null;
  title?: string | null;
  status?: DeliveryTicketStatus;
  statusLabel?: string | null;
  publicStatus?: "pending" | "completed" | null;
  publicStage?:
    | "awaiting_service"
    | "processing"
    | "action_required"
    | "completed"
    | "closed"
    | null;
  publicStageLabel?: string | null;
  submittedAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
  resolvedAt?: string | number | Date | null;
  publicSummary?: string | null;
  contentSummary?: string | null;
  preferredMedia?: string | null;
  latestPublicMessage?: string | null;
  attachmentCount?: number;
  deliveryLinks?: Array<{
    id?: string;
    label: string;
    url: string;
  }>;
};

export type ContentAssetTicketHistoryProps = {
  tickets?: ContentAssetTicket[];
  loading?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  error?: string | null;
  onOpenTicket?: (ticketId: string) => void;
  onRefresh?: () => Promise<void> | void;
  onLoadMore?: () => Promise<void> | void;
};

const COMPLETED_TICKET_STATUSES = new Set<DeliveryTicketStatus>([
  "completed",
  "rejected",
  "cancelled",
]);

function safeExternalUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function TicketList({
  tickets,
  onOpenTicket,
}: {
  tickets: ContentAssetTicket[];
  onOpenTicket?: (ticketId: string) => void;
}) {
  if (tickets.length === 0) {
    return (
      <div className="content-ticket-empty">
        <FileText size={21} aria-hidden="true" />
        <strong>暂无内容历史与交付记录</strong>
        <span>提交后的内容需求及交付结果会显示在这里。</span>
      </div>
    );
  }

  return (
    <div className="content-ticket-list">
      {tickets.map((ticket) => {
        const completed =
          ticket.publicStatus === "completed" ||
          Boolean(
            ticket.status && COMPLETED_TICKET_STATUSES.has(ticket.status),
          );
        const summary = ticket.publicSummary || ticket.contentSummary || "";
        const body = (
          <>
            <div className="content-ticket-copy">
              <span>
                {ticket.categoryLabel ||
                  ticket.title ||
                  ticket.category ||
                  "内容资产需求"}
              </span>
              <strong>{ticket.topic || "内容运营与发布需求"}</strong>
              {completed && summary && (
                <p className="content-ticket-summary">{summary}</p>
              )}
              {completed &&
                Array.isArray(ticket.deliveryLinks) &&
                ticket.deliveryLinks.length > 0 && (
                  <div className="content-ticket-links">
                    {ticket.deliveryLinks.map((link, index) => {
                      const safeUrl = safeExternalUrl(link.url);
                      return safeUrl ? (
                        <a
                          key={link.id || `${link.url}-${index}`}
                          href={safeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {link.label || "发布媒体"}
                          <ExternalLink size={13} aria-hidden="true" />
                        </a>
                      ) : null;
                    })}
                  </div>
                )}
            </div>
            <div className="content-ticket-status">
              <span
                data-status={
                  ticket.publicStage ||
                  (completed ? "completed" : "awaiting_service")
                }
              >
                {ticket.publicStageLabel ||
                  (completed ? "已完成" : "已提交")}
              </span>
            </div>
          </>
        );

        return onOpenTicket ? (
          <button
            type="button"
            className="content-ticket-row"
            key={ticket.id}
            onClick={() => onOpenTicket(ticket.id)}
          >
            {body}
          </button>
        ) : (
          <article className="content-ticket-row" key={ticket.id}>
            {body}
          </article>
        );
      })}
    </div>
  );
}

export default function ContentAssetTicketHistory({
  tickets = [],
  loading = false,
  loadingMore = false,
  hasMore = false,
  error = null,
  onOpenTicket,
  onRefresh,
  onLoadMore,
}: ContentAssetTicketHistoryProps) {
  return (
    <section className="content-ticket-history" aria-label="内容历史与交付记录">
      <header>
        <div>
          <h3>内容历史与交付记录</h3>
          <p>查看内容总结与实际发布媒体。</p>
        </div>
        {onRefresh && (
          <button type="button" onClick={() => void onRefresh()}>
            <RefreshCw size={15} aria-hidden="true" />
            刷新
          </button>
        )}
      </header>

      {loading ? (
        <div className="content-ticket-empty" role="status">
          <Loader2 className="animate-spin" size={21} aria-hidden="true" />
          <strong>正在载入内容工单…</strong>
        </div>
      ) : error ? (
        <div className="content-ticket-empty error" role="alert">
          <strong>内容工单暂时无法载入</strong>
          <span>{error}</span>
        </div>
      ) : (
        <>
          <TicketList tickets={tickets} onOpenTicket={onOpenTicket} />
          {hasMore && onLoadMore && (
            <div className="content-ticket-load-more">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void onLoadMore()}
              >
                {loadingMore ? (
                  <Loader2
                    className="animate-spin"
                    size={15}
                    aria-hidden="true"
                  />
                ) : (
                  <RefreshCw size={15} aria-hidden="true" />
                )}
                {loadingMore ? "正在载入…" : "加载更多工单"}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

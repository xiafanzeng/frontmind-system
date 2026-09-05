import {
  CheckCircle2,
  ChevronRight,
  FileClock,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useMemo, useState } from "react";
import type {
  DeliveryTicketListInput,
  DeliveryTicketType,
} from "@shared/delivery-ticket";

import DeliveryTicketDetailDialog from "@/components/DeliveryTicketDetailDialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/lib/trpc";

export type CustomerRequestHistoryItem = {
  id: string;
  type?: DeliveryTicketType;
  category?: string | null;
  categoryLabel?: string | null;
  topic?: string | null;
  title?: string | null;
  publicStatus?: "pending" | "completed" | null;
  publicStatusLabel?: string | null;
  publicSummary?: string | null;
  submittedAt?: string | number | Date | null;
  updatedAt?: string | number | Date | null;
};

type RequestHistorySurface = NonNullable<DeliveryTicketListInput["surface"]>;

export type CustomerRequestHistoryDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  type?: DeliveryTicketType;
  surface?: RequestHistorySurface;
  tickets?: CustomerRequestHistoryItem[];
  loading?: boolean;
  refreshing?: boolean;
  loadingMore?: boolean;
  hasMore?: boolean;
  error?: string | null;
  onRefresh?: () => unknown | Promise<unknown>;
  onLoadMore?: () => unknown | Promise<unknown>;
  onOpenTicket?: (ticketId: string) => void;
  preview?: boolean;
  emptyText?: string;
};

type HistoryDialogViewProps = Omit<
  CustomerRequestHistoryDialogProps,
  "surface" | "type"
> & {
  tickets: CustomerRequestHistoryItem[];
  onOpenItem?: (ticketId: string) => void;
};

export function requestHistoryTicketCanReply(input: {
  surface?: RequestHistorySurface;
  requestedType?: DeliveryTicketType;
  ticket?: {
    type?: DeliveryTicketType;
    canReply?: boolean;
  } | null;
}) {
  const replySurface =
    input.surface === "website_management" ||
    input.requestedType === "content_asset";
  return Boolean(
    replySurface &&
      (input.ticket?.type === "website_operation" ||
        input.ticket?.type === "content_asset") &&
      input.ticket?.canReply,
  );
}

function displayDateTime(value: string | number | Date | null | undefined) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function RequestHistoryDialogView({
  open,
  onOpenChange,
  title,
  description,
  tickets,
  loading = false,
  refreshing = false,
  loadingMore = false,
  hasMore = false,
  error = null,
  onRefresh,
  onLoadMore,
  onOpenItem,
  preview = false,
  emptyText = "提交需求后，处理记录会显示在这里。",
}: HistoryDialogViewProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100vh-2rem)] overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-2 text-[#5b2a86]">
            <FileClock className="h-4 w-4" aria-hidden="true" />
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[58vh] gap-3 overflow-y-auto py-2">
          {loading ? (
            <div className="flex items-center gap-2 rounded-xl border p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              正在载入需求记录…
            </div>
          ) : error ? (
            <div
              className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700"
              role="alert"
            >
              {error}
            </div>
          ) : tickets.length === 0 ? (
            <div className="rounded-xl border p-5 text-sm text-muted-foreground">
              {emptyText}
            </div>
          ) : (
            tickets.map((item) => {
              const completed = item.publicStatus === "completed";
              const updatedAt = displayDateTime(
                item.updatedAt || item.submittedAt,
              );
              const canOpen = Boolean(onOpenItem && !preview);
              return (
                <button
                  type="button"
                  key={item.id}
                  className="grid w-full gap-2 rounded-xl border bg-white p-4 text-left transition hover:border-[#bda8cc] hover:bg-[#fbf8fd] disabled:cursor-default disabled:hover:border-border disabled:hover:bg-white"
                  disabled={!canOpen}
                  onClick={() => onOpenItem?.(item.id)}
                >
                  <span className="flex items-center justify-between gap-3">
                    <strong className="text-sm text-foreground">
                      {item.categoryLabel || item.title || "客户需求"}
                    </strong>
                    <span
                      className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        completed
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-red-50 text-red-700"
                      }`}
                      data-status={completed ? "completed" : "pending"}
                    >
                      {completed && <CheckCircle2 className="h-3.5 w-3.5" />}
                      {completed ? "已完成" : "待处理"}
                    </span>
                  </span>
                  {(item.topic || item.title) && (
                    <span className="text-sm leading-6 text-foreground">
                      {item.topic || item.title}
                    </span>
                  )}
                  <span className="flex items-end justify-between gap-3">
                    <span className="min-w-0 text-xs leading-5 text-muted-foreground">
                      {item.publicSummary ||
                        (completed
                          ? "查看公开处理结果。"
                          : "服务团队正在处理，状态会自动同步。")}
                      {updatedAt ? ` · 更新于 ${updatedAt}` : ""}
                    </span>
                    {canOpen && (
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    )}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          {hasMore && onLoadMore && (
            <Button
              type="button"
              variant="outline"
              disabled={loadingMore}
              onClick={() => void onLoadMore()}
            >
              {loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}
              {loadingMore ? "正在载入…" : "加载更多"}
            </Button>
          )}
          {onRefresh && (
            <Button
              type="button"
              variant="outline"
              disabled={refreshing || preview}
              onClick={() => void onRefresh()}
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshing ? "animate-spin" : ""}`}
              />
              刷新
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function QueriedCustomerRequestHistoryDialog(
  props: CustomerRequestHistoryDialogProps,
) {
  const deliveryTicketApi = (trpc.workspace as any).deliveryTickets;
  const query = deliveryTicketApi.list.useInfiniteQuery(
    {
      ...(props.type ? { type: props.type } : {}),
      ...(props.surface ? { surface: props.surface } : {}),
      limit: 20,
    },
    {
      enabled: props.open && !props.preview,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: true,
      refetchInterval: props.open && !props.preview ? 30_000 : false,
      refetchIntervalInBackground: false,
      getNextPageParam: (lastPage: any) => lastPage?.nextCursor ?? undefined,
    },
  );
  const tickets = useMemo<CustomerRequestHistoryItem[]>(
    () =>
      (query.data?.pages || []).flatMap(
        (page: { tickets?: CustomerRequestHistoryItem[] }) =>
          page?.tickets || [],
      ),
    [query.data],
  );
  const [detailTicketId, setDetailTicketId] = useState<string | null>(null);
  const detailQuery = deliveryTicketApi.detail.useQuery(
    {
      ticketId: detailTicketId || "00000000-0000-4000-8000-000000000000",
    },
    {
      enabled: Boolean(detailTicketId) && !props.preview,
      retry: false,
      refetchOnWindowFocus: true,
      refetchInterval: detailTicketId && !props.preview ? 30_000 : false,
      refetchIntervalInBackground: false,
    },
  );
  const addMessageMutation = deliveryTicketApi.addMessage.useMutation();
  const detailTicket = detailQuery.data?.ticket;
  const canReply = requestHistoryTicketCanReply({
    surface: props.surface,
    requestedType: props.type,
    ticket: detailTicket,
  });
  const openDetail = (ticketId: string) => {
    setDetailTicketId(ticketId);
  };

  return (
    <>
      <RequestHistoryDialogView
        {...props}
        tickets={tickets}
        loading={query.isLoading}
        refreshing={query.isFetching}
        loadingMore={query.isFetchingNextPage}
        hasMore={Boolean(query.hasNextPage)}
        error={
          query.isError
            ? query.error?.message || "需求记录暂时无法载入。"
            : null
        }
        onRefresh={() => query.refetch()}
        onLoadMore={() => query.fetchNextPage()}
        onOpenItem={openDetail}
      />
      <DeliveryTicketDetailDialog
        open={Boolean(detailTicketId)}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDetailTicketId(null);
        }}
        ticketId={detailTicketId}
        detail={detailQuery.data}
        loading={detailQuery.isLoading}
        error={
          detailQuery.isError
            ? detailQuery.error?.message || "需求详情暂时无法载入。"
            : null
        }
        canMutate={canReply}
        mutationPending={addMessageMutation.isPending}
        readOnlyReason={
          canReply ? null : "该页面仅用于查看需求与公开处理记录。"
        }
        onRefresh={() => detailQuery.refetch()}
        onSubmitMessage={async (input) => {
          await addMessageMutation.mutateAsync(input);
          await Promise.all([detailQuery.refetch(), query.refetch()]);
        }}
        onChanged={async () => {
          await Promise.all([detailQuery.refetch(), query.refetch()]);
        }}
      />
    </>
  );
}

export default function CustomerRequestHistoryDialog(
  props: CustomerRequestHistoryDialogProps,
) {
  if (props.tickets === undefined) {
    if (!props.open) return null;
    return <QueriedCustomerRequestHistoryDialog {...props} />;
  }
  const openItem = props.onOpenTicket
    ? (ticketId: string) => {
        props.onOpenChange(false);
        props.onOpenTicket?.(ticketId);
      }
    : undefined;
  return (
    <RequestHistoryDialogView
      {...props}
      tickets={props.tickets}
      onOpenItem={openItem}
    />
  );
}

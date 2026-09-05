import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import DeliveryTicketDetailDialog, {
  customerVisibleTicketEvents,
  safeDeliveryAttachmentUrl,
} from "./DeliveryTicketDetailDialog";

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(),
}));

vi.mock("@/lib/frontmind-api", () => ({
  uploadFile: (...args: unknown[]) => uploadFileMock(...args),
}));

const detail = {
  ticket: {
    id: "ticket-1",
    type: "content_asset" as const,
    title: "用户案例与成功故事",
    topic: "制造业客户案例",
    description: "整理已核验的客户交付事实。",
    materialUrls: ["https://example.com/source"],
    status: "needs_information" as const,
    statusLabel: "待补充资料",
    revision: 2,
    submittedAt: "2026-07-27T08:00:00+08:00",
    scheduledAt: null,
  },
  events: [
    {
      id: "event-1",
      visibility: "customer",
      actorRole: "admin",
      actorLabel: "交付管理员",
      message: "请补充客户书面授权。",
      createdAt: "2026-07-27T09:00:00+08:00",
      fromStatus: "submitted" as const,
      toStatus: "needs_information" as const,
    },
    {
      id: "internal-event",
      visibility: "internal",
      actorRole: "admin",
      actorLabel: "交付管理员",
      message: "内部备注不得返回用户。",
      createdAt: "2026-07-27T09:30:00+08:00",
    },
    {
      id: "delivery-event",
      visibility: "customer",
      actorRole: "admin",
      actorLabel: "交付管理员",
      message: "已提交页面复检。",
      createdAt: "2026-07-27T10:00:00+08:00",
      operationResult: {
        platform: "百度站长平台",
        targetUrl: "https://example.com/page",
        executedAt: "2026-07-27T10:00:00+08:00",
        resultStatus: "pending_confirmation",
        platformMessage: "平台已接收请求，等待后续确认。",
      },
    },
  ],
  attachments: [
    {
      id: "attachment-1",
      filename: "客户授权书.pdf",
      kind: "deliverable" as const,
      authorization: "licensed",
      purpose: "客户案例授权",
      downloadUrl:
        "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
    },
    {
      id: "attachment-unsafe",
      filename: "外部可疑文件.pdf",
      kind: "deliverable" as const,
      downloadUrl: "https://evil.example/files/authorization.pdf",
    },
  ],
};

describe("DeliveryTicketDetailDialog", () => {
  it("labels knowledge and approval demands correctly and keeps them read-only", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={{
          ticket: {
            id: "knowledge-ticket",
            type: "knowledge_base",
            categoryLabel: "问题审核",
            topic: "品牌是否可靠？",
            publicStatus: "pending",
            revision: 1,
            canReply: true,
          },
          events: [],
        }}
        canMutate
        onSubmitMessage={vi.fn()}
      />,
    );

    expect(screen.getByText("知识库需求")).toBeInTheDocument();
    expect(screen.queryByLabelText("补充说明")).not.toBeInTheDocument();
  });

  it("renders the strict customer DTO without raw status or attachment data", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={{
          ticket: {
            id: "ticket-public",
            type: "content_asset",
            category: "D1",
            categoryLabel: "知乎问答",
            topic: "品牌事实问答",
            publicStatus: "pending",
            publicStatusLabel: "待处理",
            publicSummary: null,
            preferredMedia: "新浪",
            deliveryLinks: [],
            revision: 3,
            canReply: true,
          },
          events: [
            {
              id: "public-event",
              actorRole: "admin",
              actorLabel: "服务团队",
              message: "这是经过公开过滤的回复。",
              createdAt: "2026-07-28T09:00:00+08:00",
            },
            {
              id: "public-empty-event",
              actorRole: "system",
              actorLabel: "服务团队",
              message: null,
              createdAt: "2026-07-28T10:00:00+08:00",
            },
          ],
        }}
        canMutate
        onAddMessage={vi.fn()}
      />,
    );

    expect(screen.getByText("这是经过公开过滤的回复。")).toBeInTheDocument();
    expect(screen.getByText("需求记录已更新。")).toBeInTheDocument();
    expect(screen.getByText("意向媒体：新浪")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "取消需求" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("附件与交付文件")).not.toBeInTheDocument();
  });

  it("renders empty status-change messages without exposing internal states", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={{
          ticket: {
            id: "ticket-empty-event",
            type: "content_asset",
            category: "future_category",
            topic: "future_category",
            publicStatus: "pending",
            publicStatusLabel: "待处理",
            revision: 1,
          },
          events: [
            {
              id: "empty-status-change",
              actorRole: "delivery_member",
              actorLabel: "delivery_member",
              message: null,
              fromStatus: "submitted",
              toStatus: "in_progress",
              createdAt: "2026-07-28T10:00:00+08:00",
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("需求状态更新为待处理。")).toBeInTheDocument();
    expect(screen.getByText("服务团队")).toBeInTheDocument();
    expect(screen.queryByText(/submitted|in_progress/)).not.toBeInTheDocument();
    expect(screen.queryByText("已提交 → 处理中")).not.toBeInTheDocument();
    expect(screen.queryByText(/^delivery_member$/)).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "需求详情" }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^future_category$/)).not.toBeInTheDocument();
  });

  it("shows the customer-visible timeline and downloadable deliverables", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        canMutate
      />,
    );

    expect(screen.getByText("请补充客户书面授权。")).toBeInTheDocument();
    expect(screen.getByText("待处理")).toBeInTheDocument();
    expect(screen.queryByText("已提交 → 待补充资料")).not.toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /客户授权书.pdf/ }),
    ).toHaveAttribute(
      "href",
      "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
    );
    expect(screen.getByText(/客户案例授权/)).toBeInTheDocument();
    expect(
      screen.queryByText("内部备注不得返回用户。"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("百度站长平台")).toBeInTheDocument();
    expect(
      screen.getByText("平台已接收请求，等待后续确认。"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /外部可疑文件.pdf/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("下载地址不可用")).toBeInTheDocument();
  });

  it("adds a message to the same ticket with optional files", async () => {
    const onAddMessage = vi.fn().mockResolvedValue(undefined);
    const file = new File(["facts"], "补充资料.pdf", {
      type: "application/pdf",
    });
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        canMutate
        onAddMessage={onAddMessage}
      />,
    );

    fireEvent.change(screen.getByLabelText("补充说明"), {
      target: { value: "已补充客户授权资料" },
    });
    fireEvent.change(screen.getByLabelText("上传补充资料"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交补充资料" }));

    await waitFor(() =>
      expect(onAddMessage).toHaveBeenCalledWith({
        message: "已补充客户授权资料",
        attachmentFiles: [file],
      }),
    );
  });

  it("never exposes customer-side cancellation for a submitted ticket", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={detail}
        canMutate
      />,
    );

    expect(
      screen.queryByRole("button", { name: "取消需求" }),
    ).not.toBeInTheDocument();
  });

  it("uploads attachments before calling the file-ID message callback", async () => {
    uploadFileMock.mockImplementation(
      async (_file: File, onProgress?: (percent: number) => void) => {
        onProgress?.(100);
        return {
          fileId: "uploaded-file-id",
          filename: "补充资料.pdf",
        };
      },
    );
    const onSubmitMessage = vi.fn().mockResolvedValue(undefined);
    const file = new File(["facts"], "补充资料.pdf", {
      type: "application/pdf",
    });
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        ticketId="ticket-1"
        detail={detail}
        canMutate
        onSubmitMessage={onSubmitMessage}
      />,
    );

    fireEvent.change(screen.getByLabelText("补充说明"), {
      target: { value: "已补充正式资料" },
    });
    fireEvent.change(screen.getByLabelText("上传补充资料"), {
      target: { files: [file] },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交补充资料" }));

    await waitFor(() =>
      expect(uploadFileMock).toHaveBeenCalledWith(file, expect.any(Function)),
    );
    await waitFor(() =>
      expect(onSubmitMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          ticketId: "ticket-1",
          clientRequestId: expect.any(String),
          message: "已补充正式资料",
          attachments: [
            expect.objectContaining({
              fileId: "uploaded-file-id",
              filename: "补充资料.pdf",
              mimeType: "application/pdf",
              sizeBytes: file.size,
            }),
          ],
        }),
      ),
    );
  });

  it("hides cancellation after scheduling", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={{
          ...detail,
          ticket: { ...detail.ticket, status: "scheduled" },
        }}
        canMutate
      />,
    );

    expect(
      screen.queryByRole("button", { name: "取消需求" }),
    ).not.toBeInTheDocument();
  });

  it("shows the public timeline and attachments for a completed website ticket", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={{
          ticket: {
            ...detail.ticket,
            type: "website_operation",
            status: "completed",
            publicStatus: "completed",
            publicSummary: "已完成企业新闻页面内容更新。",
            targetPage: "https://example.com/news",
            canReply: false,
            canAttach: true,
          },
          events: detail.events,
          attachments: detail.attachments,
        }}
        canMutate
      />,
    );

    expect(
      screen.getByText("已完成企业新闻页面内容更新。"),
    ).toBeInTheDocument();
    expect(screen.getByText("处理时间线")).toBeInTheDocument();
    expect(screen.getByText("附件与交付文件")).toBeInTheDocument();
    expect(screen.getByText("请补充客户书面授权。")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /目标页面/ }),
    ).not.toBeInTheDocument();
  });

  it("lets the customer answer a website supplement request without sensitive attachments", () => {
    render(
      <DeliveryTicketDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={{
          ticket: {
            ...detail.ticket,
            type: "website_operation",
            category: "icp_filing",
            status: "needs_information",
            publicStatus: "pending",
            publicSummary: "请补充 ICP 主体备案号的文字说明。",
            targetPage: "https://example.com/news",
            canReply: true,
            canAttach: false,
          },
          events: detail.events,
          attachments: detail.attachments,
        }}
        canMutate
        onAddMessage={vi.fn()}
      />,
    );

    expect(
      screen.getByText("请补充 ICP 主体备案号的文字说明。"),
    ).toBeInTheDocument();
    expect(screen.getByText("处理时间线")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "提交补充资料" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("上传补充资料")).not.toBeInTheDocument();
    expect(screen.getByText(/此需求只接收文字补充/)).toBeInTheDocument();
  });
});

describe("DeliveryTicketDetailDialog safety helpers", () => {
  it("allows only customer events and same-origin attachment endpoints", () => {
    expect(
      customerVisibleTicketEvents(detail.events).map((event) => event.id),
    ).toEqual(["event-1", "delivery-event"]);
    expect(
      safeDeliveryAttachmentUrl(
        "https://evil.example/file",
        "https://dashboard.frontmind.net",
      ),
    ).toBeNull();
    expect(
      safeDeliveryAttachmentUrl(
        "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
        "https://dashboard.frontmind.net",
      ),
    ).toBe(
      "/api/delivery-ticket-attachments/4a67e445-37bb-45ed-9268-4ca9437e4d70/content",
    );
  });
});

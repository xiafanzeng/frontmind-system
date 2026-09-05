import {
  deliveryWorkflowOperationSchema,
  type DeliveryRoleType,
  type DeliveryWorkflowOperation,
} from "@shared/delivery-roles";
import { DELIVERY_OPERATION_SPECS } from "@shared/delivery-operation-spec";
import type { DeliveryTicketStatus } from "@shared/delivery-ticket";

export type DeliveryRoleWorkflowDefinition = {
  roleType: DeliveryRoleType;
  sequence: number;
  mission: string;
  receives: string;
  delivers: string;
  handoff: string;
  responsibilities: readonly string[];
};

export const DELIVERY_ROLE_ORDER = [
  "ai_operations_engineer",
  "monitoring_optimization_engineer",
  "content_distribution_engineer",
] as const satisfies readonly DeliveryRoleType[];

export const DELIVERY_ROLE_WORKFLOWS: Record<
  DeliveryRoleType,
  DeliveryRoleWorkflowDefinition
> = {
  ai_operations_engineer: {
    roleType: "ai_operations_engineer",
    sequence: 1,
    mission: "把客户资料和官网基础设施整理成可交付、可核验的事实与页面。",
    receives: "客户资料、知识库异常、域名与备案结果、已确认内容资产",
    delivers: "正式知识库、可访问官网页面、域名备案结果与站点检查结论",
    handoff: "知识与页面就绪后，交给监控与优化工程师建立问题基线。",
    responsibilities: [
      "处理知识库构建异常、维护和重置",
      "办理域名、备案、官网风格样例和页面发布",
      "检查页面可访问性、内容呈现和站点状态",
    ],
  },
  monitoring_optimization_engineer: {
    roleType: "monitoring_optimization_engineer",
    sequence: 2,
    mission: "把客户目标转成可监控的问题，并用真实回答和信源判断效果。",
    receives: "已发布知识库、客户选题、内容发布结果和历史监控基线",
    delivers: "品牌词库、监控答案与信源、复测结论和阶段效果报告",
    handoff: "发现表达缺口后，交给内容制作工程师制作应答逻辑和内容。",
    responsibilities: [
      "配置品牌词库并审核客户选题",
      "执行首次监控、数据导入和内容发布后复测",
      "形成有证据的阶段效果报告并决定是否继续优化",
    ],
  },
  content_distribution_engineer: {
    roleType: "content_distribution_engineer",
    sequence: 3,
    mission: "把监控发现的表达缺口转成可发布内容，并留下可追踪的分发结果。",
    receives: "已确认问题、监控缺口、品牌事实和当前应答逻辑",
    delivers: "应答逻辑、AI 友好内容资产、渠道发布链接和执行记录",
    handoff: "内容发布完成后，回交监控与优化工程师复测，形成优化闭环。",
    responsibilities: [
      "制作和修订问题应答逻辑",
      "生成、校验并发布 AI 友好内容资产",
      "完成媒体渠道分发并登记公开链接和执行结果",
    ],
  },
};

export const DELIVERY_OPERATION_LABELS: Record<
  DeliveryWorkflowOperation,
  string
> = Object.freeze(
  // Keep the client-facing map for existing callers, but derive every value
  // from the shared contract so forms and labels cannot drift apart.
  Object.fromEntries(
    deliveryWorkflowOperationSchema.options.map((operation) => [
      operation,
      DELIVERY_OPERATION_SPECS[operation].label,
    ]),
  ) as Record<DeliveryWorkflowOperation, string>,
);

export function deliveryTicketDisplayDescription(ticket: {
  operation?: DeliveryWorkflowOperation | string | null;
  category?: string | null;
  topic?: string | null;
  description?: string | null;
}) {
  if (ticket.operation !== "question_maintenance") {
    return ticket.description || "";
  }
  try {
    const payload = JSON.parse(ticket.description || "") as {
      questionSnapshot?: unknown;
      proposedQuestion?: unknown;
      reason?: unknown;
    };
    const question =
      typeof payload.questionSnapshot === "string" &&
      payload.questionSnapshot.trim()
        ? payload.questionSnapshot.trim()
        : ticket.topic?.trim() || "未记录的问题";
    const reason =
      typeof payload.reason === "string" && payload.reason.trim()
        ? `\n申请说明：${payload.reason.trim()}`
        : "";
    if (ticket.category === "question_review") {
      return `申请审核自主填写问题“${question}”。${reason}`;
    }
    if (ticket.category === "question_modify") {
      const proposed =
        typeof payload.proposedQuestion === "string" &&
        payload.proposedQuestion.trim()
          ? payload.proposedQuestion.trim()
          : "未填写";
      return `申请将问题“${question}”修改为“${proposed}”。${reason}`;
    }
    if (ticket.category === "question_delete") {
      return `申请删除问题“${question}”。${reason}`;
    }
    return `申请清空问题“${question}”的已确认应答逻辑。${reason}`;
  } catch {
    return "问题维护申请内容暂时无法解析，请使用专用审批入口核对。";
  }
}

export type DeliveryTicketActionGuidance = {
  label: string;
  description: string;
  priority: number;
  waiting: boolean;
};

export function deliveryTicketActionGuidance(
  status: DeliveryTicketStatus,
): DeliveryTicketActionGuidance {
  switch (status) {
    case "in_progress":
      return {
        label: "继续处理并交付",
        description: "完成实际交付、核对用户页面，再回填结果并结束需求。",
        priority: 0,
        waiting: false,
      };
    case "submitted":
      return {
        label: "领取并开始处理",
        description: "先核对客户需求和附件，再将需求切换为处理中。",
        priority: 1,
        waiting: false,
      };
    case "scheduled":
      return {
        label: "按排期开始处理",
        description: "排期已经确认；开始执行时将需求切换为处理中。",
        priority: 2,
        waiting: false,
      };
    case "needs_information":
      return {
        label: "等待客户补充",
        description:
          "缺少的资料已向客户说明；收到补充后继续原需求，不新建需求。",
        priority: 3,
        waiting: true,
      };
    case "completed":
      return {
        label: "已完成交付",
        description: "结果已进入客户历史记录，可在任务记录中复核。",
        priority: 4,
        waiting: false,
      };
    case "rejected":
      return {
        label: "未受理",
        description: "需求已经结束，拒绝原因保留在处理记录中。",
        priority: 5,
        waiting: false,
      };
    case "cancelled":
      return {
        label: "已取消",
        description: "需求已经取消，不再进入交付队列。",
        priority: 6,
        waiting: false,
      };
  }
}

export function sortDeliveryTicketsByAction<
  T extends {
    status: DeliveryTicketStatus;
    updatedAt?: Date | string | number | null;
    createdAt?: Date | string | number | null;
  },
>(tickets: readonly T[]): T[] {
  return [...tickets].sort((left, right) => {
    const priorityDelta =
      deliveryTicketActionGuidance(left.status).priority -
      deliveryTicketActionGuidance(right.status).priority;
    if (priorityDelta !== 0) return priorityDelta;
    return (
      dateValue(left.updatedAt ?? left.createdAt) -
      dateValue(right.updatedAt ?? right.createdAt)
    );
  });
}

export function deliveryTicketDependencyBlockReason(
  ticket: {
    operation?: DeliveryWorkflowOperation | string | null;
    status: DeliveryTicketStatus | string;
  },
  projectTickets: readonly {
    operation?: DeliveryWorkflowOperation | string | null;
    status: DeliveryTicketStatus | string;
  }[],
) {
  if (
    ticket.operation === "initial_monitoring" &&
    ticket.status !== "completed" &&
    !projectTickets.some(
      (candidate) =>
        candidate.operation === "question_catalog" &&
        candidate.status === "completed",
    )
  ) {
    return "请先完成“配置品牌词库”并确认至少一条优化问题，随后才能开始首次监控。";
  }
  return null;
}

export function sortDeliveryProjectTicketsByAction<
  T extends {
    operation?: DeliveryWorkflowOperation | string | null;
    status: DeliveryTicketStatus;
    updatedAt?: Date | string | number | null;
    createdAt?: Date | string | number | null;
  },
>(tickets: readonly T[]) {
  const sorted = sortDeliveryTicketsByAction(tickets);
  return sorted.sort(
    (left, right) =>
      Number(Boolean(deliveryTicketDependencyBlockReason(left, tickets))) -
      Number(Boolean(deliveryTicketDependencyBlockReason(right, tickets))),
  );
}

function dateValue(value: Date | string | number | null | undefined) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const timestamp = new Date(value).getTime();
    return Number.isNaN(timestamp) ? 0 : timestamp;
  }
  return 0;
}

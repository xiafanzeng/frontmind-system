import {
  ArrowRight,
  CheckCircle2,
  RotateCcw,
  ShieldCheck,
  UserCog,
  UserRound,
} from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import {
  DELIVERY_ROLE_ORDER,
  DELIVERY_ROLE_WORKFLOWS,
} from "@/lib/delivery-workflow";
import {
  DELIVERY_ROLE_LABELS,
  type DeliveryRoleType,
} from "@shared/delivery-roles";

export type DeliveryWorkflowRoleState = {
  enabled: boolean;
  ownerLabel?: string | null;
  openTicketCount?: number;
};

export default function DeliveryWorkflowGuide({
  activeRole,
  roleStates,
  audience = "engineer",
}: {
  activeRole?: DeliveryRoleType | null;
  roleStates?: Partial<Record<DeliveryRoleType, DeliveryWorkflowRoleState>>;
  audience?: "engineer" | "admin";
}) {
  if (audience === "engineer" && activeRole) {
    const definition = DELIVERY_ROLE_WORKFLOWS[activeRole];
    return (
      <section className="rounded-2xl border bg-card p-5 sm:p-6">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="font-semibold">我的岗位职责</h2>
            <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
              这里只展示当前岗位需要完成的工作；请按需求执行，并登记可核验的交付结果。
            </p>
          </div>
          <Badge className="w-fit shrink-0">当前岗位</Badge>
        </div>

        <article className="mt-4 rounded-2xl border border-primary bg-primary/[0.045] p-4 ring-1 ring-primary/20">
          <h3 className="font-semibold">{DELIVERY_ROLE_LABELS[activeRole]}</h3>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            {definition.mission}
          </p>
          <ul className="mt-3 space-y-1.5 border-t pt-3 text-xs leading-5 text-muted-foreground">
            {definition.responsibilities.map((item) => (
              <li key={item} className="flex items-start gap-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">
            <strong className="text-foreground">完成标准：</strong>
            {definition.delivers}
          </p>
        </article>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border bg-card p-5 sm:p-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="font-semibold">项目交付协作链</h2>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-muted-foreground">
            交付管理员负责配齐岗位、确认负责人和协调异常；工程师负责岗位需求执行，系统管理员可在异常场景接管处理。
          </p>
        </div>
        <Badge variant="outline" className="w-fit shrink-0">
          监控复测形成闭环
        </Badge>
      </div>

      <div className="mt-4 grid gap-2 text-xs leading-5 text-muted-foreground sm:grid-cols-3">
        <p className="rounded-xl border bg-muted/20 px-3 py-2">
          <strong className="text-foreground">流程</strong>
          ：描述客户从资料、监控、内容到复测的完整结果路径。
        </p>
        <p className="rounded-xl border bg-muted/20 px-3 py-2">
          <strong className="text-foreground">需求</strong>
          ：流程中只交给一个岗位、可独立验收的一次执行任务。
        </p>
        <p className="rounded-xl border bg-muted/20 px-3 py-2">
          <strong className="text-foreground">交接</strong>
          ：完成需求时登记结构化结果，由系统幂等创建下一张需求。
        </p>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <WorkflowActorCard
          icon={<UserRound className="h-4 w-4" />}
          title="客户"
          responsibility="发起需求、补充资料、选择方案并确认自己看到的结果；不负责判断内部岗位和需求流转。"
          boundary="客户只看到对外状态、交付摘要和公开结果。"
        />
        <WorkflowActorCard
          icon={<UserCog className="h-4 w-4" />}
          title="交付管理员"
          responsibility="配置客户项目团队、协调优先级与异常、回复客户并催办对应岗位。"
          boundary="不代替工程师上传、发布或完成岗位需求。"
        />
        <WorkflowActorCard
          icon={<ShieldCheck className="h-4 w-4" />}
          title="系统管理员"
          responsibility="维护全局权限、共享凭据、服务额度和无法由正常岗位完成的异常接管。"
          boundary="默认不参与日常交付，只在治理或异常场景介入。"
        />
      </div>

      <div className="mt-5 grid gap-3 xl:grid-cols-[1fr_auto_1fr_auto_1fr] xl:items-stretch">
        {DELIVERY_ROLE_ORDER.map((roleType, index) => {
          const definition = DELIVERY_ROLE_WORKFLOWS[roleType];
          const state = roleStates?.[roleType];
          const enabled = state?.enabled !== false;
          const highlighted = activeRole === roleType;
          return (
            <div key={roleType} className="contents">
              <article
                className={`rounded-2xl border p-4 ${
                  highlighted
                    ? "border-primary bg-primary/[0.045] ring-1 ring-primary/20"
                    : enabled
                      ? "bg-muted/20"
                      : "bg-muted/10 opacity-60"
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold text-primary">
                      第 {definition.sequence} 岗
                    </p>
                    <h3 className="mt-1 font-semibold">
                      {DELIVERY_ROLE_LABELS[roleType]}
                    </h3>
                  </div>
                  {highlighted ? (
                    <Badge>当前岗位</Badge>
                  ) : state ? (
                    <Badge variant={enabled ? "secondary" : "outline"}>
                      {enabled ? "套餐已启用" : "套餐未启用"}
                    </Badge>
                  ) : null}
                </div>

                <p className="mt-3 text-sm leading-6 text-muted-foreground">
                  {definition.mission}
                </p>

                {state && enabled && (
                  <div className="mt-3 rounded-xl border bg-background/80 p-3 text-xs">
                    <p className="flex items-center gap-1.5 font-medium">
                      <UserRound className="h-3.5 w-3.5" />
                      {state.ownerLabel || "负责人待分配"}
                    </p>
                    <p className="mt-1 text-muted-foreground">
                      未结束需求 {state.openTicketCount ?? 0} 个
                    </p>
                  </div>
                )}

                {highlighted && (
                  <ul className="mt-3 space-y-1.5 border-t pt-3 text-xs leading-5 text-muted-foreground">
                    {definition.responsibilities.map((item) => (
                      <li key={item} className="flex items-start gap-2">
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                )}

                <p className="mt-3 border-t pt-3 text-xs leading-5 text-muted-foreground">
                  <strong className="text-foreground">交接：</strong>
                  {definition.handoff}
                </p>
              </article>

              {index < DELIVERY_ROLE_ORDER.length - 1 && (
                <div className="hidden items-center justify-center text-muted-foreground xl:flex">
                  <ArrowRight className="h-5 w-5" />
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="mt-4 flex items-start gap-2 rounded-xl bg-muted/35 px-3 py-2 text-xs leading-5 text-muted-foreground">
        <RotateCcw className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        内容发布不是流程终点：分发结果必须回到监控岗位复测；未达到目标时沿原问题继续生成下一轮优化需求。
      </p>
    </section>
  );
}

function WorkflowActorCard({
  icon,
  title,
  responsibility,
  boundary,
}: {
  icon: ReactNode;
  title: string;
  responsibility: string;
  boundary: string;
}) {
  return (
    <article className="rounded-xl border bg-background px-4 py-3 text-sm">
      <div className="flex items-center gap-2 font-semibold">
        <span className="text-primary">{icon}</span>
        {title}
      </div>
      <p className="mt-2 leading-6 text-muted-foreground">{responsibility}</p>
      <p className="mt-2 border-t pt-2 text-xs leading-5 text-muted-foreground">
        <strong className="text-foreground">边界：</strong>
        {boundary}
      </p>
    </article>
  );
}

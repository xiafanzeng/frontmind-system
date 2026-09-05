import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";

import Home from "@/pages/Home";
import PortalShell from "@/components/PortalShell";
import { Button } from "@/components/ui/button";
import { ConversationProvider } from "@/contexts/ConversationContext";
import { useResumePolling } from "@/hooks/useResumePolling";
import { trpc } from "@/lib/trpc";
import { deliveryMemberNavForRole } from "@/pages/DeliveryMemberDashboard";
import { DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY } from "@/lib/frontmind-api";
import { DELIVERY_ROLE_LABELS } from "@shared/delivery-roles";

function ProjectAgentHome() {
  useResumePolling();
  return (
    <Home
      embedded
      hidePortalNavigation
      showKnowledgeBaseStarter={false}
      showAccountMenu={false}
      showSettings={false}
      standardWelcomeVariant="workflow"
    />
  );
}

export default function DeliveryMemberAgent() {
  const assignments = trpc.delivery.mine.assignments.useQuery();
  const [projectAssignmentId, setProjectAssignmentId] = useState(() =>
    typeof window === "undefined"
      ? ""
      : sessionStorage.getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY) || "",
  );
  const currentAssignment = assignments.data?.find(
    (assignment) => assignment.projectAssignmentId === projectAssignmentId,
  );
  useEffect(() => {
    if (!assignments.data) return;
    if (!assignments.data.length) {
      sessionStorage.removeItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY);
      setProjectAssignmentId("");
      return;
    }
    if (
      !assignments.data.some(
        (assignment) => assignment.projectAssignmentId === projectAssignmentId,
      )
    ) {
      const nextProjectAssignmentId = assignments.data[0]!.projectAssignmentId;
      sessionStorage.setItem(
        DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
        nextProjectAssignmentId,
      );
      setProjectAssignmentId(nextProjectAssignmentId);
    }
  }, [assignments.data, projectAssignmentId]);
  return (
    <PortalShell
      mode="fullscreen"
      eyebrow="工程师 · 工具"
      title="通用智能体"
      navItems={deliveryMemberNavForRole(currentAssignment?.roleType)}
      toolbar={
        assignments.data?.length ? (
          <div className="flex items-center gap-2">
            {assignments.data?.length ? (
              <select
                aria-label="当前客户项目"
                className="h-10 rounded-md border bg-card px-3 text-sm"
                value={projectAssignmentId}
                onChange={(event) => {
                  sessionStorage.setItem(
                    DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY,
                    event.target.value,
                  );
                  setProjectAssignmentId(event.target.value);
                }}
              >
                {assignments.data.map((assignment) => (
                  <option
                    key={assignment.projectAssignmentId}
                    value={assignment.projectAssignmentId}
                  >
                    {assignment.customerName || assignment.customerUsername} ·{" "}
                    {DELIVERY_ROLE_LABELS[assignment.roleType]}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        ) : undefined
      }
    >
      <section className="h-full min-h-0 overflow-hidden bg-white">
        {assignments.error ? (
          <div className="grid h-full place-items-center p-6 text-center">
            <div>
              <AlertTriangle className="mx-auto h-8 w-8 text-destructive" />
              <p className="mt-4 font-medium">客户项目读取失败</p>
              <p className="mt-2 text-sm text-muted-foreground">
                {assignments.error.message || "请检查网络连接后重试。"}
              </p>
              <Button
                className="mt-5"
                variant="outline"
                onClick={() => void assignments.refetch()}
              >
                <RefreshCw className="h-4 w-4" />
                重试
              </Button>
            </div>
          </div>
        ) : assignments.isLoading ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在载入客户项目
            </span>
          </div>
        ) : currentAssignment ? (
          <ConversationProvider
            key={projectAssignmentId}
            projectAssignmentId={projectAssignmentId}
          >
            <ProjectAgentHome />
          </ConversationProvider>
        ) : (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            尚未分配客户项目，请联系交付管理员
          </div>
        )}
      </section>
    </PortalShell>
  );
}

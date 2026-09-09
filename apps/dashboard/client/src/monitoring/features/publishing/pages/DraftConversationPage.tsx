import { usePublishingFlow } from "../PublishingFlowContext";
import { usePublishingChoice } from "../components/PublishingConversation";
import {
  WorkflowCompleted,
  WorkflowSection,
} from "@/dashboard/workflow/Workflow";
import { requestWorkspaceNavigation } from "@/lib/workspace-navigation-guard";
import TitlesPage from "./TitlesPage";
import ReviewPage from "./ReviewPage";
import PublicationDetailPage from "./PublicationDetailPage";

export default function DraftConversationPage({
  draftId,
  initialStage,
}: {
  draftId: string;
  initialStage: "titles" | "review";
}) {
  const flow = usePublishingFlow();
  const [stage, setStage] = usePublishingChoice(
    `publishingStage:${draftId}`,
    initialStage,
  );
  const [batchId, setBatchId] = usePublishingChoice(
    `publishingBatch:${draftId}`,
    "",
  );
  if (!flow)
    return initialStage === "titles" ? (
      <TitlesPage draftId={draftId} />
    ) : (
      <ReviewPage draftId={draftId} />
    );
  const revise = () => requestWorkspaceNavigation(() => setStage("titles"));
  return (
    <div className="publishing-page publishing-flow-step">
      <WorkflowCompleted
        id="publishing-input"
        summary="稿件与媒体已准备好，可继续配置本次投放"
      />
      {stage === "titles" && !batchId ? (
        <WorkflowSection id="publishing-titles" title="本次投放使用哪些标题？">
          <TitlesPage draftId={draftId} onSaved={() => setStage("review")} />
        </WorkflowSection>
      ) : (
        <WorkflowCompleted
          id="publishing-titles-saved"
          summary="发布标题已确认"
          onRevise={!batchId ? revise : undefined}
        />
      )}
      {batchId ? (
        <>
          <WorkflowCompleted
            id="publishing-submitted"
            summary="发布请求已受理，批次结果由发布服务持续更新"
          />
          <WorkflowSection id="publishing-result" title="查看本次发布结果">
            <PublicationDetailPage batchId={batchId} />
          </WorkflowSection>
        </>
      ) : stage === "review" ? (
        <WorkflowSection
          id="publishing-preflight"
          title="请核对稿件、媒体与费用，再确认发布"
        >
          <ReviewPage
            draftId={draftId}
            onRevise={revise}
            onSubmitted={(id) => {
              setBatchId(id);
              setStage("result");
            }}
          />
        </WorkflowSection>
      ) : null}
    </div>
  );
}

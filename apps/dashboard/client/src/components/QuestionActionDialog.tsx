import { Loader2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
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
import { trpc } from "@/lib/trpc";

type Props = {
  mode: "question" | "response_logic";
  questions: Array<{ id: string; question: string }>;
  selectedQuestionId?: string | null;
  fixedAction?: "modify" | "delete";
  triggerLabel?: string;
  disabled?: boolean;
  expectedResponseLogicRevision?: number;
  onSubmitted?: () => void | Promise<void>;
};

export default function QuestionActionDialog(props: Props) {
  if (props.disabled || !props.questions.length)
    return (
      <Button type="button" size="sm" variant="outline" disabled>
        <Wrench className="h-4 w-4" />
        {props.triggerLabel ||
          (props.mode === "response_logic" ? "重置应答逻辑" : "修改问题")}
      </Button>
    );
  return <ActiveQuestionActionDialog {...props} />;
}

/** Apply a change to the signed-in customer's own question with revision fences. */
function ActiveQuestionActionDialog({
  mode,
  questions,
  selectedQuestionId,
  fixedAction = "modify",
  triggerLabel,
  disabled,
  expectedResponseLogicRevision,
  onSubmitted,
}: Props) {
  const [open, setOpen] = useState(false);
  const [openedQuestion, setOpenedQuestion] = useState<{
    id: string;
    question: string;
  } | null>(null);
  const [proposedQuestion, setProposedQuestion] = useState("");
  const [expectedQuestionRevision, setExpectedQuestionRevision] = useState<
    number | null
  >(null);
  const [responseRevision, setResponseRevision] = useState<number | undefined>(
    undefined,
  );
  const intent = useRef<{ fingerprint: string; id: string } | null>(null);
  const submitting = useRef(false);
  const utils = trpc.useUtils();
  const portfolio = trpc.workspace.questionPortfolio.useQuery(undefined, {
    enabled: open,
    retry: false,
  });
  const apply = trpc.workspace.questionMaintenance.execute.useMutation();
  const selectedQuestion =
    questions.find((question) => question.id === selectedQuestionId) ||
    questions[0];
  const target = open ? openedQuestion : selectedQuestion;
  const current = portfolio.data?.questions.find(
    (question) => question.id === target?.id,
  );
  useEffect(() => {
    if (open && current && expectedQuestionRevision === null) {
      setExpectedQuestionRevision(current.revision);
      setProposedQuestion(current.question || target?.question || "");
    }
  }, [open, current, expectedQuestionRevision, target?.question]);
  const reset = mode === "response_logic";
  const action = reset ? "response_logic_reset" : fixedAction;
  const label = reset
    ? "重置应答逻辑"
    : fixedAction === "delete"
      ? "删除问题"
      : "修改问题";
  const submit = async () => {
    if (
      !target ||
      !current ||
      expectedQuestionRevision === null ||
      submitting.current
    )
      return;
    if (action === "modify" && !proposedQuestion.trim()) {
      toast.warning("请填写修改后的问题");
      return;
    }
    const fingerprint = JSON.stringify([
      target.id,
      expectedQuestionRevision,
      action,
      proposedQuestion.trim(),
      responseRevision,
    ]);
    if (intent.current?.fingerprint !== fingerprint)
      intent.current = { fingerprint, id: crypto.randomUUID() };
    submitting.current = true;
    try {
      const common = {
        clientRequestId: intent.current.id,
        questionId: target.id,
        expectedRevision: expectedQuestionRevision,
      };
      if (action === "modify")
        await apply.mutateAsync({
          ...common,
          action,
          proposedQuestion: proposedQuestion.trim(),
        });
      else if (action === "response_logic_reset") {
        if (responseRevision === undefined)
          throw new Error("应答逻辑版本已更新，请刷新后重试。");
        await apply.mutateAsync({
          ...common,
          action,
          expectedResponseLogicRevision: responseRevision,
        });
      } else await apply.mutateAsync({ ...common, action });
      await Promise.all([
        utils.workspace.questionPortfolio.invalidate(),
        utils.workspace.portal.invalidate(),
        utils.workspace.responseLogic.invalidate(),
      ]);
      await onSubmitted?.();
      setOpen(false);
      intent.current = null;
      toast.success(
        reset
          ? "应答逻辑已重置，可以重新开始"
          : fixedAction === "delete"
            ? "问题已删除"
            : "问题已修改",
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "操作失败，请重试");
    } finally {
      submitting.current = false;
    }
  };
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rl-page-header-action"
        disabled={disabled || !selectedQuestion}
        onClick={() => {
          setOpenedQuestion(selectedQuestion);
          setExpectedQuestionRevision(null);
          setResponseRevision(expectedResponseLogicRevision);
          setProposedQuestion(selectedQuestion?.question || "");
          setOpen(true);
        }}
      >
        <Wrench className="h-4 w-4" />
        {triggerLabel || label}
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!apply.isPending) setOpen(next);
        }}
      >
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{label}</DialogTitle>
            <DialogDescription>
              {reset
                ? "重置会清空当前问题的应答逻辑草稿、任务和确认内容，随后可重新开始。此操作无法撤销。"
                : action === "delete"
                  ? "删除后该问题将退出当前服务列表，历史监控结果仍会保留。"
                  : "保存后立即使用修改后的问题，历史监控结果仍绑定原问题版本。"}
            </DialogDescription>
          </DialogHeader>
          <p className="rounded-md border bg-muted/30 px-3 py-2 text-sm">
            {target?.question}
          </p>
          {action === "modify" && (
            <label className="grid gap-2 text-sm">
              修改后的问题
              <Textarea
                disabled={expectedQuestionRevision === null || apply.isPending}
                value={proposedQuestion}
                onChange={(event) => setProposedQuestion(event.target.value)}
                maxLength={2000}
                rows={4}
              />
            </label>
          )}
          {portfolio.error && (
            <p role="alert" className="text-sm text-destructive">
              {portfolio.error.message}
            </p>
          )}
          {!portfolio.isLoading && !portfolio.error && !current && (
            <p role="alert">该问题已更新或移除，请刷新页面。</p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              disabled={apply.isPending}
              onClick={() => setOpen(false)}
            >
              取消
            </Button>
            <Button
              variant={action === "modify" ? "default" : "destructive"}
              disabled={
                apply.isPending ||
                !current ||
                expectedQuestionRevision === null ||
                (reset && responseRevision === undefined)
              }
              onClick={() => void submit()}
            >
              {apply.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {apply.isPending
                ? "正在处理…"
                : action === "modify"
                  ? "保存修改"
                  : "确认" + label}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

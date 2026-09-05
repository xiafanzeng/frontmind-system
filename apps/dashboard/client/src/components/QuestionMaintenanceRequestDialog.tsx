import { Loader2, Send, Wrench } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
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

export type QuestionMaintenanceTarget = {
  id: string;
  question: string;
};

type QuestionMaintenanceRequestDialogProps = {
  mode: "question" | "response_logic";
  questions: QuestionMaintenanceTarget[];
  selectedQuestionId?: string | null;
  fixedAction?: "modify" | "delete";
  triggerLabel?: string;
  disabled?: boolean;
  onSubmitted?: () => void | Promise<void>;
};

function maintenanceTriggerLabel(mode: "question" | "response_logic") {
  return mode === "response_logic"
    ? "提交应答逻辑修改需求"
    : "提交问题修改需求";
}

function createMaintenanceRequestId() {
  if (
    typeof globalThis.crypto !== "undefined" &&
    typeof globalThis.crypto.randomUUID === "function"
  ) {
    return globalThis.crypto.randomUUID();
  }
  const values = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let index = 0; index < values.length; index += 1) {
      values[index] = Math.floor(Math.random() * 256);
    }
  }
  values[6] = (values[6] & 0x0f) | 0x40;
  values[8] = (values[8] & 0x3f) | 0x80;
  const hex = Array.from(values, (value) =>
    value.toString(16).padStart(2, "0"),
  );
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex
    .slice(6, 8)
    .join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

export default function QuestionMaintenanceRequestDialog(
  props: QuestionMaintenanceRequestDialogProps,
) {
  const triggerLabel =
    props.triggerLabel || maintenanceTriggerLabel(props.mode);
  if (props.disabled || props.questions.length === 0) {
    return (
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rl-page-header-action"
        disabled
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
        {triggerLabel}
      </Button>
    );
  }
  return <ActiveQuestionMaintenanceRequestDialog {...props} />;
}

function ActiveQuestionMaintenanceRequestDialog({
  mode,
  questions,
  selectedQuestionId,
  fixedAction,
  triggerLabel,
  disabled = false,
  onSubmitted,
}: QuestionMaintenanceRequestDialogProps) {
  const [open, setOpen] = useState(false);
  const [questionId, setQuestionId] = useState(selectedQuestionId || "");
  const [action, setAction] = useState<"modify" | "delete">("modify");
  const [proposedQuestion, setProposedQuestion] = useState("");
  const [reason, setReason] = useState("");
  const wasOpenRef = useRef(false);
  const submit = trpc.workspace.questionMaintenance.submit.useMutation();
  const fixedResponseLogicTarget = mode === "response_logic";
  const requestActionLabel = fixedResponseLogicTarget
    ? "应答逻辑修改"
    : action === "delete"
      ? "问题删除"
      : "问题修改";

  const selectedQuestion = useMemo(
    () => questions.find((question) => question.id === questionId) ?? null,
    [questionId, questions],
  );

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const nextQuestionId =
      selectedQuestionId &&
      questions.some((question) => question.id === selectedQuestionId)
        ? selectedQuestionId
        : questions[0]?.id || "";
    setQuestionId(nextQuestionId);
    setAction(fixedAction || "modify");
    setProposedQuestion("");
    setReason("");
  }, [fixedAction, open, questions, selectedQuestionId]);

  const handleSubmit = async () => {
    if (!selectedQuestion) {
      toast.warning("请选择需要处理的问题");
      return;
    }
    if (
      !fixedResponseLogicTarget &&
      action === "modify" &&
      !proposedQuestion.trim()
    ) {
      toast.warning("请填写修改后的问题");
      return;
    }
    try {
      const common = {
        clientRequestId: createMaintenanceRequestId(),
        questionId: selectedQuestion.id,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      };
      if (fixedResponseLogicTarget) {
        await submit.mutateAsync({
          ...common,
          action: "response_logic_reset",
        });
      } else if (action === "modify") {
        await submit.mutateAsync({
          ...common,
          action: "modify",
          proposedQuestion: proposedQuestion.trim(),
        });
      } else {
        await submit.mutateAsync({ ...common, action: "delete" });
      }
      await onSubmitted?.();
      setOpen(false);
      toast.success(`${requestActionLabel}需求已提交`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "需求提交失败");
    }
  };

  const noTarget = questions.length === 0;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="rl-page-header-action"
        disabled={disabled || noTarget}
        onClick={() => setOpen(true)}
      >
        <Wrench className="h-4 w-4" aria-hidden="true" />
        {triggerLabel || maintenanceTriggerLabel(mode)}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>提交{requestActionLabel}需求</DialogTitle>
            <DialogDescription>
              {fixedResponseLogicTarget
                ? "需求通过后，当前已确认的应答逻辑会被清空，您可以重新进入智能体确认。"
                : "AI 监控与优化工程师或系统管理员审核通过后，系统会修改或移除对应问题。历史监控记录仍会保留。"}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-4 py-2">
            <label className="grid gap-2 text-sm">
              <span className="font-medium">目标问题</span>
              {fixedResponseLogicTarget ? (
                <div className="rounded-md border bg-muted/30 px-3 py-2 leading-6">
                  {selectedQuestion?.question || "暂无可修改的应答逻辑"}
                </div>
              ) : (
                <select
                  className="h-10 rounded-md border bg-background px-3"
                  value={questionId}
                  onChange={(event) => setQuestionId(event.target.value)}
                >
                  {questions.map((question) => (
                    <option key={question.id} value={question.id}>
                      {question.question}
                    </option>
                  ))}
                </select>
              )}
            </label>

            {!fixedResponseLogicTarget && !fixedAction && (
              <div
                className="grid grid-cols-2 gap-2"
                role="group"
                aria-label="处理方式"
              >
                <Button
                  type="button"
                  variant={action === "modify" ? "default" : "outline"}
                  onClick={() => setAction("modify")}
                >
                  修改问题
                </Button>
                <Button
                  type="button"
                  variant={action === "delete" ? "destructive" : "outline"}
                  onClick={() => setAction("delete")}
                >
                  删除问题
                </Button>
              </div>
            )}

            {!fixedResponseLogicTarget && action === "modify" && (
              <label className="grid gap-2 text-sm">
                <span className="font-medium">修改后的问题</span>
                <Textarea
                  value={proposedQuestion}
                  onChange={(event) => setProposedQuestion(event.target.value)}
                  placeholder="请输入修改后的完整问题"
                  maxLength={2_000}
                  rows={4}
                />
              </label>
            )}

            <label className="grid gap-2 text-sm">
              <span className="font-medium">补充说明（选填）</span>
              <Textarea
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder={
                  fixedResponseLogicTarget
                    ? "请说明希望重新确认应答逻辑的原因"
                    : "可补充修改或删除原因，方便工程师审核"
                }
                maxLength={2_000}
                rows={3}
              />
            </label>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={submit.isPending}
            >
              取消
            </Button>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submit.isPending || !selectedQuestion}
            >
              {submit.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
              提交{requestActionLabel}需求
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

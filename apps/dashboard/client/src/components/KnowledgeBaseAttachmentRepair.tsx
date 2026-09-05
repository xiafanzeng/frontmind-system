import { useCallback, useRef, useState } from "react";
import { Loader2, Upload, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  assertChatAttachmentSizes,
  normalizedKnowledgeBaseUploadFilename,
  normalizedKnowledgeBaseUploadMimeType,
  sha256UploadFile,
} from "@/lib/attachment-files";
import { uploadFile } from "@/lib/frontmind-api";
import {
  replaceKnowledgeBaseTurnAttachments,
  type KnowledgeBaseAttachmentRepairManifestItem,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";

interface PreparedAttachmentRepair {
  files: File[];
  clientRequestId: string;
  attachmentManifest: KnowledgeBaseAttachmentRepairManifestItem[];
  attachments: Array<{ file_id: string; filename: string }>;
}

function attachmentRepairRequestId() {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `kb-attachment-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function KnowledgeBaseAttachmentRepair({
  conversationId,
  expectedGeneration,
  expectedRevision,
  expectedLeafId,
  onObservation,
}: {
  conversationId: string;
  expectedGeneration: number;
  expectedRevision: number;
  expectedLeafId: string | null;
  onObservation: (observation: KnowledgeBaseObservationDto) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const preparedRef = useRef<PreparedAttachmentRepair | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  const clear = useCallback(() => {
    preparedRef.current = null;
    setFiles([]);
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const select = useCallback((list: FileList | null) => {
    const next = Array.from(list || []);
    if (next.length === 0) return;
    try {
      assertChatAttachmentSizes(next);
    } catch (error) {
      toast.error("替换附件不符合大小限制", {
        description: error instanceof Error ? error.message : "请重新选择",
      });
      return;
    }
    preparedRef.current = null;
    setFiles(next);
  }, []);

  const submit = useCallback(async () => {
    if (files.length === 0 || submitting) return;
    setSubmitting(true);
    try {
      let prepared = preparedRef.current;
      if (
        !prepared ||
        prepared.files.length !== files.length ||
        prepared.files.some((file, index) => file !== files[index])
      ) {
        const attachmentManifest: KnowledgeBaseAttachmentRepairManifestItem[] =
          [];
        const attachments: Array<{ file_id: string; filename: string }> = [];
        for (let index = 0; index < files.length; index += 1) {
          const file = files[index]!;
          const filename = normalizedKnowledgeBaseUploadFilename(file.name);
          attachmentManifest.push({
            filename,
            sizeBytes: file.size,
            mimeType: normalizedKnowledgeBaseUploadMimeType(file),
            lastModified: Math.max(0, Number(file.lastModified || 0)),
            sha256: await sha256UploadFile(file),
          });
          const uploaded = await uploadFile(
            file,
            (percent) =>
              setUploadPercent(
                Math.round(((index + percent / 100) / files.length) * 100),
              ),
            undefined,
            { captureLocalCopy: true, captureFilename: filename },
          );
          attachments.push({ file_id: uploaded.fileId, filename });
        }
        prepared = {
          files,
          clientRequestId: attachmentRepairRequestId(),
          attachmentManifest,
          attachments,
        };
        preparedRef.current = prepared;
      }
      const observation = await replaceKnowledgeBaseTurnAttachments({
        conversationId,
        clientRequestId: prepared.clientRequestId,
        expectedGeneration,
        expectedRevision,
        expectedLeafId,
        attachmentManifest: prepared.attachmentManifest,
        attachments: prepared.attachments,
      });
      onObservation(observation);
      clear();
      toast.success("替换附件已提交，正在继续原轮次", {
        description:
          "系统沿用原业务节点和审计坐标，只发起一次修复后的创建尝试。",
      });
    } catch (error) {
      const status = Number((error as { status?: unknown })?.status || 0);
      if (!status || status === 408 || status === 429 || status >= 500) {
        toast.warning("附件替换结果正在核对", {
          description:
            "请保留当前选择并再次点击继续；系统会复用同一修复请求，不会重复创建任务。",
        });
      } else {
        toast.error("替换附件失败", {
          description:
            error instanceof Error ? error.message : "请重新选择后再试",
        });
      }
    } finally {
      setUploadPercent(null);
      setSubmitting(false);
    }
  }, [
    clear,
    conversationId,
    expectedGeneration,
    expectedLeafId,
    expectedRevision,
    files,
    onObservation,
    submitting,
  ]);

  return (
    <div
      className="mt-3 w-full rounded-lg border border-amber-300/80 bg-white/70 p-3 text-amber-950"
      data-testid="knowledge-base-attachment-repair"
    >
      <p className="text-xs leading-5">
        上一份附件在创建任务前被拒绝。请选择压缩、拆分或删减后的资料；系统会继续同一业务轮次，不会把它标记为“重新生成”。
      </p>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="选择替换后的知识库资料"
        disabled={submitting}
        onChange={(event) => {
          select(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {files.length > 0 && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-amber-100/70 px-2.5 py-2 text-xs">
          <span className="min-w-0 truncate">
            已选择 {files.length} 份资料
            {uploadPercent !== null ? ` · 上传 ${uploadPercent}%` : ""}
          </span>
          <button
            type="button"
            aria-label="清除替换附件"
            disabled={submitting}
            onClick={clear}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={submitting}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          选择替换资料
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={submitting || files.length === 0}
          onClick={() => void submit()}
        >
          {submitting && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          替换附件并继续本轮
        </Button>
      </div>
    </div>
  );
}

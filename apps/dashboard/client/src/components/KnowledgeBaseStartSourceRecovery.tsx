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
  recoverKnowledgeBaseStart,
  type KnowledgeBaseAttachmentRepairManifestItem,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";

function requestId() {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `kb-start-source-recovery-${Date.now()}`;
}

export default function KnowledgeBaseStartSourceRecovery({
  conversationId,
  expectedGeneration,
  expectedStateEpoch,
  onObservation,
}: {
  conversationId: string;
  expectedGeneration: number;
  expectedStateEpoch: number;
  onObservation: (observation: KnowledgeBaseObservationDto) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const identityRef = useRef(requestId());
  const [files, setFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);

  const select = useCallback((list: FileList | null) => {
    const next = Array.from(list || []);
    if (!next.length) return;
    try {
      assertChatAttachmentSizes(next);
      identityRef.current = requestId();
      setFiles(next);
    } catch (error) {
      toast.error("资料不符合上传限制", {
        description: error instanceof Error ? error.message : "请重新选择",
      });
    }
  }, []);

  const submit = useCallback(async () => {
    if (!files.length || submitting) return;
    setSubmitting(true);
    try {
      const attachmentManifest: KnowledgeBaseAttachmentRepairManifestItem[] =
        [];
      const attachments: Array<{ file_id: string; filename: string }> = [];
      for (const file of files) {
        const filename = normalizedKnowledgeBaseUploadFilename(file.name);
        attachmentManifest.push({
          filename,
          sizeBytes: file.size,
          mimeType: normalizedKnowledgeBaseUploadMimeType(file),
          lastModified: Math.max(0, Number(file.lastModified || 0)),
          sha256: await sha256UploadFile(file),
        });
        const uploaded = await uploadFile(file, undefined, undefined, {
          captureLocalCopy: true,
          captureFilename: filename,
        });
        attachments.push({ file_id: uploaded.fileId, filename });
      }
      const observation = await recoverKnowledgeBaseStart({
        conversationId,
        expectedGeneration,
        expectedStateEpoch,
        clientRequestId: identityRef.current,
        mode: "reselect_start_sources",
        attachmentManifest,
        attachments,
      });
      onObservation(observation);
      toast.success("新资料已绑定，正在重新开始", {
        description: "系统只会复用这一条恢复预约，不会重复计费。",
      });
    } catch (error) {
      toast.error("重新上传资料失败", {
        description: error instanceof Error ? error.message : "请稍后重试",
      });
    } finally {
      setSubmitting(false);
    }
  }, [
    conversationId,
    expectedGeneration,
    expectedStateEpoch,
    files,
    onObservation,
    submitting,
  ]);

  return (
    <div className="mt-3 w-full rounded-lg border border-amber-300/80 bg-white/70 p-3">
      <input
        ref={inputRef}
        type="file"
        multiple
        className="sr-only"
        aria-label="重新选择知识库资料"
        onChange={(event) => select(event.currentTarget.files)}
      />
      {files.length > 0 && (
        <div className="mb-2 flex items-center justify-between text-xs">
          <span>已选择 {files.length} 份资料</span>
          <button
            type="button"
            aria-label="清除新资料"
            onClick={() => setFiles([])}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          重新上传资料
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!files.length || submitting}
          onClick={() => void submit()}
        >
          {submitting && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          使用新资料重新开始
        </Button>
      </div>
    </div>
  );
}

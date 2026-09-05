import { useCallback, useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload, X } from "lucide-react";
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
  repairKnowledgeBaseLogoProvenance,
  retryKnowledgeBaseTurn,
  type KnowledgeBaseLogoProvenanceRepairError,
  type KnowledgeBaseLogoProvenanceRepairManifestItem,
  type KnowledgeBaseObservationDto,
} from "@/lib/knowledge-progress";

const SUPPORTED_LOGO_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SUPPORTED_LOGO_EXTENSION = /\.(?:avif|gif|jpe?g|png|webp)$/iu;

export function isSupportedKnowledgeBaseLogoRepairFile(file: File) {
  const mimeType = file.type.trim().toLowerCase();
  return (
    SUPPORTED_LOGO_MIME_TYPES.has(mimeType) ||
    (!mimeType && SUPPORTED_LOGO_EXTENSION.test(file.name))
  );
}

interface PreparedLogoRepairAttempt {
  file: File;
  clientRequestId: string;
  attachmentManifest: [KnowledgeBaseLogoProvenanceRepairManifestItem];
  attachment: { file_id: string; filename: string };
}

function logoRepairClientRequestId() {
  return typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `kb-logo-repair-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export default function KnowledgeBaseLogoProvenanceRepair({
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
  const preparedAttemptRef = useRef<PreparedLogoRepairAttempt | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isRepairing, setIsRepairing] = useState(false);
  const [uploadPercent, setUploadPercent] = useState<number | null>(null);

  const clearSelection = useCallback(() => {
    setSelectedFile(null);
    preparedAttemptRef.current = null;
    if (inputRef.current) inputRef.current.value = "";
  }, []);

  const selectFiles = useCallback((files: FileList | null) => {
    const selected = Array.from(files || []);
    if (selected.length !== 1) {
      toast.error("请只选择一张 Logo 原图");
      return;
    }
    const file = selected[0]!;
    try {
      assertChatAttachmentSizes([file]);
    } catch (error) {
      toast.error("Logo 文件过大", {
        description: error instanceof Error ? error.message : "请重新选择文件",
      });
      return;
    }
    if (!isSupportedKnowledgeBaseLogoRepairFile(file)) {
      toast.error("Logo 图片格式不支持", {
        description: "请上传 PNG、JPEG、WebP、AVIF 或 GIF 原图。",
      });
      return;
    }
    preparedAttemptRef.current = null;
    setSelectedFile(file);
  }, []);

  const repair = useCallback(async () => {
    if (!selectedFile || isRepairing) return;
    setIsRepairing(true);
    try {
      let prepared = preparedAttemptRef.current;
      if (!prepared || prepared.file !== selectedFile) {
        const filename = normalizedKnowledgeBaseUploadFilename(
          selectedFile.name,
        );
        const manifest: KnowledgeBaseLogoProvenanceRepairManifestItem = {
          filename,
          sizeBytes: selectedFile.size,
          mimeType: normalizedKnowledgeBaseUploadMimeType(selectedFile),
          lastModified: Math.max(0, Number(selectedFile.lastModified || 0)),
          sha256: await sha256UploadFile(selectedFile),
        };
        const uploaded = await uploadFile(
          selectedFile,
          (percent) => setUploadPercent(percent),
          undefined,
          {
            captureLocalCopy: true,
            captureFilename: filename,
          },
        );
        prepared = {
          file: selectedFile,
          clientRequestId: logoRepairClientRequestId(),
          attachmentManifest: [manifest],
          attachment: { file_id: uploaded.fileId, filename },
        };
        // A lost HTTP response must replay the exact request identity and the
        // same captured file instead of uploading another upstream record.
        preparedAttemptRef.current = prepared;
      }

      const observation = await repairKnowledgeBaseLogoProvenance({
        conversationId,
        clientRequestId: prepared.clientRequestId,
        expectedGeneration,
        expectedRevision,
        expectedLeafId,
        attachmentManifest: prepared.attachmentManifest,
        attachment: prepared.attachment,
      });
      // Provenance repair deliberately leaves the failed final turn in place:
      // that turn is the immutable authority from which a fresh retry is
      // reserved. Continue the user action here so a successful upload does
      // not merely redisplay the stale package error and wait for a second
      // click that users reasonably assume already happened.
      let retryObservation: KnowledgeBaseObservationDto;
      try {
        retryObservation = await retryKnowledgeBaseTurn({
          conversationId,
          clientRequestId: logoRepairClientRequestId(),
          expectedGeneration,
          expectedRevision,
          expectedLeafId,
        });
      } catch (error) {
        // The source ledger is already durable. Project it before surfacing a
        // retry transport/conflict error so the UI never asks for the same
        // Logo again and its normal retry recovery can take over.
        onObservation(observation);
        clearSelection();
        const status = Number(
          (error as { status?: unknown } | undefined)?.status || 0,
        );
        if (!status || status === 408 || status === 429 || status >= 500) {
          toast.warning("Logo 来源已修复，正在恢复最终交付", {
            description:
              "重试请求结果暂时未知，系统会核对同一操作，不会要求再次上传 Logo。",
          });
        } else {
          toast.error("Logo 来源已修复，但最终交付重试失败", {
            description:
              error instanceof Error
                ? error.message
                : "请刷新权威状态后点击“重试本轮”。",
          });
        }
        return;
      }
      onObservation(retryObservation);
      clearSelection();
      toast.success("Logo 来源已校验，最终交付已重新发起", {
        description:
          "系统已使用新的幂等操作重新生成并校验最终知识库，无需再次点击重试。",
      });
    } catch (error) {
      const repairError = error as KnowledgeBaseLogoProvenanceRepairError;
      if (repairError.knowledgeObservation) {
        onObservation(repairError.knowledgeObservation);
      }
      if (repairError.code === "KNOWLEDGE_BASE_LOGO_REPAIR_UPLOAD_INVALID") {
        clearSelection();
        toast.error("Logo 原图不一致", {
          description:
            "所选图片与当前知识库已绑定的 Logo 不是同一份原始字节。请上传当时使用的同一文件，不要截图、压缩或重新导出。",
        });
      } else if (
        repairError.code === "KNOWLEDGE_BASE_LOGO_PROVENANCE_CONFLICT"
      ) {
        toast.error("Logo 来源账本冲突", {
          description:
            repairError.message || "请联系管理员核验当前知识库的 Logo 来源。",
        });
      } else if (
        repairError.code === "KNOWLEDGE_BASE_LOGO_PROVENANCE_NOT_REQUIRED"
      ) {
        toast.info("Logo 来源已经修复", {
          description: "请刷新权威状态后点击“重试本轮”。",
        });
      } else {
        toast.error("Logo 来源修复失败", {
          description:
            repairError instanceof Error
              ? repairError.message
              : "请保留当前原图并稍后重试。",
        });
      }
    } finally {
      setUploadPercent(null);
      setIsRepairing(false);
    }
  }, [
    clearSelection,
    conversationId,
    expectedGeneration,
    expectedLeafId,
    expectedRevision,
    isRepairing,
    onObservation,
    selectedFile,
  ]);

  return (
    <div
      className="mt-3 w-full rounded-lg border border-amber-300/80 bg-white/70 p-3 text-amber-950"
      data-testid="knowledge-base-logo-provenance-repair"
    >
      <p className="text-xs leading-5">
        请重新上传当前知识库已经使用的同一张官方主 Logo
        原图。系统只补全来源凭证，不会推进节点，也不会把它作为普通修订附件发送给模型。
      </p>
      <input
        ref={inputRef}
        type="file"
        className="sr-only"
        aria-label="选择同一张官方主 Logo 原图"
        accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
        disabled={isRepairing}
        onChange={(event) => {
          selectFiles(event.currentTarget.files);
          event.currentTarget.value = "";
        }}
      />
      {selectedFile && (
        <div className="mt-2 flex items-center gap-2 rounded-md bg-amber-100/70 px-2.5 py-2 text-xs">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{selectedFile.name}</span>
          <button
            type="button"
            className="rounded p-0.5 hover:bg-amber-200"
            aria-label="移除已选择的 Logo"
            disabled={isRepairing}
            onClick={clearSelection}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={isRepairing}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="mr-1.5 h-3.5 w-3.5" />
          {selectedFile ? "更换 Logo 原图" : "选择 Logo 原图"}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={!selectedFile || isRepairing}
          onClick={() => void repair()}
        >
          {isRepairing && (
            <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
          )}
          {isRepairing
            ? uploadPercent === null
              ? "正在校验来源"
              : `正在上传 ${Math.round(uploadPercent)}%`
            : "校验并绑定"}
        </Button>
      </div>
    </div>
  );
}

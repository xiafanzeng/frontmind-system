import {
  CheckCircle2,
  FileArchive,
  LoaderCircle,
  ShieldCheck,
  UploadCloud,
} from "lucide-react";
import { useRef, useState, type DragEvent } from "react";
import { useLocation } from "wouter";
import {
  usePublishingFlow,
  usePublishingSummary,
  usePublishingOperationScope,
  publishingTaskUrl,
} from "../PublishingFlowContext";
import {
  performApprovedWorkspaceNavigation,
  useWorkspaceDraftGuard,
} from "@/lib/workspace-navigation-guard";

import { usePublisherGateway } from "../PublishingContext";
import {
  PublishingBreadcrumbs,
  PublishingPage,
  PublishingSteps,
} from "../components/PublishingUi";

export default function PublishingImportPage({
  onImported,
}: { onImported?: (articleId: string) => void } = {}) {
  const gateway = usePublisherGateway();
  const flow = usePublishingFlow();
  const operationScope = usePublishingOperationScope("import");
  const [, navigate] = useLocation();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploadLock = useRef(false);
  useWorkspaceDraftGuard({ dirty: Boolean(file), label: "待导入稿件" });
  usePublishingSummary({
    title: "稿件导入",
    items: [
      { label: "文件", value: file?.name ?? "待选择 DOCX" },
      { label: "状态", value: busy ? "正在检查并导入" : error || "等待上传" },
    ],
  });

  const choose = (next?: File) => {
    setError("");
    if (!next) return;
    if (!next.name.toLowerCase().endsWith(".docx")) {
      setError("请选择 .docx 文件");
      return;
    }
    if (next.size > 20 * 1024 * 1024) {
      setError("文件不能超过 20 MiB");
      return;
    }
    setFile(next);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    choose(event.dataTransfer.files[0]);
  };

  const submit = async () => {
    if (!file || busy || uploadLock.current) return;
    const isCurrent = operationScope();
    uploadLock.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await gateway.importDocx(file);
      if (!isCurrent()) return;
      await flow
        ?.record({
          id: `import:${result.articleId}`,
          label: "稿件已导入并完成检查",
          detail: file.name,
          resources: [{ kind: "article", id: result.articleId }],
          outputRefs: [
            {
              resource: {
                kind: "article",
                id: result.articleId,
                label: file.name,
              },
              sourceStepId: `import:${result.articleId}`,
            },
          ],
        })
        .catch(() => undefined);
      if (isCurrent())
        performApprovedWorkspaceNavigation(() =>
          onImported
            ? onImported(result.articleId)
            : navigate(
                publishingTaskUrl(
                  `/publishing/articles/${result.articleId}/edit`,
                  flow?.taskId,
                ),
              ),
        );
    } catch (reason) {
      if (!isCurrent()) return;
      setError(reason instanceof Error ? reason.message : "导入失败，请重试");
      setBusy(false);
    } finally {
      uploadLock.current = false;
    }
  };

  return (
    <PublishingPage
      title="导入稿件"
      description="上传 DOCX 后先进行文件安全与正文结构检查。"
      busy={busy}
    >
      <PublishingBreadcrumbs
        items={[
          { label: "稿件", href: "/publishing/articles" },
          { label: "导入 DOCX" },
        ]}
      />
      <PublishingSteps current={1} />
      <div className="publishing-import-layout">
        <section className="publishing-panel publishing-import-panel">
          <div
            className={`publishing-dropzone ${dragging ? "is-dragging" : ""}`}
            onDragEnter={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragOver={(event) => event.preventDefault()}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
          >
            <span className="publishing-drop-icon">
              {file ? <FileArchive size={30} /> : <UploadCloud size={30} />}
            </span>
            {file ? (
              <>
                <strong>{file.name}</strong>
                <p>{(file.size / 1024 / 1024).toFixed(2)} MiB · 等待安全检查</p>
              </>
            ) : (
              <>
                <strong>拖入 DOCX，或从电脑选择</strong>
                <p>单个文件不超过 20 MiB；最多解析 50 张正文图片。</p>
              </>
            )}
            <input
              ref={inputRef}
              type="file"
              accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
              onChange={(event) => choose(event.target.files?.[0])}
              className="publishing-visually-hidden"
              aria-label="选择 DOCX 文件"
            />
            <button
              className="publishing-button publishing-button-secondary"
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={busy}
            >
              {file ? "更换文件" : "选择文件"}
            </button>
          </div>
          {error ? (
            <p className="publishing-form-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer className="publishing-form-footer">
            <span>
              {file ? (
                <>
                  <CheckCircle2 size={16} /> 文件格式已确认
                </>
              ) : (
                "选择文件后即可开始导入"
              )}
            </span>
            <button
              className="publishing-button publishing-button-primary"
              type="button"
              onClick={submit}
              disabled={!file || busy}
            >
              {busy ? (
                <LoaderCircle className="publishing-spin" size={17} />
              ) : (
                <UploadCloud size={17} />
              )}
              {busy ? "正在导入…" : "安全导入并编辑"}
            </button>
          </footer>
        </section>
        <aside className="publishing-panel publishing-import-rules">
          <span className="publishing-aside-icon">
            <ShieldCheck size={23} />
          </span>
          <h2>导入检查</h2>
          <ul>
            <li>
              <CheckCircle2 size={16} />
              拒绝宏、ActiveX 与加密文档
            </li>
            <li>
              <CheckCircle2 size={16} />
              阻断路径穿越和外链图片
            </li>
            <li>
              <CheckCircle2 size={16} />
              清理危险 XML 与 HTML
            </li>
            <li>
              <CheckCircle2 size={16} />
              正文图片统一格式与方向
            </li>
          </ul>
          <p>检查在服务端异步完成。文件不会直接发送给媒体供应商。</p>
        </aside>
      </div>
    </PublishingPage>
  );
}

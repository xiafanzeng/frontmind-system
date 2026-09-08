import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  Pencil,
  Search,
} from "lucide-react";
import type {
  KnowledgeBaseLeafStatus,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";
import type {
  KnowledgeNodeDetailsDto,
  KnowledgeNodeSaveInput,
  KnowledgeNodeSaveResult,
} from "@shared/knowledge-node-workspace";
import { useConversation } from "@/contexts/ConversationContext";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import { useWorkspaceDraftGuard } from "@/lib/workspace-navigation-guard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import MarkdownRenderer from "./MarkdownRenderer";
import KnowledgeNodeLocalActions from "./KnowledgeNodeLocalActions";
import "./knowledge-node-workspace.css";

export type KnowledgeNodeEditTarget = {
  leafId: string;
  title: string;
  mode: "direct" | "ai";
};

export interface KnowledgeNodeWorkspaceProps {
  progress?: KnowledgeBaseProgressDto | null;
  conversationId: string;
  generation?: number;
  resetRevision?: number;
  disabled?: boolean;
  loading?: boolean;
  className?: string;
  onEditTargetChange?: (target: KnowledgeNodeEditTarget | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onMutationPendingChange?: (pending: boolean) => void;
  /** Local design fixtures are read-only and are ignored in production builds. */
  previewDetails?: KnowledgeNodeDetailsDto[];
}

const statusLabels: Record<KnowledgeBaseLeafStatus, string> = {
  confirmed: "已确认",
  direct_prefilled: "已预填",
  current: "当前节点",
  needs_verification: "需再核实",
  pending: "待处理",
};

class NodeRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function editableBody(content: string, title: string) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== `# ${title}`) return content;
  lines.shift();
  if (lines[0]?.trim() === "") lines.shift();
  return lines.join("\n");
}

/** Keep node drafts and request lifetimes inside the existing project scope. */
export default function KnowledgeNodeWorkspace(
  props: KnowledgeNodeWorkspaceProps,
) {
  const { state } = useConversation();
  const generation =
    props.generation ??
    state.conversations.find(
      (conversation) => conversation.id === props.conversationId,
    )?.knowledgeBase?.generation;
  const previewDetails = import.meta.env.DEV ? props.previewDetails : undefined;
  const effectiveGeneration =
    generation ?? previewDetails?.[0]?.coordinates.generation;
  const sessionKey = `${props.conversationId}:${props.progress?.build.id ?? "empty"}:${effectiveGeneration ?? "unknown"}:${props.resetRevision ?? "unknown"}`;
  return (
    <KnowledgeNodeWorkspaceSession
      key={sessionKey}
      {...props}
      generation={effectiveGeneration}
      previewDetails={previewDetails}
    />
  );
}

function KnowledgeNodeWorkspaceSession({
  progress,
  conversationId,
  generation,
  resetRevision,
  disabled = false,
  loading = false,
  className = "",
  onEditTargetChange,
  onDirtyChange,
  onMutationPendingChange,
  previewDetails,
}: KnowledgeNodeWorkspaceProps) {
  const { commitKnowledgeBaseObservation } = useConversation();
  const branches = progress?.branches ?? [];
  const leaves = useMemo(
    () => branches.flatMap((branch) => branch.leaves),
    [branches],
  );
  const [selectedLeafId, setSelectedLeafId] = useState<string | null>(
    () =>
      leaves.find((leaf) => leaf.id === progress?.build.currentLeafId)?.id ??
      leaves[0]?.id ??
      null,
  );
  const [search, setSearch] = useState("");
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(
    () => new Set(),
  );
  const [directoryOpen, setDirectoryOpen] = useState(true);
  const [details, setDetails] = useState<KnowledgeNodeDetailsDto | null>(null);
  const [readPending, setReadPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [observedContentVersion, setObservedContentVersion] = useState(0);
  const [editBase, setEditBase] = useState<KnowledgeNodeDetailsDto | null>(
    null,
  );
  const [draft, setDraft] = useState("");
  const [editorPreview, setEditorPreview] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [localActionPending, setLocalActionPending] = useState(false);
  const [imageDirty, setImageDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [manualEditedLeafIds, setManualEditedLeafIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingDestination, setPendingDestination] = useState<{
    leafId: string | null;
  } | null>(null);
  const lifetime = useRef(new AbortController());
  const saveLock = useRef(false);
  const saveAttempt = useRef<{ signature: string; requestId: string } | null>(
    null,
  );
  const nodeElements = useRef(new Map<string, HTMLButtonElement>());
  const directoryScrollTop = useRef(0);
  const initiallyLocated = useRef(false);
  const editorElement = useRef<HTMLTextAreaElement>(null);
  const composingEditor = useRef(false);
  const callbacks = useRef({
    onEditTargetChange,
    onDirtyChange,
    onMutationPendingChange,
  });
  callbacks.current = {
    onEditTargetChange,
    onDirtyChange,
    onMutationPendingChange,
  };
  const dirty = Boolean(
    editBase &&
      draft !==
        editableBody(editBase.node.contentMarkdown, editBase.node.title),
  );
  const editing = Boolean(editBase);
  const mutationPending = savePending || localActionPending;
  const readonlyPreview = previewDetails !== undefined;
  const expectedContentVersion = Math.max(
    progress?.build.contentVersion ?? 0,
    observedContentVersion,
  );
  const selectedLeaf = leaves.find((leaf) => leaf.id === selectedLeafId);
  const selectedBranch = branches.find((branch) =>
    branch.leaves.some((leaf) => leaf.id === selectedLeafId),
  );
  const currentDetails =
    details?.node.leafId === selectedLeafId ? details : null;

  useEffect(() => {
    if (lifetime.current.signal.aborted)
      lifetime.current = new AbortController();
    const controller = lifetime.current;
    return () => {
      controller.abort();
      callbacks.current.onDirtyChange?.(false);
      callbacks.current.onMutationPendingChange?.(false);
      callbacks.current.onEditTargetChange?.(null);
    };
  }, []);
  useEffect(() => {
    callbacks.current.onDirtyChange?.(dirty || imageDirty);
  }, [dirty, imageDirty]);
  useEffect(() => {
    callbacks.current.onMutationPendingChange?.(mutationPending);
  }, [mutationPending]);
  useEffect(() => {
    if (selectedLeafId && leaves.some((leaf) => leaf.id === selectedLeafId))
      return;
    if (editBase) return; // A disappearing node must not silently retarget its draft.
    setSelectedLeafId(
      leaves.find((leaf) => leaf.id === progress?.build.currentLeafId)?.id ??
        leaves[0]?.id ??
        null,
    );
    setDetails(null);
  }, [leaves, selectedLeafId, progress?.build.currentLeafId, editBase]);
  useEffect(() => {
    if (initiallyLocated.current || !directoryOpen || !selectedLeafId) return;
    const frame = window.requestAnimationFrame(() => {
      const node = nodeElements.current.get(selectedLeafId);
      if (lifetime.current.signal.aborted || !node?.isConnected) return;
      node.scrollIntoView?.({ block: "nearest", behavior: "auto" });
      initiallyLocated.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [directoryOpen, selectedLeafId, leaves]);

  const acceptErrorObservation = (result: Record<string, unknown>) => {
    const observation = result.observation as
      | KnowledgeNodeSaveResult["observation"]
      | undefined;
    if (
      !observation ||
      generation === undefined ||
      observation.generation < generation ||
      observation.interaction?.progress?.build.conversationId !== conversationId
    )
      return;
    commitKnowledgeBaseObservation(conversationId, observation);
    // A reset creates a new session in the parent; never carry its content
    // version into this old session's pending reads or edit coordinates.
    if (observation.generation !== generation) return;
    setObservedContentVersion((current) =>
      Math.max(
        current,
        observation.interaction.progress?.build.contentVersion ?? 0,
      ),
    );
  };

  useEffect(() => {
    if (!selectedLeafId) return;
    if (readonlyPreview) {
      setDetails(
        previewDetails?.find((item) => item.node.leafId === selectedLeafId) ??
          null,
      );
      setReadError(null);
      return;
    }
    if (generation === undefined || !conversationId) return;
    const controller = new AbortController();
    const rest = captureWorkspaceRestOperation(
      AbortSignal.any([lifetime.current.signal, controller.signal]),
    );
    setReadPending(true);
    setReadError(null);
    void (async () => {
      try {
        const query = new URLSearchParams({
          conversationId,
          leafId: selectedLeafId,
          expectedGeneration: String(generation),
          expectedContentVersion: String(expectedContentVersion),
        });
        const response = await rest.fetch(
          `/api/knowledge-base/node/content?${query}`,
          { credentials: "include" },
        );
        const result = await response.json();
        rest.assertActive();
        if (!response.ok) {
          acceptErrorObservation(result);
          throw new NodeRequestError(
            result.error?.message ?? "节点正文暂时无法读取，请重试。",
            response.status,
          );
        }
        const next = result as KnowledgeNodeDetailsDto;
        if (
          next.coordinates.conversationId !== conversationId ||
          next.coordinates.generation !== generation ||
          next.coordinates.buildId !== progress?.build.id ||
          next.coordinates.contentVersion !== expectedContentVersion ||
          (resetRevision !== undefined &&
            next.coordinates.resetRevision !== resetRevision) ||
          next.node.leafId !== selectedLeafId ||
          next.coordinates.leafId !== selectedLeafId
        ) {
          throw new NodeRequestError("节点归属已变化，请重新读取。", 409);
        }
        setDetails(next);
      } catch (error) {
        if (rest.signal.aborted) return;
        if (
          error instanceof NodeRequestError &&
          [401, 403, 404].includes(error.status)
        )
          setDetails(null);
        setReadError(
          error instanceof Error ? error.message : "节点正文读取失败。",
        );
      } finally {
        if (!rest.signal.aborted) setReadPending(false);
      }
    })();
    return () => controller.abort();
    // The request owns frozen coordinates; draft/editBase are deliberately not replaced by new reads.
  }, [
    conversationId,
    generation,
    resetRevision,
    selectedLeafId,
    expectedContentVersion,
    progress?.build.id,
    progress?.build.revision,
    reload,
    readonlyPreview,
    previewDetails,
  ]);

  const finishEditing = () => {
    setEditBase(null);
    setDraft("");
    setEditorPreview(false);
    setSaveError(null);
    setConflicted(false);
    setShowLatest(false);
    setDirectoryOpen(true);
    saveAttempt.current = null;
    callbacks.current.onEditTargetChange?.(null);
  };

  const saveDraft = async (): Promise<boolean> => {
    if (
      !editBase ||
      readonlyPreview ||
      disabled ||
      saveLock.current ||
      localActionPending ||
      conflicted
    )
      return false;
    if (
      draft === editableBody(editBase.node.contentMarkdown, editBase.node.title)
    ) {
      finishEditing();
      return true;
    }
    if (!draft.trim() || !editBase.capabilities.directEdit.allowed)
      return false;
    const rest = captureWorkspaceRestOperation(lifetime.current.signal);
    const { coordinates } = editBase;
    const body: KnowledgeNodeSaveInput = {
      conversationId: coordinates.conversationId,
      leafId: coordinates.leafId,
      expectedGeneration: coordinates.generation,
      expectedRevision: coordinates.revision,
      expectedStateEpoch: coordinates.stateEpoch,
      expectedContentVersion: coordinates.contentVersion,
      expectedResetRevision: coordinates.resetRevision,
      contentMarkdown: `# ${editBase.node.title}\n\n${draft}`,
      clientRequestId: "",
    };
    const signature = JSON.stringify(body);
    if (saveAttempt.current?.signature !== signature)
      saveAttempt.current = { signature, requestId: crypto.randomUUID() };
    body.clientRequestId = saveAttempt.current.requestId;
    saveLock.current = true;
    setSavePending(true);
    setSaveError(null);
    try {
      const response = await rest.fetch("/api/knowledge-base/node/save", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json();
      rest.assertActive();
      if (!response.ok) {
        acceptErrorObservation(result);
        if (response.status === 409) {
          setConflicted(true);
          setShowLatest(true);
        }
        throw new NodeRequestError(
          result.error?.message ?? "保存失败，修改仍保留在编辑器中。",
          response.status,
        );
      }
      const saved = result as KnowledgeNodeSaveResult;
      if (
        saved.accepted !== true ||
        saved.observation?.generation !== generation ||
        saved.observation.interaction?.progress?.build.conversationId !==
          conversationId
      )
        throw new Error(
          "未收到有效保存结果，请重新读取状态；编辑内容仍已保留。",
        );
      commitKnowledgeBaseObservation(conversationId, saved.observation);
      const nextVersion =
        saved.observation.interaction.progress?.build.contentVersion ??
        coordinates.contentVersion;
      setObservedContentVersion((current) => Math.max(current, nextVersion));
      // A replayed acceptance can carry observation coordinates newer than
      // this submitted body. Only the content GET may pair current bytes with
      // those coordinates, including any server normalization or later edits.
      setDetails(null);
      setReadPending(true);
      setSavedMessage(
        saved.unchanged ? "内容没有变化。" : "修改已保存，请确认后更新知识库。",
      );
      const savedLeaf = saved.observation.interaction.progress?.branches
        .flatMap((branch) => branch.leaves)
        .find((leaf) => leaf.id === coordinates.leafId);
      if (!saved.unchanged && savedLeaf?.status === "needs_verification") {
        setManualEditedLeafIds((current) =>
          new Set(current).add(coordinates.leafId),
        );
        setSavedMessage(
          "修改已保存，请确认后更新知识库。请在任务协作中确认本节点。",
        );
      }
      finishEditing();
      setReload((value) => value + 1);
      return true;
    } catch (error) {
      if (!rest.signal.aborted)
        setSaveError(
          error instanceof Error
            ? error.message
            : "保存失败，修改仍保留在编辑器中。",
        );
      return false;
    } finally {
      if (!rest.signal.aborted) {
        saveLock.current = false;
        setSavePending(false);
      }
    }
  };

  useWorkspaceDraftGuard({
    dirty: dirty && !readonlyPreview,
    label: `知识节点：${editBase?.node.title ?? selectedLeaf?.title ?? "正文"}`,
    save: saveDraft,
  });

  const selectLeaf = (leafId: string) => {
    if (mutationPending || leafId === selectedLeafId) return;
    if (dirty) {
      setPendingDestination({ leafId });
      return;
    }
    if (editing) finishEditing();
    setSelectedLeafId(leafId);
    setDetails(null);
    setSavedMessage(null);
  };
  const leaveEditor = () => {
    if (mutationPending) return;
    if (dirty) setPendingDestination({ leafId: null });
    else finishEditing();
  };
  const completeDestination = () => {
    const destination = pendingDestination;
    finishEditing();
    if (destination?.leafId) {
      setSelectedLeafId(destination.leafId);
      setDetails(null);
    }
    setPendingDestination(null);
  };
  const beginDirectEdit = () => {
    if (
      !currentDetails?.capabilities.directEdit.allowed ||
      readonlyPreview ||
      disabled ||
      readPending ||
      readError ||
      mutationPending
    )
      return;
    setEditBase(currentDetails);
    setDraft(
      editableBody(
        currentDetails.node.contentMarkdown,
        currentDetails.node.title,
      ),
    );
    setDirectoryOpen(false);
    setSavedMessage(null);
    setSaveError(null);
    callbacks.current.onEditTargetChange?.({
      leafId: currentDetails.node.leafId,
      title: currentDetails.node.title,
      mode: "direct",
    });
  };
  const locateCurrent = () => {
    const currentId = progress?.build.currentLeafId;
    if (!currentId || mutationPending) return;
    setSearch("");
    setDirectoryOpen(true);
    const branch = branches.find((item) =>
      item.leaves.some((leaf) => leaf.id === currentId),
    );
    if (branch)
      setCollapsedBranches((old) => {
        const next = new Set(old);
        next.delete(branch.id);
        return next;
      });
    selectLeaf(currentId);
    requestAnimationFrame(() => {
      if (!lifetime.current.signal.aborted)
        nodeElements.current
          .get(currentId)
          ?.scrollIntoView?.({ block: "nearest", behavior: "auto" });
    });
  };
  const insertMarkdown = (kind: "heading" | "bold" | "list" | "link") => {
    const editor = editorElement.current;
    if (
      !editor ||
      !editBase ||
      disabled ||
      savePending ||
      editorPreview ||
      composingEditor.current
    )
      return;
    let start = editor.selectionStart;
    let end = editor.selectionEnd;
    const selected = draft.slice(start, end);
    let replacement: string;
    let selectionStart: number;
    let selectionEnd: number;
    if (kind === "heading" || kind === "list") {
      start = start === 0 ? 0 : draft.lastIndexOf("\n", start - 1) + 1;
      const lineEnd = draft.indexOf("\n", Math.max(start, end - 1));
      end = lineEnd === -1 ? draft.length : lineEnd;
      const marker = kind === "heading" ? "## " : "- ";
      replacement = (
        draft.slice(start, end) || (kind === "heading" ? "小标题" : "列表项")
      )
        .split("\n")
        .map(
          (line) =>
            marker +
            line.replace(kind === "heading" ? /^#{1,6}\s+/ : /^[-*+]\s+/, ""),
        )
        .join("\n");
      selectionStart = start + marker.length;
      selectionEnd = start + replacement.length;
    } else if (kind === "bold") {
      replacement = `**${selected || "加粗文字"}**`;
      selectionStart = start + 2;
      selectionEnd = start + replacement.length - 2;
    } else {
      replacement = `[${selected || "链接文字"}](https://)`;
      selectionStart = start + replacement.length - 9;
      selectionEnd = start + replacement.length - 1;
    }
    const next = draft.slice(0, start) + replacement + draft.slice(end);
    if (next.length + editBase.node.title.length + 4 > 300000) {
      setSaveError("正文已达到长度限制，请先缩短内容。");
      return;
    }
    setDraft(next);
    window.requestAnimationFrame(() => {
      if (lifetime.current.signal.aborted || !editorElement.current) return;
      editorElement.current.focus();
      editorElement.current.setSelectionRange(selectionStart, selectionEnd);
    });
  };
  const searchTerm = search.trim().toLocaleLowerCase();
  const visibleBranches = branches
    .map((branch) => ({
      ...branch,
      leaves: branch.leaves.filter(
        (leaf) =>
          !searchTerm || leaf.title.toLocaleLowerCase().includes(searchTerm),
      ),
    }))
    .filter((branch) => branch.leaves.length > 0);
  const actionsDisabled =
    disabled ||
    readonlyPreview ||
    editing ||
    readPending ||
    Boolean(readError) ||
    mutationPending;
  const latestDiffers = Boolean(
    editBase &&
      currentDetails &&
      (editBase.coordinates.contentVersion !==
        currentDetails.coordinates.contentVersion ||
        editBase.coordinates.revision !== currentDetails.coordinates.revision),
  );
  const leafStatusLabel = (leaf: {
    id: string;
    status: KnowledgeBaseLeafStatus;
  }) =>
    leaf.status === "needs_verification" && manualEditedLeafIds.has(leaf.id)
      ? "需确认修改"
      : statusLabels[leaf.status];

  return (
    <section
      className={`knowledge-node-workspace ${editing ? "is-editing" : ""} ${className}`}
      aria-label="知识节点工作区"
    >
      <header className="knowledge-node-workspace__header">
        <div>
          <h2>知识结构</h2>
          <p>{loading ? "正在同步知识结构…" : `${leaves.length} 个节点`}</p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={locateCurrent}
          disabled={!progress?.build.currentLeafId || mutationPending}
        >
          <Crosshair aria-hidden="true" />
          定位当前节点
        </Button>
      </header>
      {readonlyPreview && (
        <p className="knowledge-node-workspace__notice">
          设计预览：示例内容仅用于检查布局，保存与 AI 操作不可用。
        </p>
      )}
      {leaves.length === 0 ? (
        <div className="knowledge-node-workspace__empty">
          <h3>知识结构将在这里呈现</h3>
          <p>
            {loading
              ? "正在读取当前项目的节点。"
              : "完成资料分析后，可逐个查看和修改知识节点。"}
          </p>
        </div>
      ) : (
        <>
          {editing && (
            <button
              type="button"
              className="knowledge-node-workspace__directory-toggle"
              onClick={() => setDirectoryOpen((open) => !open)}
              aria-expanded={directoryOpen}
            >
              {directoryOpen ? (
                <ChevronDown aria-hidden="true" />
              ) : (
                <ChevronRight aria-hidden="true" />
              )}
              {directoryOpen ? "收起目录" : "打开目录"}
              <span>
                {selectedBranch?.title} /{" "}
                {selectedLeaf?.title ?? editBase?.node.title}
              </span>
            </button>
          )}
          {directoryOpen && (
            <div className="knowledge-node-workspace__directory">
              <div className="knowledge-node-workspace__search">
                <Search aria-hidden="true" />
                <Input
                  aria-label="搜索节点标题"
                  placeholder="搜索节点标题"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
              </div>
              <nav
                aria-label="知识节点目录"
                className="knowledge-node-workspace__tree"
                ref={(node) => {
                  if (node) node.scrollTop = directoryScrollTop.current;
                }}
                onScroll={(event) => {
                  directoryScrollTop.current = event.currentTarget.scrollTop;
                }}
              >
                {visibleBranches.length === 0 ? (
                  <p className="knowledge-node-workspace__notice">
                    没有匹配的知识节点。
                  </p>
                ) : (
                  <ul>
                    {visibleBranches.map((branch) => {
                      const expanded =
                        Boolean(searchTerm) ||
                        !collapsedBranches.has(branch.id);
                      return (
                        <li key={branch.id}>
                          <button
                            type="button"
                            className="knowledge-node-workspace__branch"
                            aria-expanded={expanded}
                            onClick={() =>
                              setCollapsedBranches((old) => {
                                const next = new Set(old);
                                next.has(branch.id)
                                  ? next.delete(branch.id)
                                  : next.add(branch.id);
                                return next;
                              })
                            }
                          >
                            {expanded ? (
                              <ChevronDown aria-hidden="true" />
                            ) : (
                              <ChevronRight aria-hidden="true" />
                            )}
                            {branch.title}
                          </button>
                          {expanded && (
                            <ul>
                              {branch.leaves.map((leaf) => (
                                <li key={leaf.id}>
                                  <button
                                    type="button"
                                    ref={(node) => {
                                      if (node)
                                        nodeElements.current.set(leaf.id, node);
                                      else nodeElements.current.delete(leaf.id);
                                    }}
                                    className="knowledge-node-workspace__leaf"
                                    aria-label={`${leaf.title} ${leafStatusLabel(leaf)}`}
                                    aria-current={
                                      leaf.id === selectedLeafId
                                        ? "true"
                                        : undefined
                                    }
                                    onClick={() => selectLeaf(leaf.id)}
                                    disabled={mutationPending}
                                  >
                                    <span>{leaf.title}</span>
                                    <span
                                      className={`knowledge-node-workspace__status is-${leaf.status}`}
                                    >
                                      {leafStatusLabel(leaf)}
                                    </span>
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </nav>
            </div>
          )}
          <div className="knowledge-node-workspace__detail">
            <div className="knowledge-node-workspace__detail-heading">
              <div>
                <p>{selectedBranch?.title}</p>
                <h3>
                  {selectedLeaf?.title ??
                    editBase?.node.title ??
                    "选择节点查看正文"}
                </h3>
              </div>
              {!editing && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={beginDirectEdit}
                  disabled={
                    actionsDisabled ||
                    !currentDetails?.capabilities.directEdit.allowed
                  }
                >
                  <Pencil aria-hidden="true" />
                  直接编辑
                </Button>
              )}
            </div>
            {readPending && (
              <p role="status" className="knowledge-node-workspace__notice">
                正在读取节点正文…
              </p>
            )}
            {generation === undefined && !readonlyPreview && (
              <p className="knowledge-node-workspace__notice">
                等待知识库会话状态同步后读取正文。
              </p>
            )}
            {readError && (
              <div role="alert" className="knowledge-node-workspace__error">
                <p>{readError}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => setReload((value) => value + 1)}
                  disabled={readPending}
                >
                  重新读取
                </Button>
              </div>
            )}
            {savedMessage && (
              <p role="status" className="knowledge-node-workspace__notice">
                {savedMessage}
              </p>
            )}
            {editing ? (
              <>
                <p className="knowledge-node-workspace__notice">
                  节点标题保持不变。修改先保存到工作稿，确认并更新知识库后供后续任务使用。
                </p>
                <div
                  className="knowledge-node-workspace__editor-tabs"
                  role="group"
                  aria-label="编辑正文视图"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={!editorPreview ? "secondary" : "ghost"}
                    aria-pressed={!editorPreview}
                    onClick={() => setEditorPreview(false)}
                  >
                    编辑 Markdown
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={editorPreview ? "secondary" : "ghost"}
                    aria-pressed={editorPreview}
                    onClick={() => setEditorPreview(true)}
                  >
                    预览修改
                  </Button>
                </div>
                {!editorPreview && (
                  <div
                    className="knowledge-node-workspace__editor-formatting"
                    role="group"
                    aria-label="Markdown 格式工具"
                  >
                    {(
                      [
                        ["heading", "二级标题", "插入二级标题"],
                        ["bold", "加粗", "加粗所选文字"],
                        ["list", "列表", "插入无序列表"],
                        ["link", "链接", "插入链接"],
                      ] as const
                    ).map(([kind, label, accessibleName]) => (
                      <Button
                        key={kind}
                        type="button"
                        size="sm"
                        variant="outline"
                        aria-label={accessibleName}
                        disabled={savePending || disabled}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertMarkdown(kind)}
                      >
                        {label}
                      </Button>
                    ))}
                  </div>
                )}
                {editorPreview ? (
                  <div className="knowledge-node-workspace__markdown knowledge-node-workspace__draft-preview">
                    <MarkdownRenderer content={draft} />
                  </div>
                ) : (
                  <Textarea
                    ref={editorElement}
                    className="knowledge-node-workspace__editor"
                    aria-label={`编辑${editBase?.node.title}正文`}
                    value={draft}
                    maxLength={300000 - (editBase?.node.title.length ?? 0) - 4}
                    onChange={(event) => setDraft(event.target.value)}
                    onCompositionStart={() => {
                      composingEditor.current = true;
                    }}
                    onCompositionEnd={() => {
                      composingEditor.current = false;
                    }}
                    disabled={savePending}
                    autoFocus
                  />
                )}
                {saveError && (
                  <p role="alert" className="knowledge-node-workspace__error">
                    {saveError}
                  </p>
                )}
                {(conflicted || latestDiffers) && (
                  <div className="knowledge-node-workspace__conflict">
                    <p>
                      节点状态已更新，你的编辑内容仍保留。查看最新正文后，可取消本次编辑并重新修改，避免覆盖其他更新。
                    </p>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setShowLatest((show) => !show);
                        setReload((value) => value + 1);
                      }}
                    >
                      查看最新正文
                    </Button>
                    {showLatest && currentDetails && (
                      <div className="knowledge-node-workspace__markdown">
                        <h4>最新已保存正文</h4>
                        <MarkdownRenderer
                          content={editableBody(
                            currentDetails.node.contentMarkdown,
                            currentDetails.node.title,
                          )}
                        />
                      </div>
                    )}
                  </div>
                )}
                <div className="knowledge-node-workspace__editor-footer">
                  <span>{dirty ? "尚未保存" : "没有未保存修改"}</span>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={leaveEditor}
                    disabled={mutationPending}
                  >
                    取消编辑
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void saveDraft()}
                    disabled={
                      disabled ||
                      !dirty ||
                      !draft.trim() ||
                      savePending ||
                      conflicted
                    }
                  >
                    {savePending ? "正在保存…" : "保存修改"}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <div className="knowledge-node-workspace__markdown">
                  {currentDetails?.node.contentMarkdown ? (
                    <MarkdownRenderer
                      content={editableBody(
                        currentDetails.node.contentMarkdown,
                        currentDetails.node.title,
                      )}
                    />
                  ) : !readPending && !readError ? (
                    <p className="knowledge-node-workspace__notice">
                      该节点暂时没有可展示的正文。
                    </p>
                  ) : null}
                </div>
                {currentDetails?.resources.filter((resource) =>
                  resource.mimeType.startsWith("image/"),
                ).length ? (
                  <div className="knowledge-node-workspace__resources">
                    {currentDetails.resources
                      .filter((resource) =>
                        resource.mimeType.startsWith("image/"),
                      )
                      .map((resource) => (
                        <figure key={resource.id}>
                          <img
                            src={resource.sameOriginUrl}
                            alt={resource.caption}
                            loading="lazy"
                          />
                          <figcaption>{resource.caption}</figcaption>
                        </figure>
                      ))}
                  </div>
                ) : null}
                {currentDetails && (
                  <>
                    {!currentDetails.capabilities.directEdit.allowed && (
                      <p className="knowledge-node-workspace__notice">
                        {currentDetails.capabilities.directEdit.reason}
                      </p>
                    )}
                    <KnowledgeNodeLocalActions
                      conversationId={conversationId}
                      leafId={currentDetails.node.leafId}
                      disabled={actionsDisabled}
                      editDisabled={!currentDetails.capabilities.aiEdit.allowed}
                      imagesDisabled={
                        !currentDetails.capabilities.manageImages.allowed
                      }
                      editLabel="AI 修改"
                      onBusyChange={setLocalActionPending}
                      onDirtyChange={setImageDirty}
                      onEditTargetSelected={() =>
                        callbacks.current.onEditTargetChange?.({
                          leafId: currentDetails.node.leafId,
                          title: currentDetails.node.title,
                          mode: "ai",
                        })
                      }
                    />
                    {!currentDetails.capabilities.aiEdit.allowed &&
                      currentDetails.capabilities.aiEdit.reason !==
                        currentDetails.capabilities.directEdit.reason && (
                        <p className="knowledge-node-workspace__notice">
                          AI 修改：{currentDetails.capabilities.aiEdit.reason}
                        </p>
                      )}
                    {!currentDetails.capabilities.manageImages.allowed &&
                      currentDetails.capabilities.manageImages.reason !==
                        currentDetails.capabilities.directEdit.reason && (
                        <p className="knowledge-node-workspace__notice">
                          图片操作：
                          {currentDetails.capabilities.manageImages.reason}
                        </p>
                      )}
                  </>
                )}
              </>
            )}
          </div>
        </>
      )}
      <Dialog
        open={Boolean(pendingDestination)}
        onOpenChange={(open) => {
          if (!open && !mutationPending) setPendingDestination(null);
        }}
      >
        <DialogContent className="knowledge-node-workspace-dialog">
          <DialogHeader>
            <DialogTitle>当前节点有未保存修改</DialogTitle>
            <DialogDescription>
              保存后可继续查看其他内容；放弃会丢失这次尚未保存的正文。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPendingDestination(null)}
              disabled={mutationPending}
            >
              继续编辑
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={completeDestination}
              disabled={mutationPending}
            >
              放弃修改
            </Button>
            <Button
              type="button"
              onClick={() =>
                void saveDraft().then((saved) => {
                  if (saved) completeDestination();
                })
              }
              disabled={mutationPending || conflicted || !draft.trim()}
            >
              保存后继续
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

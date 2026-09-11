import { createPortal } from "react-dom";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  Check,
  Circle,
  CircleDot,
  CircleHelp,
  FileCheck2,
  ChevronDown,
  ChevronRight,
  Crosshair,
  Download,
  Pencil,
  Search,
  Undo2,
  X,
} from "lucide-react";
import type {
  KnowledgeBaseLeafStatus,
  KnowledgeBaseProgressDto,
} from "@shared/knowledge-base-progress";
import type {
  KnowledgeNodeDetailsDto,
  KnowledgeNodeSearchMatch,
  KnowledgeNodeSearchResult,
  KnowledgeNodeSaveInput,
  KnowledgeNodeSaveResult,
} from "@shared/knowledge-node-workspace";
import { useConversation } from "@/contexts/ConversationContext";
import { captureWorkspaceRestOperation } from "@/lib/workspace-rest-scope";
import { projectResourceUrl } from "@/lib/enterprise-project";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
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
  /** The workbench owns its responsive drawer; node details stay in its auxiliary panel. */
  detailPresentation?: "drawer" | "inline";
  detailContainer?: HTMLElement | null;
  nodeConversation?: { leafId: string; content: React.ReactNode };
  onDetailsOpenChange?: (open: boolean) => void;
  autoOpenDetails?: boolean;
  onNodeOpen?: () => void;
  onEditTargetChange?: (target: KnowledgeNodeEditTarget | null) => void;
  onDirtyChange?: (dirty: boolean) => void;
  onMutationPendingChange?: (pending: boolean) => void;
  /** Local design fixtures are read-only and are ignored in production builds. */
  previewDetails?: KnowledgeNodeDetailsDto[];
}

const statusLabels: Record<KnowledgeBaseLeafStatus, string> = {
  confirmed: "已确认",
  direct_prefilled: "已有资料",
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
  detailPresentation = "drawer",
  detailContainer,
  nodeConversation,
  onDetailsOpenChange,
  autoOpenDetails = false,
  onNodeOpen,
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
  const [searchMatches, setSearchMatches] = useState<
    KnowledgeNodeSearchMatch[]
  >([]);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [collapsedBranches, setCollapsedBranches] = useState<Set<string>>(
    () => new Set(),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  useEffect(() => {
    if (autoOpenDetails) setDrawerOpen(true);
  }, [autoOpenDetails]);
  const inlineDetails = detailPresentation === "inline";
  const detailTitleId = useId();
  const detailDescriptionId = useId();
  const inlineDetailsElement = useRef<HTMLElement>(null);
  const previousInlineOpen = useRef(false);
  const [details, setDetails] = useState<KnowledgeNodeDetailsDto | null>(null);
  const [readPending, setReadPending] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [observedContentVersion, setObservedContentVersion] = useState(0);
  const [editBase, setEditBase] = useState<KnowledgeNodeDetailsDto | null>(
    null,
  );
  useEffect(() => {
    onDetailsOpenChange?.(drawerOpen);
  }, [drawerOpen, onDetailsOpenChange]);
  const [draft, setDraft] = useState("");
  const [editorPreview, setEditorPreview] = useState(false);
  const [savePending, setSavePending] = useState(false);
  const [localActionPending, setLocalActionPending] = useState(false);
  const [imageDirty, setImageDirty] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [selectPending, setSelectPending] = useState(false);
  const [selectError, setSelectError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const [showLatest, setShowLatest] = useState(false);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const [manualEditedLeafIds, setManualEditedLeafIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [pendingDestination, setPendingDestination] = useState<
    { kind: "node"; leafId: string } | { kind: "close" | "editor" } | null
  >(null);
  const workspaceElement = useRef<HTMLElement>(null);
  const returnToComposer = useRef(false);
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
    if (initiallyLocated.current || !selectedLeafId) return;
    const frame = window.requestAnimationFrame(() => {
      const node = nodeElements.current.get(selectedLeafId);
      if (lifetime.current.signal.aborted || !node?.isConnected) return;
      node.scrollIntoView?.({ block: "nearest", behavior: "auto" });
      initiallyLocated.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [selectedLeafId, leaves]);

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
    if (!drawerOpen || !selectedLeafId) return;
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
    drawerOpen,
    selectedLeafId,
    expectedContentVersion,
    progress?.build.id,
    progress?.build.revision,
    reload,
    readonlyPreview,
    previewDetails,
  ]);

  // Title filtering stays local; content matches come from the current,
  // coordinate-bound working set. Debouncing and aborting keep stale results
  // from changing the directory while the user is typing or switching builds.
  useEffect(() => {
    const query = search.trim();
    if (!query) {
      setSearchMatches([]);
      setSearchError(null);
      return;
    }
    if (readonlyPreview) {
      const normalized = query.toLocaleLowerCase();
      const matches = (previewDetails ?? []).flatMap((item) => {
        const titleMatched = item.node.title
          .toLocaleLowerCase()
          .includes(normalized);
        const contentMatched = item.node.contentMarkdown
          .toLocaleLowerCase()
          .includes(normalized);
        if (!titleMatched && !contentMatched) return [];
        return [
          {
            leafId: item.node.leafId,
            branchId: "preview",
            branchTitle: "预览",
            title: item.node.title,
            status: item.node.status,
            snippet: contentMatched
              ? item.node.contentMarkdown.slice(0, 180)
              : item.node.title,
            matchFields: [
              ...(titleMatched ? ["title" as const] : []),
              ...(contentMatched ? ["content" as const] : []),
            ],
          },
        ];
      });
      setSearchMatches(matches);
      setSearchError(null);
      return;
    }
    if (
      !conversationId ||
      generation === undefined ||
      expectedContentVersion <= 0
    ) {
      setSearchMatches([]);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const rest = captureWorkspaceRestOperation(
      AbortSignal.any([lifetime.current.signal, controller.signal]),
    );
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const params = new URLSearchParams({
            conversationId,
            query,
            expectedGeneration: String(generation),
            expectedContentVersion: String(expectedContentVersion),
            ...(resetRevision === undefined
              ? {}
              : { expectedResetRevision: String(resetRevision) }),
          });
          const response = await rest.fetch(
            `/api/knowledge-base/node/search?${params}`,
            { credentials: "include" },
          );
          const result =
            (await response.json()) as KnowledgeNodeSearchResult & {
              error?: { message?: string };
            };
          rest.assertActive();
          if (!response.ok) {
            throw new NodeRequestError(
              result.error?.message ?? "节点搜索暂时不可用，请重试。",
              response.status,
            );
          }
          if (
            result.coordinates.conversationId !== conversationId ||
            result.coordinates.generation !== generation ||
            result.coordinates.contentVersion !== expectedContentVersion ||
            (resetRevision !== undefined &&
              result.coordinates.resetRevision !== resetRevision)
          ) {
            throw new NodeRequestError("知识库内容已更新，请重新搜索。", 409);
          }
          setSearchMatches(result.matches);
        } catch (error) {
          if (rest.signal.aborted) return;
          setSearchMatches([]);
          setSearchError(
            error instanceof Error ? error.message : "节点搜索失败，请重试。",
          );
        }
      })();
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [
    conversationId,
    expectedContentVersion,
    generation,
    previewDetails,
    readonlyPreview,
    resetRevision,
    search,
  ]);

  const finishEditing = () => {
    setEditBase(null);
    setDraft("");
    setEditorPreview(false);
    setSaveError(null);
    setConflicted(false);
    setShowLatest(false);
    saveAttempt.current = null;
    callbacks.current.onEditTargetChange?.(null);
  };

  const saveDraft = async (downloadAfterSave = false): Promise<boolean> => {
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
      if (downloadAfterSave) {
        // Export the authoritative saved observation, never the editor's old
        // coordinates or a parent render that has not caught up with this save.
        const savedProgress = saved.observation.interaction.progress;
        if (!savedProgress?.build.contentVersion) {
          setSavedMessage(
            "修改已保存，暂未取得导出版本。请从右侧下载已保存工作稿。",
          );
          return true;
        }
        const params = new URLSearchParams({
          conversationId,
          expectedGeneration: String(saved.observation.generation),
          expectedRevision: String(savedProgress.build.revision),
          expectedStateEpoch: String(saved.observation.stateEpoch),
          expectedContentVersion: String(savedProgress.build.contentVersion),
          expectedResetRevision: String(coordinates.resetRevision),
        });
        rest.assertActive();
        const download = document.createElement("a");
        download.href = projectResourceUrl(
          `/api/knowledge-base/workspace-export?${params}`,
        );
        download.download = "";
        download.target = "_blank";
        download.rel = "noreferrer";
        document.body.appendChild(download);
        download.click();
        download.remove();
      }
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

  const openLeaf = (leafId: string) => {
    if (editing) finishEditing();
    if (leafId !== selectedLeafId) {
      setSelectedLeafId(leafId);
      setDetails(null);
      setReadError(null);
      setSavedMessage(null);
    }
    setDrawerOpen(true);
    onNodeOpen?.();
  };
  const selectLeaf = (leafId: string) => {
    if (mutationPending || imageDirty) return;
    if (drawerOpen && leafId === selectedLeafId) {
      onNodeOpen?.();
      return;
    }
    if (dirty) {
      setPendingDestination({ kind: "node", leafId });
      return;
    }
    openLeaf(leafId);
  };
  const closeDrawer = () => {
    if (mutationPending || imageDirty) return;
    if (dirty) {
      setPendingDestination({ kind: "close" });
      return;
    }
    if (editing) finishEditing();
    setDrawerOpen(false);
  };
  const leaveEditor = () => {
    if (mutationPending) return;
    if (dirty) setPendingDestination({ kind: "editor" });
    else finishEditing();
  };
  const completeDestination = () => {
    const destination = pendingDestination;
    finishEditing();
    if (destination?.kind === "node") {
      setSelectedLeafId(destination.leafId);
      setDetails(null);
      setReadError(null);
      setSavedMessage(null);
    } else if (destination?.kind === "close") {
      setDrawerOpen(false);
    }
    setPendingDestination(null);
  };
  const restoreDrawerFocus = (event: Event) => {
    event.preventDefault();
    if (returnToComposer.current) {
      returnToComposer.current = false;
      workspaceElement.current
        ?.closest(".knowledge-workspace-surfaces")
        ?.querySelector<HTMLTextAreaElement>(
          ".knowledge-workspace-task textarea",
        )
        ?.focus();
      return;
    }
    if (selectedLeafId) {
      const branch = branches.find((item) =>
        item.leaves.some((leaf) => leaf.id === selectedLeafId),
      );
      if (branch)
        setCollapsedBranches((old) => {
          const next = new Set(old);
          next.delete(branch.id);
          return next;
        });
      requestAnimationFrame(() => {
        if (!lifetime.current.signal.aborted)
          (
            nodeElements.current.get(selectedLeafId) ??
            workspaceElement.current?.querySelector<HTMLButtonElement>("button")
          )?.focus({ preventScroll: true });
      });
    }
  };
  useEffect(() => {
    if (!inlineDetails) return;
    if (drawerOpen && !previousInlineOpen.current) {
      inlineDetailsElement.current?.focus({ preventScroll: true });
    } else if (!drawerOpen && previousInlineOpen.current) {
      restoreDrawerFocus(new Event("closeAutoFocus", { cancelable: true }));
    }
    previousInlineOpen.current = drawerOpen;
  });
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
  const contentMatchIds = useMemo(
    () => new Set(searchMatches.map((match) => match.leafId)),
    [searchMatches],
  );
  const visibleBranches = branches
    .map((branch) => ({
      ...branch,
      leaves: branch.leaves.filter(
        (leaf) =>
          !searchTerm ||
          leaf.title.toLocaleLowerCase().includes(searchTerm) ||
          contentMatchIds.has(leaf.id),
      ),
    }))
    .filter((branch) => branch.leaves.length > 0);
  /** Re-open the local walkthrough on a settled node: the server marks it
   * needs_verification, points the build cursor back at it and restores a
   * presentation so confirm / AI revision become available again. */
  const reverifyCurrentNode = async () => {
    const build = progress?.build;
    if (!currentDetails || !build || generation === undefined) return;
    if (selectPending || mutationPending || dirty || imageDirty) return;
    const rest = captureWorkspaceRestOperation(lifetime.current.signal);
    setSelectPending(true);
    setSelectError(null);
    try {
      const response = await rest.fetch("/api/knowledge-base/node/select", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId,
          clientRequestId: crypto.randomUUID(),
          leafId: currentDetails.node.leafId,
          expectedGeneration: generation,
          expectedRevision: build.revision,
          expectedStateEpoch: progress?.workbench?.stateEpoch ?? 0,
        }),
      });
      const result = await response.json();
      rest.assertActive();
      if (!response.ok) {
        acceptErrorObservation(result);
        throw new NodeRequestError(
          result.error?.message ?? "节点选择失败，请刷新后重试。",
          response.status,
        );
      }
      if (result?.observation)
        commitKnowledgeBaseObservation(conversationId, result.observation);
      setDetails(null);
      setSelectedLeafId(currentDetails.node.leafId);
      setSavedMessage("已选择该节点重新核验：可确认、跳过预填或让 AI 修改。");
    } catch (error) {
      if (!rest.signal.aborted)
        setSelectError(
          error instanceof Error
            ? error.message
            : "节点选择失败，请刷新后重试。",
        );
    } finally {
      setSelectPending(false);
    }
  };
  const buildAllowsNodeSelection =
    progress?.workbench?.phase === "editing" &&
    Boolean(
      progress?.build &&
        !progress.build.awaitingResponseSince &&
        ["confirming", "ready_to_publish", "published"].includes(
          progress.build.status,
        ),
    );
  const canReverifyNode =
    Boolean(currentDetails) &&
    buildAllowsNodeSelection &&
    (currentDetails?.node.status === "confirmed" ||
      currentDetails?.node.status === "direct_prefilled") &&
    progress?.build.currentLeafId !== currentDetails?.node.leafId;
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

  const DetailTitle = inlineDetails ? "h2" : SheetTitle;
  const DetailDescription = inlineDetails ? "p" : SheetDescription;
  const detailContent = (
    <>
      <header className="knowledge-node-workspace__drawer-header">
        <div>
          <p>{selectedBranch?.title}</p>
          <DetailTitle {...(inlineDetails ? { id: detailTitleId } : {})}>
            {selectedLeaf?.title ?? editBase?.node.title ?? "知识节点正文"}
          </DetailTitle>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          aria-label="关闭节点详情"
          onClick={closeDrawer}
          disabled={mutationPending || imageDirty}
        >
          <X aria-hidden="true" />
        </Button>
        <DetailDescription
          {...(inlineDetails ? { id: detailDescriptionId } : {})}
          className="sr-only"
        >
          查看节点正文，直接编辑、使用 AI 修改或管理本地图片。
        </DetailDescription>
      </header>
      {!detailContainer && (
        <label className="knowledge-node-workspace__node-switch">
          切换节点
          <select
            aria-label="切换知识节点"
            value={selectedLeafId ?? ""}
            onChange={(event) => selectLeaf(event.target.value)}
            disabled={mutationPending || imageDirty}
          >
            {branches.map((branch) => (
              <optgroup key={branch.id} label={branch.title}>
                {branch.leaves.map((leaf) => (
                  <option key={leaf.id} value={leaf.id}>
                    {leaf.title} · {leafStatusLabel(leaf)}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      )}
      <div className="knowledge-node-workspace__detail">
        <div className="knowledge-node-workspace__detail-heading">
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
              {progress?.workbench && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void saveDraft(true)}
                  disabled={
                    disabled ||
                    !dirty ||
                    !draft.trim() ||
                    mutationPending ||
                    conflicted ||
                    progress.contentAvailability !== "complete" ||
                    Boolean(progress.build.awaitingResponseSince)
                  }
                >
                  <Download />
                  保存后下载 ZIP
                </Button>
              )}
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
                  .filter((resource) => resource.mimeType.startsWith("image/"))
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
                {canReverifyNode && (
                  <>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void reverifyCurrentNode()}
                      disabled={actionsDisabled || selectPending}
                    >
                      <Undo2 aria-hidden="true" />
                      {selectPending ? "正在选择…" : "重新核验"}
                    </Button>
                    {selectError && (
                      <p role="alert" className="knowledge-node-workspace__notice">
                        {selectError}
                      </p>
                    )}
                  </>
                )}
                <KnowledgeNodeLocalActions
                  conversationId={conversationId}
                  leafId={currentDetails.node.leafId}
                  resetRevision={currentDetails.coordinates.resetRevision}
                  disabled={actionsDisabled}
                  editDisabled={!currentDetails.capabilities.aiEdit.allowed}
                  imagesDisabled={
                    !currentDetails.capabilities.manageImages.allowed
                  }
                  editLabel="AI 修改"
                  onBusyChange={setLocalActionPending}
                  onDirtyChange={setImageDirty}
                  onImagesSaved={() => setReload((value) => value + 1)}
                  onEditTargetSelected={() => {
                    callbacks.current.onEditTargetChange?.({
                      leafId: currentDetails.node.leafId,
                      title: currentDetails.node.title,
                      mode: "ai",
                    });
                    if (!detailContainer) {
                      returnToComposer.current = true;
                      setDrawerOpen(false);
                    }
                  }}
                />
                {!currentDetails.capabilities.aiEdit.allowed &&
                  currentDetails.capabilities.aiEdit.reason !==
                    currentDetails.capabilities.directEdit.reason && (
                    <p className="knowledge-node-workspace__notice">
                      AI 修改：
                      {currentDetails.capabilities.aiEdit.reason}
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
        {nodeConversation?.leafId === selectedLeafId &&
          nodeConversation.content}
      </div>
    </>
  );

  return (
    <section
      className={`knowledge-node-workspace ${editing ? "is-editing" : ""} ${className}`}
      ref={workspaceElement}
      aria-label="知识节点工作区"
    >
      <header
        className="knowledge-node-workspace__header"
        hidden={inlineDetails && drawerOpen && !detailContainer}
      >
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
      {readonlyPreview && !(inlineDetails && drawerOpen) && (
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
          <div
            className="knowledge-node-workspace__directory"
            hidden={inlineDetails && drawerOpen && !detailContainer}
          >
            <div className="knowledge-node-workspace__search">
              <Search aria-hidden="true" />
              <Input
                aria-label="搜索节点标题"
                placeholder="搜索节点标题或内容"
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
              {searchError && (
                <p role="alert" className="knowledge-node-workspace__error">
                  {searchError}
                </p>
              )}
              {visibleBranches.length === 0 ? (
                <p className="knowledge-node-workspace__notice">
                  没有匹配的知识节点。
                </p>
              ) : (
                <ul>
                  {visibleBranches.map((branch) => {
                    const expanded =
                      Boolean(searchTerm) || !collapsedBranches.has(branch.id);
                    const percent =
                      branch.total > 0
                        ? Math.min(
                            100,
                            Math.round((branch.handled / branch.total) * 100),
                          )
                        : 0;
                    return (
                      <li
                        key={branch.id}
                        className="knowledge-node-workspace__branch-card"
                      >
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
                          <span className="knowledge-node-workspace__branch-number">
                            {String(
                              branches.findIndex(
                                (item) => item.id === branch.id,
                              ) + 1,
                            ).padStart(2, "0")}
                          </span>
                          <span className="knowledge-node-workspace__branch-summary">
                            <span className="knowledge-node-workspace__branch-heading">
                              <strong>{branch.title}</strong>
                              <span>
                                {branch.handled} / {branch.total} · {percent}%
                              </span>
                            </span>
                            <span
                              className="knowledge-node-workspace__branch-progress"
                              aria-hidden="true"
                            >
                              <span style={{ width: `${percent}%` }} />
                            </span>
                          </span>
                          {expanded ? (
                            <ChevronDown aria-hidden="true" />
                          ) : (
                            <ChevronRight aria-hidden="true" />
                          )}
                        </button>
                        {expanded && (
                          <div className="knowledge-node-workspace__branch-body">
                            <div
                              className="knowledge-node-workspace__branch-counts"
                              aria-label={`${branch.title}节点状态`}
                            >
                              <span data-status="confirmed">
                                已整理{" "}
                                {branch.confirmed + branch.directPrefilled}
                              </span>
                              <span data-status="needs_verification">
                                待再次确认 {branch.needsVerification}
                              </span>
                              <span
                                data-status="pending"
                                title="包含当前正在处理的节点"
                              >
                                待处理 {branch.pending + branch.current}
                              </span>
                            </div>
                            <ul>
                              {branch.leaves.map((leaf) => {
                                const StatusIcon = {
                                  confirmed: Check,
                                  direct_prefilled: FileCheck2,
                                  current: CircleDot,
                                  needs_verification: CircleHelp,
                                  pending: Circle,
                                }[leaf.status];
                                return (
                                  <li key={leaf.id}>
                                    <button
                                      type="button"
                                      ref={(node) => {
                                        if (node)
                                          nodeElements.current.set(
                                            leaf.id,
                                            node,
                                          );
                                        else
                                          nodeElements.current.delete(leaf.id);
                                      }}
                                      className="knowledge-node-workspace__leaf"
                                      data-status={leaf.status}
                                      aria-label={`${leaf.title} ${leafStatusLabel(leaf)}`}
                                      aria-current={
                                        leaf.id === selectedLeafId
                                          ? "true"
                                          : undefined
                                      }
                                      aria-haspopup={
                                        inlineDetails ? undefined : "dialog"
                                      }
                                      onClick={() => selectLeaf(leaf.id)}
                                      disabled={mutationPending}
                                    >
                                      <span className="knowledge-node-workspace__leaf-icon">
                                        <StatusIcon aria-hidden="true" />
                                      </span>
                                      <span className="knowledge-node-workspace__leaf-title">
                                        {leaf.title}
                                      </span>
                                      <span
                                        className={`knowledge-node-workspace__status is-${leaf.status}`}
                                      >
                                        {leafStatusLabel(leaf)}
                                      </span>
                                      <ChevronRight aria-hidden="true" />
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </nav>
          </div>
          {inlineDetails ? (
            drawerOpen &&
            ((content: React.ReactNode) =>
              detailContainer
                ? createPortal(content, detailContainer)
                : content)(
              <section
                ref={inlineDetailsElement}
                className="knowledge-node-workspace knowledge-node-workspace__inline-detail"
                aria-labelledby={detailTitleId}
                aria-describedby={detailDescriptionId}
                tabIndex={-1}
                onKeyDown={(event) => {
                  if (
                    event.key !== "Escape" ||
                    event.defaultPrevented ||
                    event.nativeEvent.isComposing
                  )
                    return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (!mutationPending && !imageDirty && !pendingDestination)
                    closeDrawer();
                }}
              >
                {detailContent}
              </section>,
            )
          ) : (
            <Sheet
              open={drawerOpen}
              onOpenChange={(open) => {
                if (!open) closeDrawer();
              }}
            >
              <SheetContent
                side="right"
                className="knowledge-node-workspace knowledge-node-workspace-drawer"
                overlayClassName="knowledge-node-workspace-overlay"
                showCloseButton={false}
                onCloseAutoFocus={restoreDrawerFocus}
                onEscapeKeyDown={(event) => {
                  if (mutationPending || imageDirty || pendingDestination)
                    event.preventDefault();
                }}
                onPointerDownOutside={(event) => {
                  if (mutationPending || imageDirty || pendingDestination)
                    event.preventDefault();
                }}
              >
                {detailContent}
              </SheetContent>
            </Sheet>
          )}
        </>
      )}
      <Dialog
        open={Boolean(pendingDestination)}
        onOpenChange={(open) => {
          if (!open && !mutationPending) setPendingDestination(null);
        }}
      >
        <DialogContent
          className="knowledge-node-workspace-dialog"
          showCloseButton={!mutationPending}
          onEscapeKeyDown={(event) => {
            if (mutationPending) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (mutationPending) event.preventDefault();
          }}
        >
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

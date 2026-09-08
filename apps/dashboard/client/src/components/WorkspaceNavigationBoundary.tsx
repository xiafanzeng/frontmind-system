import { useEffect, useRef, useState } from "react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { getUnsavedWorkspaceDrafts, installWorkspaceNavigationGuard, performApprovedWorkspaceNavigation, subscribeWorkspaceDrafts, type WorkspaceDraft } from "@/lib/workspace-navigation-guard";

type PendingNavigation = { action: () => void; origin: string; drafts: WorkspaceDraft[] };

export default function WorkspaceNavigationBoundary() {
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draftRevision, setDraftRevision] = useState(0);
  const savingRef = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    const uninstall = installWorkspaceNavigationGuard((action, drafts) => {
      if (savingRef.current) return;
      setError("");
      setPending({ action, drafts, origin: window.location.href });
    });
    const unsubscribe = subscribeWorkspaceDrafts(() => setDraftRevision(value => value + 1));
    return () => { mounted.current = false; unsubscribe(); uninstall(); };
  }, []);
  const leave = (request: PendingNavigation) => {
    if (!mounted.current) return;
    setPending(null);
    // An old prompt must never replace navigation that already happened elsewhere.
    if (window.location.href === request.origin) performApprovedWorkspaceNavigation(request.action);
  };
  useEffect(() => {
    if (!pending || savingRef.current) return;
    const currentDrafts = getUnsavedWorkspaceDrafts();
    if (!currentDrafts.length) leave(pending);
    else if (pending.drafts.length !== currentDrafts.length || pending.drafts.some((draft, index) => draft !== currentDrafts[index])) {
      setPending({ ...pending, drafts: currentDrafts });
    }
  }, [pending, draftRevision]);
  const save = async () => {
    if (!pending || savingRef.current) return;
    const request = pending;
    savingRef.current = true;
    setSaving(true);
    setError("");
    const saved = new Set<WorkspaceDraft>();
    try {
      for (const draft of getUnsavedWorkspaceDrafts()) {
        if (!getUnsavedWorkspaceDrafts().includes(draft)) continue;
        if (!draft.save || !(await draft.save())) {
          if (mounted.current) setError("修改尚未保存，请继续编辑并处理保存提示。");
          return;
        }
        saved.add(draft);
        if (!mounted.current) return;
      }
      if (getUnsavedWorkspaceDrafts().some(draft => !saved.has(draft))) {
        setError("仍有新修改尚未保存，请继续编辑。");
        return;
      }
      leave(request);
    } catch {
      if (mounted.current) setError("保存失败，内容仍保留在当前页面。");
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  const discard = async () => {
    if (!pending || savingRef.current) return;
    const request = pending;
    savingRef.current = true; setSaving(true); setError("");
    const discarded = new Set<WorkspaceDraft>();
    try {
      for (const draft of getUnsavedWorkspaceDrafts()) {
        if (!getUnsavedWorkspaceDrafts().includes(draft)) continue;
        if (draft.discard && !(await draft.discard())) {
          if (mounted.current) setError("本次修改尚未安全取消，请继续编辑并处理提示。");
          return;
        }
        discarded.add(draft);
        if (!mounted.current) return;
      }
      if (getUnsavedWorkspaceDrafts().some(draft => !discarded.has(draft))) {
        setError("仍有新修改尚未处理，请继续编辑。");
        return;
      }
      leave(request);
    } catch {
      if (mounted.current) setError("取消失败，内容仍保留在当前页面。");
    } finally {
      savingRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };
  return <Dialog open={Boolean(pending)} onOpenChange={open => { if (!open && !savingRef.current) setPending(null); }}>
    <DialogContent className="operator-dialog" showCloseButton={!saving} onEscapeKeyDown={event => { if (savingRef.current) event.preventDefault(); }} onPointerDownOutside={event => { if (savingRef.current) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>还有未保存的内容</DialogTitle><DialogDescription>
        {pending?.drafts.map(draft => draft.label).join("、")}尚未保存。离开后这些输入将被丢弃。
      </DialogDescription></DialogHeader>
      {error && <p role="alert">{error}</p>}
      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={() => setPending(null)}>继续编辑</Button>
        <Button variant="outline" disabled={saving} onClick={() => void discard()}>放弃并离开</Button>
        {pending?.drafts.every(draft => draft.save) && <Button disabled={saving} onClick={() => void save()}>{saving ? "正在保存…" : "保存后离开"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

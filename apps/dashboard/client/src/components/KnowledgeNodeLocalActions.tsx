import { useState } from "react";
import { ImageIcon, Pencil, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { deliveryProjectHeaders } from "@/lib/delivery-project";
import { useConversation } from "@/contexts/ConversationContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import type { KnowledgeBaseObservationDto } from "@shared/knowledge-base-progress";

type Library = {
  coordinates: {
    conversationId: string;
    expectedGeneration: number;
    expectedRevision: number;
    expectedStateEpoch: number;
    expectedContentVersion: number;
    expectedLeafId: string;
  };
  images: Array<{
    assetId: string;
    url: string;
    caption: string;
    attached: boolean;
    removable: boolean;
    selectable: boolean;
  }>;
};
async function localRequest(path: string, body?: unknown) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
    credentials: "include",
    headers: deliveryProjectHeaders({ "Content-Type": "application/json" }),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(result.error?.message ?? "节点状态已变化，请刷新后重试");
  return result;
}

export default function KnowledgeNodeLocalActions({
  conversationId,
  leafId,
  disabled = false,
}: {
  conversationId: string;
  leafId: string;
  disabled?: boolean;
}) {
  const {
    commitKnowledgeBaseObservation,
    refreshConversations,
    wakeKnowledgeBaseConversation,
  } = useConversation();
  const [busy, setBusy] = useState(false);
  const [library, setLibrary] = useState<Library | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const readLibrary = async () =>
    localRequest(
      `/api/knowledge-base/node/images?${new URLSearchParams({ conversationId, leafId })}`,
    ) as Promise<Library>;
  const commit = async (observation?: KnowledgeBaseObservationDto) => {
    if (observation)
      commitKnowledgeBaseObservation(conversationId, observation);
    await refreshConversations();
    window.dispatchEvent(
      new CustomEvent("frontmind:knowledge-progress-updated"),
    );
  };
  const selectNode = async (data: Library) => {
    const result = await localRequest("/api/knowledge-base/node/select", {
      ...data.coordinates,
      leafId,
      clientRequestId: crypto.randomUUID(),
    });
    await commit(result.observation);
    return result.observation as KnowledgeBaseObservationDto;
  };
  const edit = async () => {
    setBusy(true);
    try {
      await selectNode(await readLibrary());
      toast.success("已选择该节点，可在输入框修改文字或上传图片");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "无法选择节点");
    } finally {
      setBusy(false);
    }
  };
  const openLibrary = async () => {
    setBusy(true);
    try {
      const data = await readLibrary();
      setLibrary(data);
      setSelected(
        new Set(
          data.images
            .filter((image) => image.attached)
            .map((image) => image.assetId),
        ),
      );
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片加载失败");
    } finally {
      setBusy(false);
    }
  };
  const saveImages = async () => {
    if (!library) return;
    const removeAssetIds = library.images
      .filter((image) => image.attached && !selected.has(image.assetId))
      .map((image) => image.assetId);
    const selectedAssetIds = library.images
      .filter((image) => !image.attached && selected.has(image.assetId))
      .map((image) => image.assetId);
    if (!removeAssetIds.length && !selectedAssetIds.length) {
      setLibrary(null);
      return;
    }
    setBusy(true);
    try {
      const observation = await selectNode(library);

      const result = await localRequest("/api/knowledge-base/turn", {
        conversationId,
        clientRequestId: crypto.randomUUID(),
        userMessage: "",
        attachments: [],
        removeAssetIds,
        selectedAssetIds,
        expectedGeneration: observation.generation,
        expectedRevision: observation.interaction.progress!.build.revision,
        expectedLeafId: leafId,
        expectedPresentationKey:
          observation.approvedPresentation?.presentationKey,
      });
      await commit(result.observation);
      wakeKnowledgeBaseConversation(conversationId);
      setLibrary(null);
      toast.success("本地图片修改已提交，不调用 AI");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "图片保存失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="mt-4 flex flex-wrap gap-2 border-t border-slate-100 pt-3">
        <Button
          size="sm"
          variant="outline"
          onClick={() => void edit()}
          disabled={disabled || busy}
        >
          {busy ? (
            <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
          ) : (
            <Pencil className="mr-1 h-3.5 w-3.5" />
          )}
          编辑文字 / 上传图片
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void openLibrary()}
          disabled={disabled || busy}
        >
          <ImageIcon className="mr-1 h-3.5 w-3.5" />
          本地图片
        </Button>
      </div>
      <Dialog
        open={Boolean(library)}
        onOpenChange={(open) => {
          if (!open && !busy) setLibrary(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>当前节点的本地图片</DialogTitle>
            <DialogDescription>
              勾选绑定图片，取消勾选移除图片；替换时选择新图并移除旧图。上传新图片请使用节点输入框，全程不调用
              AI。
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[55vh] grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-3">
            {library?.images.map((item) => (
              <label
                key={item.assetId}
                className={`cursor-pointer rounded-xl border p-2 ${selected.has(item.assetId) ? "border-violet-500 bg-violet-50" : "border-slate-200"}`}
              >
                <img
                  src={item.url}
                  alt={item.caption}
                  className="h-28 w-full rounded-lg object-contain"
                />
                <span className="mt-2 flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selected.has(item.assetId)}
                    disabled={
                      busy ||
                      (item.attached ? !item.removable : !item.selectable)
                    }
                    onChange={(event) =>
                      setSelected((old) => {
                        const next = new Set(old);
                        event.target.checked
                          ? next.add(item.assetId)
                          : next.delete(item.assetId);
                        return next;
                      })
                    }
                  />
                  {item.attached ? "当前节点" : "已有上传图片"}
                </span>
              </label>
            ))}
          </div>
          {library?.images.length === 0 && (
            <p className="py-8 text-center text-sm text-slate-500">
              尚无本地图片，请在节点输入框上传。
            </p>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setLibrary(null)}
              disabled={busy}
            >
              取消
            </Button>
            <Button onClick={() => void saveImages()} disabled={busy}>
              {busy ? "正在保存…" : "保存图片"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

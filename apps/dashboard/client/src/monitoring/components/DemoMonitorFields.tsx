import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";

/** Isolated presentation drafts; deliberately absent from MonitorInput. */
export function DemoBrandPicker({ projectBrand }: { projectBrand: string }) {
  const [open, setOpen] = useState(false);
  const [brand, setBrand] = useState(projectBrand);
  const [aliases, setAliases] = useState("");
  const [draft, setDraft] = useState(brand);
  const [aliasDraft, setAliasDraft] = useState("");
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setDraft(brand);
          setAliasDraft(aliases);
        }
        setOpen(next);
      }}
    >
      <div className="field fm-demo-brand-field">
        <span>
          监控品牌 <small>演示草稿</small>
        </span>
        <Dialog.Trigger asChild>
          <button
            type="button"
            className="fm-demo-brand-select"
            aria-label="选择演示监控品牌"
          >
            {brand}
            <ChevronDown size={14} />
          </button>
        </Dialog.Trigger>
      </div>
      <Dialog.Portal
        container={document.getElementById("monitoring-module-portals")}
      >
        <Dialog.Overlay className="fm-dialog-overlay fm-demo-brand-overlay" />
        <Dialog.Content className="fm-correction-dialog fm-demo-brand-dialog">
          <header>
            <div>
              <Dialog.Title>选择监控品牌 · 演示</Dialog.Title>
              <Dialog.Description>
                仅编辑演示草稿，不变更企业项目品牌。
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="fm-icon-button"
                aria-label="关闭演示品牌选择"
              >
                <X size={17} />
              </button>
            </Dialog.Close>
          </header>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              event.stopPropagation();
              if (!draft.trim()) return;
              setBrand(draft.trim());
              setAliases(aliasDraft.trim());
              setOpen(false);
            }}
          >
            <label className="fm-demo-brand-input">
              合成品牌
              <select
                aria-label="选择合成品牌"
                value={
                  [projectBrand, "拾木家居", "原野设计"].includes(draft)
                    ? draft
                    : ""
                }
                onChange={(event) => setDraft(event.target.value)}
              >
                <option value="" disabled>
                  自定义演示名称
                </option>
                {[projectBrand, "拾木家居", "原野设计"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="fm-demo-brand-input">
              品牌名称
              <input
                aria-label="演示品牌名称"
                required
                maxLength={80}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
              />
            </label>
            <label className="fm-demo-brand-input">
              品牌别名
              <input
                aria-label="演示品牌别名"
                maxLength={160}
                placeholder="多个别名用逗号分隔"
                value={aliasDraft}
                onChange={(event) => setAliasDraft(event.target.value)}
              />
            </label>
            <footer>
              <Dialog.Close asChild>
                <button type="button" className="fm-secondary-button">
                  取消
                </button>
              </Dialog.Close>
              <button
                type="submit"
                className="fm-primary-button"
                disabled={!draft.trim()}
              >
                确定演示品牌
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function DemoKeywordPanel() {
  const [keywords, setKeywords] = useState([
    { id: 1, value: "", enabled: true },
  ]);
  const [nextId, setNextId] = useState(2);
  return (
    <aside className="fm-demo-keywords" aria-label="核心词演示草稿">
      <header>
        <strong>核心词</strong>
        <button
          type="button"
          className="fm-icon-button"
          aria-label="添加演示核心词"
          disabled={keywords.length >= 10}
          onClick={() => {
            setKeywords((current) => [
              ...current,
              { id: nextId, value: "", enabled: true },
            ]);
            setNextId((value) => value + 1);
          }}
        >
          <Plus size={14} />
        </button>
      </header>
      <div className="fm-demo-keyword-list">
        {keywords.map((keyword, index) => (
          <div className="fm-demo-keyword" key={keyword.id}>
            <button
              type="button"
              role="switch"
              aria-checked={keyword.enabled}
              aria-label={`启用演示核心词 ${index + 1}`}
              onClick={() =>
                setKeywords((current) =>
                  current.map((item) =>
                    item.id === keyword.id
                      ? { ...item, enabled: !item.enabled }
                      : item,
                  ),
                )
              }
            >
              <i />
            </button>
            <input
              aria-label={`演示核心词 ${index + 1}`}
              placeholder="输入核心词"
              value={keyword.value}
              maxLength={60}
              disabled={!keyword.enabled}
              onChange={(event) =>
                setKeywords((current) =>
                  current.map((item) =>
                    item.id === keyword.id
                      ? { ...item, value: event.target.value }
                      : item,
                  ),
                )
              }
            />
            <button
              type="button"
              aria-label={`删除演示核心词 ${index + 1}`}
              onClick={() =>
                setKeywords((current) =>
                  current.filter((item) => item.id !== keyword.id),
                )
              }
            >
              <Trash2 size={12} />
            </button>
          </div>
        ))}
      </div>
      <p>仅保留于本次演示表单，不改变问题、执行次数或统计。</p>
    </aside>
  );
}

import { useEffect, useMemo, useState } from "react";
import { Check, Pencil, Search, UsersRound } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type ManagerAssignmentOption = {
  id: number;
  label: string;
  secondary?: string | null;
  accessLevel?: "system_admin" | "delivery_admin" | null;
};

type ManagerAssignmentEditorProps = {
  options: ManagerAssignmentOption[];
  selectedIds: number[];
  usageOwnerId?: number | null;
  editable: boolean;
  saving?: boolean;
  onSave: (
    selectedIds: number[],
    usageOwnerId?: number | null,
  ) => void | Promise<void>;
};

function normalizedIds(ids: number[]) {
  return [...new Set(ids)].sort((left, right) => left - right);
}

function sameIds(left: number[], right: number[]) {
  const normalizedLeft = normalizedIds(left);
  const normalizedRight = normalizedIds(right);
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((id, index) => id === normalizedRight[index])
  );
}

export default function ManagerAssignmentEditor({
  options,
  selectedIds,
  usageOwnerId = null,
  editable,
  saving = false,
  onSave,
}: ManagerAssignmentEditorProps) {
  const [editing, setEditing] = useState(false);
  const [query, setQuery] = useState("");
  const [draftIds, setDraftIds] = useState<number[]>(() =>
    normalizedIds(selectedIds),
  );
  const [draftUsageOwnerId, setDraftUsageOwnerId] = useState<number | null>(
    usageOwnerId,
  );
  const selectedKey = normalizedIds(selectedIds).join(",");

  useEffect(() => {
    if (!editing) {
      setDraftIds(normalizedIds(selectedIds));
      setDraftUsageOwnerId(usageOwnerId);
    }
  }, [editing, selectedKey, usageOwnerId]);

  const selectedOptions = useMemo(() => {
    const selected = new Set(selectedIds);
    return options.filter((option) => selected.has(option.id));
  }, [options, selectedIds]);

  const filteredOptions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return options;
    return options.filter((option) =>
      `${option.label} ${option.secondary ?? ""}`
        .toLocaleLowerCase()
        .includes(normalizedQuery),
    );
  }, [options, query]);

  const cancelEditing = () => {
    setDraftIds(normalizedIds(selectedIds));
    setDraftUsageOwnerId(usageOwnerId);
    setQuery("");
    setEditing(false);
  };

  const saveAssignments = async () => {
    try {
      await onSave(normalizedIds(draftIds), draftUsageOwnerId);
      setQuery("");
      setEditing(false);
    } catch {
      // The owning workspace reports the service error and keeps the draft open.
    }
  };
  const selectedOwnerOptions = options.filter(
    (option) =>
      draftIds.includes(option.id) &&
      (option.accessLevel === "system_admin" ||
        option.accessLevel === "delivery_admin"),
  );
  const hasValidUsageOwner =
    draftUsageOwnerId != null &&
    selectedOwnerOptions.some((option) => option.id === draftUsageOwnerId);
  const ownerChanged = (usageOwnerId ?? null) !== draftUsageOwnerId;

  return (
    <section
      className="min-w-0 w-full rounded-2xl border border-[#e6ddea] bg-[#fbf9fd] p-4"
      aria-label="负责管理员分配"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <UsersRound className="h-4 w-4 text-[#5b2a86]" />
            <h3 className="text-sm font-semibold text-[#332842]">负责管理员</h3>
            <span className="rounded-full bg-[#eee6f3] px-2 py-0.5 text-xs font-semibold text-[#5b2a86]">
              已选 {selectedIds.length} 位
            </span>
          </div>
          <p className="mt-1 text-xs text-[#8d8499]">
            {editable
              ? "支持搜索并批量调整，多位管理员可共同负责同一客户。"
              : "当前仅可查看负责关系；只有系统管理员可以调整。"}
          </p>
        </div>

        {editable && !editing && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="shrink-0"
            onClick={() => setEditing(true)}
          >
            <Pencil className="h-3.5 w-3.5" />
            编辑分配
          </Button>
        )}
      </div>

      {!editing ? (
        <div className="mt-3 flex min-h-9 flex-wrap items-center gap-2">
          {selectedOptions.length > 0 ? (
            <>
              {selectedOptions.slice(0, 4).map((option) => (
                <span
                  key={option.id}
                  className="inline-flex max-w-[180px] items-center gap-1.5 rounded-lg border border-[#ddd1e5] bg-white px-2.5 py-1.5 text-xs text-[#51465d]"
                >
                  <Check className="h-3.5 w-3.5 shrink-0 text-[#5b2a86]" />
                  <span className="truncate">{option.label}</span>
                  {option.id === usageOwnerId && (
                    <span className="shrink-0 font-semibold text-[#5b2a86]">
                      · 主负责人
                    </span>
                  )}
                </span>
              ))}
              {selectedOptions.length > 4 && (
                <span className="text-xs font-medium text-[#716a80]">
                  另有 {selectedOptions.length - 4} 位
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-[#9a94a8]">暂未分配负责管理员</span>
          )}
        </div>
      ) : (
        <div className="mt-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9a94a8]" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索管理员姓名或账号"
              aria-label="搜索负责管理员"
              className="bg-white pl-9"
              autoFocus
            />
          </div>

          <div
            className="custom-scrollbar mt-3 max-h-56 overflow-y-auto rounded-xl border border-[#e3d9e8] bg-white p-1.5"
            role="group"
            aria-label="管理员候选列表"
          >
            {filteredOptions.length > 0 ? (
              filteredOptions.map((option) => {
                const checked = draftIds.includes(option.id);
                return (
                  <label
                    key={option.id}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 transition hover:bg-[#f7f2fa]"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={saving}
                      onChange={(event) =>
                        setDraftIds((current) => {
                          const next = event.target.checked
                            ? normalizedIds([...current, option.id])
                            : current.filter((id) => id !== option.id);
                          if (
                            !event.target.checked &&
                            draftUsageOwnerId === option.id
                          ) {
                            setDraftUsageOwnerId(null);
                          }
                          if (
                            event.target.checked &&
                            (option.accessLevel === "system_admin" ||
                              option.accessLevel === "delivery_admin") &&
                            !hasValidUsageOwner
                          ) {
                            setDraftUsageOwnerId(option.id);
                          }
                          return next;
                        })
                      }
                      aria-label={option.label}
                      className="h-4 w-4 shrink-0 accent-[#5b2a86]"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[#332842]">
                        {option.label}
                      </span>
                      {option.secondary && (
                        <span className="mt-0.5 block truncate text-xs text-[#9a94a8]">
                          {option.secondary}
                        </span>
                      )}
                    </span>
                    {checked && (
                      <span className="shrink-0 text-xs font-semibold text-[#5b2a86]">
                        已选择
                      </span>
                    )}
                  </label>
                );
              })
            ) : (
              <p className="px-3 py-8 text-center text-sm text-[#8d8499]">
                未找到匹配的管理员
              </p>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-[#e3d9e8] bg-white p-3">
            <label
              htmlFor="usage-owner-admin"
              className="text-xs font-semibold text-[#51465d]"
            >
              主负责人
            </label>
            <select
              id="usage-owner-admin"
              value={draftUsageOwnerId ?? ""}
              disabled={saving || selectedOwnerOptions.length === 0}
              onChange={(event) =>
                setDraftUsageOwnerId(
                  event.target.value ? Number(event.target.value) : null,
                )
              }
              className="mt-2 h-10 w-full rounded-lg border border-[#ddd3e4] bg-white px-3 text-sm text-[#484057]"
            >
              <option value="">请选择一位管理员</option>
              {selectedOwnerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs leading-5 text-[#8d8499]">
              主负责人可以选择 Admin 或交付管理员。
            </p>
          </div>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-[#716a80]">
              本次已选择{" "}
              <strong className="text-[#5b2a86]">{draftIds.length}</strong>{" "}
              位管理员
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={saving}
                onClick={cancelEditing}
              >
                取消
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={
                  saving ||
                  (draftIds.length > 0 && !hasValidUsageOwner) ||
                  (sameIds(draftIds, selectedIds) && !ownerChanged)
                }
                onClick={() => void saveAssignments()}
              >
                {saving ? "保存中…" : "保存分配"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

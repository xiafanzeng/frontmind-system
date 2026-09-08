import { useOperatorPortalClassName } from "@/components/ui/operator-theme";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import * as Select from "@radix-ui/react-select";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  X,
} from "lucide-react";
import { DayPicker, type DateRange } from "react-day-picker";
import { zhCN } from "date-fns/locale";
import { format, parseISO } from "date-fns";
import { toast } from "sonner";

export type AnalyticsModule =
  | "overview"
  | "articles"
  | "ai-qa"
  | "traffic-sources";
export type SettingsTab = "basic" | "leads";
export type PreviewModule =
  | AnalyticsModule
  | "settings"
  | "collection"
  | "leads";
export type Period = { from: string; to: string; unit: "day" | "month" };
export const INITIAL_PERIOD: Period = {
  from: "2026-08-07",
  to: "2026-09-06",
  unit: "day",
};

export function HlButton({
  variant = "default",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "plain" | "link" | "danger";
}) {
  return (
    <button
      type="button"
      className={`hl-button hl-button--${variant} ${className}`}
      {...props}
    />
  );
}

export function HlSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: string;
  options: readonly (string | { value: string; label: string })[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const portalTheme = useOperatorPortalClassName() || "";
  return (
    <Select.Root value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger className="hl-select" aria-label={label}>
        <Select.Value />
        <Select.Icon>
          <ChevronDown size={14} />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className={`hl-portal hl-select-options ${portalTheme}`}
          position="popper"
          sideOffset={6}
        >
          <Select.Viewport>
            {options.map((option) => {
              const item =
                typeof option === "string"
                  ? { value: option, label: option }
                  : option;
              return (
                <Select.Item
                  className="hl-select-option"
                  key={item.value}
                  value={item.value}
                >
                  <Select.ItemText>{item.label}</Select.ItemText>
                  <Select.ItemIndicator>
                    <Check size={14} />
                  </Select.ItemIndicator>
                </Select.Item>
              );
            })}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

export function HlField({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="hl-field">
      <span className="hl-label">{label}</span>
      {hint && <span className="hl-hint">{hint}</span>}
      {children}
    </div>
  );
}

export function HlDialog({
  title,
  open,
  onOpenChange,
  children,
  footer,
  wide = false,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const portalTheme = useOperatorPortalClassName() || "";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={`hl-portal hl-overlay ${portalTheme}`} />
        <Dialog.Content
          aria-describedby={undefined}
          className={`hl-portal hl-dialog${wide ? " hl-dialog--wide" : ""} ${portalTheme}`}
        >
          <div className="hl-dialog-head">
            <Dialog.Title>{title}</Dialog.Title>
            <Dialog.Close className="hl-icon-button" aria-label="关闭">
              <X size={20} />
            </Dialog.Close>
          </div>
          <div className="hl-dialog-body">{children}</div>
          {footer && <div className="hl-dialog-footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function PeriodControl({
  value,
  onChange,
}: {
  value: Period;
  onChange: (period: Period) => void;
}) {
  const portalTheme = useOperatorPortalClassName() || "";
  const [open, setOpen] = useState(false);
  const range: DateRange = {
    from: parseISO(value.from),
    to: parseISO(value.to),
  };
  return (
    <div className="hl-period">
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger className="hl-date-trigger" aria-label="日期范围">
          <CalendarDays size={15} />
          <span>{value.from}</span>
          <span>－</span>
          <span>{value.to}</span>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            className={`hl-portal hl-calendar ${portalTheme}`}
            sideOffset={8}
            align="end"
          >
            <div className="hl-calendar-shortcuts">
              {[7, 30].map((days) => (
                <HlButton
                  key={days}
                  variant="link"
                  onClick={() => {
                    const from = new Date(2026, 8, 6);
                    from.setDate(from.getDate() - days + 1);
                    onChange({
                      ...value,
                      from: format(from, "yyyy-MM-dd"),
                      to: "2026-09-06",
                    });
                    setOpen(false);
                  }}
                >
                  最近{days}天
                </HlButton>
              ))}
            </div>
            <DayPicker
              locale={zhCN}
              mode="range"
              numberOfMonths={2}
              defaultMonth={range.from}
              selected={range}
              onSelect={(selection) => {
                if (selection?.from)
                  onChange({
                    ...value,
                    from: format(selection.from, "yyyy-MM-dd"),
                    to: format(selection.to || selection.from, "yyyy-MM-dd"),
                  });
              }}
            />
            <div className="hl-calendar-footer">
              <HlButton variant="primary" onClick={() => setOpen(false)}>
                确定
              </HlButton>
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <div className="hl-segmented" aria-label="统计粒度">
        {(
          [
            ["day", "日"],
            ["month", "月"],
          ] as const
        ).map(([unit, label]) => (
          <button
            type="button"
            key={unit}
            aria-pressed={value.unit === unit}
            onClick={() => onChange({ ...value, unit })}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Pagination({
  total,
  page,
  size,
  onPage,
  onSize,
}: {
  total: number;
  page: number;
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const safePage = Math.min(pages, Math.max(1, page));
  return (
    <div className="hl-pagination">
      <span>共 {total} 条</span>
      <HlSelect
        label="每页条数"
        value={String(size)}
        options={[10, 20, 50, 100].map((n) => ({
          value: String(n),
          label: `${n}条/页`,
        }))}
        onChange={(v) => {
          onSize(Number(v));
          onPage(1);
        }}
      />
      <button
        type="button"
        aria-label="上一页"
        disabled={safePage === 1}
        onClick={() => onPage(safePage - 1)}
      >
        <ChevronLeft size={14} />
      </button>
      {Array.from(
        { length: Math.min(5, pages) },
        (_, n) => n + Math.max(1, Math.min(safePage - 2, pages - 4)),
      ).map((n) => (
        <button
          type="button"
          key={n}
          aria-label={`第 ${n} 页`}
          aria-current={safePage === n ? "page" : undefined}
          onClick={() => onPage(n)}
        >
          {n}
        </button>
      ))}
      <button
        type="button"
        aria-label="下一页"
        disabled={safePage === pages}
        onClick={() => onPage(safePage + 1)}
      >
        <ChevronRight size={14} />
      </button>
      <span>前往</span>
      <input
        aria-label="页"
        type="number"
        min={1}
        max={pages}
        value={safePage}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onPage(Math.min(pages, Math.max(1, n)));
        }}
      />
      <span>页</span>
    </div>
  );
}

export function downloadCsv(
  filename: string,
  columns: string[],
  rows: unknown[][],
) {
  const escape = (value: unknown) => {
    let text = String(value ?? "");
    if (/^[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replaceAll('"', '""')}"`;
  };
  const blob = new Blob(
    [
      "\uFEFF",
      [columns, ...rows].map((row) => row.map(escape).join(",")).join("\r\n"),
    ],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast.success("本地演示数据已导出");
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success("已复制");
  } catch {
    toast.error("复制失败，请手动选择并复制文本");
  }
}

export function ExportMenu({
  selectedCount,
  onExport,
}: {
  selectedCount: number;
  onExport: (selectedOnly: boolean) => void;
}) {
  const portalTheme = useOperatorPortalClassName() || "";
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <HlButton variant="primary">
          <Download size={14} />
          导出
          <ChevronDown size={13} />
        </HlButton>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className={`hl-portal hl-export-menu ${portalTheme}`} sideOffset={5}>
          <button
            type="button"
            disabled={!selectedCount}
            onClick={() => {
              onExport(true);
              setOpen(false);
            }}
          >
            导出选中数据
          </button>
          <button
            type="button"
            onClick={() => {
              onExport(false);
              setOpen(false);
            }}
          >
            导出全部
          </button>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

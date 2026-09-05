import type { CSSProperties } from "react";
import { useTheme } from "next-themes";
import { Toaster as Sonner, type ToasterProps } from "sonner";

const premiumToastClass = [
  "group/toast relative w-[min(92vw,420px)] overflow-hidden rounded-2xl",
  "border border-border/70 bg-popover/95 px-4 py-3.5 text-foreground",
  "shadow-[0_22px_70px_oklch(0.205_0.012_255_/_0.11),0_3px_12px_oklch(0.205_0.012_255_/_0.06),inset_0_1px_0_oklch(1_0_0_/_0.62)]",
  "backdrop-blur-2xl backdrop-saturate-150",
  "before:absolute before:inset-y-3 before:left-0 before:w-1 before:rounded-r-full before:bg-primary/75",
  "data-[type=success]:before:bg-primary data-[type=error]:before:bg-destructive data-[type=warning]:before:bg-accent",
].join(" ");

const Toaster = ({ toastOptions, ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme();

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        classNames: {
          toast: premiumToastClass,
          title: "text-[13px] font-semibold tracking-[-0.01em] text-foreground",
          description: "mt-1 text-[12px] leading-relaxed text-muted-foreground",
          icon: "text-primary",
          closeButton:
            "border-border/60 bg-background/85 text-muted-foreground shadow-sm backdrop-blur hover:bg-secondary hover:text-foreground",
          ...toastOptions?.classNames,
        },
      }}
      {...props}
    />
  );
};

export { Toaster };

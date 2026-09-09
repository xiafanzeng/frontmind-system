/** Animated, text-first loading indicator used while an assistant response starts. */
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface TypingIndicatorProps {
  className?: string;
  showText?: boolean;
  text?: string;
  variant?: "default" | "minimal";
}

function Dots({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn("inline-flex items-center", compact ? "gap-1" : "gap-1.5")}
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className={cn(
            "rounded-full bg-muted-foreground/60",
            compact ? "h-1.5 w-1.5" : "h-1.5 w-1.5",
          )}
          animate={{ opacity: [0.35, 1, 0.35] }}
          transition={{
            duration: 1,
            repeat: Infinity,
            delay: i * 0.2,
            ease: "easeInOut",
          }}
        />
      ))}
    </span>
  );
}

export default function TypingIndicator({
  className,
  showText = true,
  text = "FrontMind AI 正在处理...",
  variant = "default",
}: TypingIndicatorProps) {
  if (variant === "minimal") {
    return (
      <span className={cn("inline-flex items-center", className)}>
        <Dots compact />
      </span>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "flex min-w-0 items-center gap-2 py-1 text-[13px] text-muted-foreground",
        className,
      )}
      role="status"
      aria-live="polite"
    >
      <Dots />
      {showText && <span className="truncate">{text}</span>}
    </motion.div>
  );
}

/** Simple animated dot for inline loading. */
export function PulsingDot({ className }: { className?: string }) {
  return (
    <motion.span
      className={cn("h-2 w-2 rounded-full bg-muted-foreground/60", className)}
      animate={{ opacity: [0.35, 1, 0.35] }}
      transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
      aria-hidden="true"
    />
  );
}

/** Loading placeholder for messages. */
export function SkeletonMessage({ className }: { className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={cn("flex min-w-0 items-start", className)}
    >
      <div className="flex-1 space-y-2">
        <div className="h-3.5 w-3/4 animate-pulse rounded bg-muted/50" />
        <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted/50" />
      </div>
    </motion.div>
  );
}

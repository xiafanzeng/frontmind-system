/**
 * TypingIndicator Component - Animated typing dots for loading states
 */
import { motion } from "framer-motion";
import { Sparkles, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

interface TypingIndicatorProps {
  className?: string;
  showText?: boolean;
  text?: string;
  variant?: "default" | "minimal";
}

export default function TypingIndicator({
  className,
  showText = true,
  text = "FrontMind AI 正在处理...",
  variant = "default",
}: TypingIndicatorProps) {
  const dots = [0, 1, 2];

  if (variant === "minimal") {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        {dots.map((i) => (
          <motion.span
            key={i}
            className="w-1.5 h-1.5 rounded-full bg-primary/60"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{
              duration: 1,
              repeat: Infinity,
              delay: i * 0.2,
              ease: "easeInOut",
            }}
          />
        ))}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn("flex items-start gap-3", className)}
    >
      <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center flex-shrink-0">
        <Bot className="w-4 h-4 text-primary" />
      </div>
      <div className="glass-card rounded-2xl rounded-tl-sm px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            {dots.map((i) => (
              <motion.span
                key={i}
                className="w-2 h-2 rounded-full bg-primary/60"
                animate={{ opacity: [0.4, 1, 0.4] }}
                transition={{
                  duration: 1,
                  repeat: Infinity,
                  delay: i * 0.2,
                  ease: "easeInOut",
                }}
              />
            ))}
          </div>
          {showText && (
            <span className="text-xs text-muted-foreground ml-1">
              <Sparkles className="w-3 h-3 inline mr-1 text-primary/50" />
              {text}
            </span>
          )}
        </div>
      </div>
    </motion.div>
  );
}

/**
 * PulsingDot - Simple animated dot for inline loading
 */
export function PulsingDot({ className }: { className?: string }) {
  return (
    <motion.span
      className={cn("w-2 h-2 rounded-full bg-primary/60", className)}
      animate={{ opacity: [0.4, 1, 0.4] }}
      transition={{
        duration: 1.2,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    />
  );
}

/**
 * SkeletonMessage - Loading placeholder for messages
 */
export function SkeletonMessage({ className }: { className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className={cn("flex items-start gap-3", className)}
    >
      <div className="w-8 h-8 rounded-full bg-muted animate-pulse flex-shrink-0" />
      <div className="flex-1 space-y-2">
        <div className="h-4 bg-muted/50 rounded w-3/4 animate-pulse" />
        <div className="h-4 bg-muted/50 rounded w-1/2 animate-pulse" />
      </div>
    </motion.div>
  );
}

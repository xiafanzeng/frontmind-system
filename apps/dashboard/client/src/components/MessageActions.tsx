/**
 * MessageActions Component - Context menu for messages
 * Features: Copy text, copy code, delete message, regenerate
 */
import React from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Copy,
  Clipboard,
  Trash2,
  RefreshCw,
  Check,
} from "lucide-react";
import { cn, copyToClipboard } from "@/lib/utils";
import type { LocalMessage } from "@/contexts/ConversationContext";
import { toast } from "sonner";

interface MessageActionsProps {
  message: LocalMessage;
  onDelete?: () => void;
  onRegenerate?: () => void;
  children: React.ReactNode;
  className?: string;
}

export default function MessageActions({
  message,
  onDelete,
  onRegenerate,
  children,
  className,
}: MessageActionsProps) {
  const [copied, setCopied] = React.useState(false);

  const handleCopyText = () => {
    if (!message.content) return;
    void copyToClipboard(message.content).then((ok) => {
      if (ok) {
        setCopied(true);
        toast.success("已复制到剪贴板");
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error("复制失败");
      }
    });
  };

  const handleCopyCode = () => {
    if (!message.content) return;
    const codeMatch = message.content.match(/```[\s\S]*?```/g);
    const code = codeMatch ? codeMatch.join("\n\n") : message.content;
    void copyToClipboard(code).then((ok) => {
      if (ok) {
        setCopied(true);
        toast.success("代码已复制");
        setTimeout(() => setCopied(false), 2000);
      } else {
        toast.error("复制失败");
      }
    });
  };

  const handleDelete = () => {
    if (onDelete) {
      onDelete();
      toast.success("消息已删除");
    }
  };

  const handleRegenerate = () => {
    if (onRegenerate) {
      onRegenerate();
      toast.info("正在重新生成...");
    }
  };

  const hasContent = !!message.content;
  const hasCode = message.content?.includes("```");

  return (
    <ContextMenu>
      <ContextMenuTrigger className={cn("outline-none", className)} asChild>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-[160px]">
        {hasContent && (
          <>
            <ContextMenuItem onClick={handleCopyText}>
              {copied ? (
                <>
                  <Check className="w-4 h-4 text-green-500" />
                  已复制
                </>
              ) : (
                <>
                  <Copy className="w-4 h-4" />
                  复制文本
                </>
              )}
            </ContextMenuItem>
            {hasCode && (
              <ContextMenuItem onClick={handleCopyCode}>
                <Clipboard className="w-4 h-4" />
                复制代码
              </ContextMenuItem>
            )}
          </>
        )}

        {hasContent && (hasCode || onDelete || onRegenerate) && (
          <ContextMenuSeparator />
        )}

        {onRegenerate && message.role === "assistant" && (
          <ContextMenuItem onClick={handleRegenerate}>
            <RefreshCw className="w-4 h-4" />
            重新生成
          </ContextMenuItem>
        )}

        {onDelete && (
          <ContextMenuItem
            onClick={handleDelete}
            variant="destructive"
          >
            <Trash2 className="w-4 h-4" />
            删除消息
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

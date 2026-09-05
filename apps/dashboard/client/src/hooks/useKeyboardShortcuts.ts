/**
 * useKeyboardShortcuts Hook - Global keyboard shortcuts
 * Features: Cmd/Ctrl+Enter to send, Escape to stop, etc.
 */
import { useEffect, useCallback } from "react";

interface KeyboardShortcuts {
  onSend?: () => void;
  onStop?: () => void;
  onNewChat?: () => void;
  onSettings?: () => void;
  onToggleSidebar?: () => void;
}

export function useKeyboardShortcuts(callbacks: KeyboardShortcuts) {
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      const modifier = isMac ? e.metaKey : e.ctrlKey;

      // Cmd/Ctrl + Enter: Send message
      if (modifier && e.key === "Enter" && callbacks.onSend) {
        e.preventDefault();
        callbacks.onSend();
      }

      // Escape: Stop current operation
      if (e.key === "Escape" && callbacks.onStop) {
        e.preventDefault();
        callbacks.onStop();
      }

      // Cmd/Ctrl + N: New chat
      if (modifier && e.key === "n" && callbacks.onNewChat) {
        e.preventDefault();
        callbacks.onNewChat();
      }

      // Cmd/Ctrl + ,: Settings
      if (modifier && e.key === "," && callbacks.onSettings) {
        e.preventDefault();
        callbacks.onSettings();
      }

      // Cmd/Ctrl + \: Toggle sidebar
      if (modifier && e.key === "\\" && callbacks.onToggleSidebar) {
        e.preventDefault();
        callbacks.onToggleSidebar();
      }
    },
    [callbacks]
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [handleKeyDown]);
}

// Shortcut hints for display
export const KEYBOARD_SHORTCUTS = [
  { keys: ["Cmd", "N"], description: "新内容流程" },
  { keys: ["Cmd", "Enter"], description: "发送消息" },
  { keys: ["Esc"], description: "停止操作" },
  { keys: ["Cmd", ","], description: "设置" },
];

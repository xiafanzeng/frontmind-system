import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Copy text to the system clipboard. Prefers the Async Clipboard API in secure
 * contexts; falls back to a hidden textarea + document.execCommand("copy") when
 * the API is missing, denied, or the page is served over plain HTTP.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof document === "undefined") return false;
  const value = text ?? "";
  if (value === "") return false;

  const canUseAsyncClipboard =
    typeof navigator !== "undefined" &&
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof navigator.clipboard?.writeText === "function";

  if (canUseAsyncClipboard) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Permission denied or transient failure — try legacy path
    }
  }

  return copyToClipboardLegacy(value);
}

function copyToClipboardLegacy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.left = "0";
  ta.style.top = "0";
  ta.style.width = "1px";
  ta.style.height = "1px";
  ta.style.padding = "0";
  ta.style.margin = "0";
  ta.style.border = "none";
  ta.style.outline = "none";
  ta.style.boxShadow = "none";
  ta.style.background = "transparent";
  ta.style.opacity = "0";
  ta.style.overflow = "hidden";
  ta.style.whiteSpace = "pre";
  document.body.appendChild(ta);
  ta.focus();
  let ok = false;
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    document.body.removeChild(ta);
  }
  return ok;
}

import type { SiteOpsMessageProjection } from "@shared/siteops-contract";
const ongoing = new Set([
  "queued",
  "running",
  "preparing",
  "building",
  "deploying",
  "verifying",
  "visual_searching",
  "design_compiling",
  "content_building",
  "qa_running",
]);
export function siteOpsFinalReplyIds(
  messages: readonly SiteOpsMessageProjection[],
  running: boolean,
) {
  const ids = new Set<string>();
  let candidate: string | undefined;
  let lastWasProgress = false;
  for (const message of [...messages].sort((a, b) => a.sequence - b.sequence)) {
    if (message.role === "user") {
      if (candidate && !lastWasProgress) ids.add(candidate);
      candidate = undefined;
      lastWasProgress = false;
      continue;
    }
    if (message.role !== "assistant") continue;
    const card = message.metadata?.siteOps;
    lastWasProgress =
      card?.kind === "build_progress" ||
      ongoing.has(
        String(
          card?.payload.operationStatus ??
          card?.payload.status ??
            card?.payload.stage ??
            card?.payload.phase ??
            "",
        ),
      );
    if (!lastWasProgress && message.content.trim()) candidate = message.id;
  }
  if (candidate && !lastWasProgress && !running) ids.add(candidate);
  return ids;
}

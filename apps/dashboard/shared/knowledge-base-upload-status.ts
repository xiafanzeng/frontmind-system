export type KnowledgeBaseBrowserUpload = {
  connection: "active" | "stalled" | "disconnected" | "cancelled";
  uploadedBytes: number;
  lastActivity: number;
};

/** Only connection evidence is public; this never implies a model has started. */
export function knowledgeBaseBrowserUpload(value: unknown, now = Date.now()): KnowledgeBaseBrowserUpload | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.lastHeartbeatAt !== "number" || typeof row.lastProgressAt !== "number" || typeof row.uploadedBytes !== "number") return undefined;
  return {
    connection: row.status === "cancelled" ? "cancelled" : now - row.lastHeartbeatAt >= 60_000 ? "disconnected" : now - row.lastProgressAt >= 30_000 ? "stalled" : "active",
    uploadedBytes: Math.max(0, row.uploadedBytes),
    lastActivity: row.lastHeartbeatAt,
  };
}

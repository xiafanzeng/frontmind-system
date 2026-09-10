import { createHash } from "node:crypto";

declare const operationBrand: unique symbol;
export type ServerOperationId = string & { readonly [operationBrand]: true };

export function canonicalOperationValue(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalOperationValue).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalOperationValue(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
export function workspaceRequestDigest(value: unknown) {
  return createHash("sha256")
    .update(canonicalOperationValue(value))
    .digest("hex");
}
export function serverOperationId(value: unknown): ServerOperationId {
  const digest = workspaceRequestDigest(value);
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-8${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}` as ServerOperationId;
}
export function workspaceOperationAuditId(
  action: string,
  operationId: ServerOperationId,
) {
  return serverOperationId({
    namespace: "workspace-success-audit:v1",
    action,
    operationId,
  });
}

import { z } from "zod";

/** Query support is required for images and ordinary download anchors. */
export function requestEnterpriseProjectId(request: { headers?: Record<string, unknown>; query?: Record<string, unknown> } = {}): string | null {
  const header = request.headers?.["x-enterprise-project-id"];
  const query = request.query?.enterpriseProjectId;
  if (header === undefined && query === undefined) return null;
  const parse = (value: unknown) => z.string().uuid().parse(value);
  const headerId = header === undefined ? null : parse(header);
  const queryId = query === undefined ? null : parse(query);
  if (headerId && queryId && headerId !== queryId) throw new Error("ENTERPRISE_PROJECT_SCOPE_CONFLICT");
  return headerId ?? queryId;
}

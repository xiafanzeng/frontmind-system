export const DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY =
  "frontmind.delivery.projectAssignmentId";

export function deliveryProjectHeaders(
  headers: Record<string, string> = {},
): Record<string, string> {
  const projectAssignmentId = sessionStorage
    .getItem(DELIVERY_PROJECT_ASSIGNMENT_STORAGE_KEY)
    ?.trim();
  return {
    ...headers,
    ...(projectAssignmentId
      ? { "x-delivery-project-assignment-id": projectAssignmentId }
      : {}),
  };
}

export const ADMIN_WORKSPACE_TAB_IDS = ["service", "tickets"] as const;

export type WorkspaceTab = (typeof ADMIN_WORKSPACE_TAB_IDS)[number];

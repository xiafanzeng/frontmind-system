import { AsyncLocalStorage } from "node:async_hooks";

/** Request/operation scope. This never replaces the authenticated account. */
export type EnterpriseProjectScope = Readonly<{
  enterpriseProjectId: string;
  ownerUserId: number;
  actorUserId: number;
  isLegacyDefault: boolean;
}>;

const storage = new AsyncLocalStorage<EnterpriseProjectScope | undefined>();

export function getEnterpriseProjectScope() {
  return storage.getStore();
}

export function runWithEnterpriseProjectScope<T>(
  scope: EnterpriseProjectScope,
  action: () => T,
): T {
  return storage.run(Object.freeze({ ...scope }), action);
}

export function currentEnterpriseProjectId(): string | null {
  return storage.getStore()?.enterpriseProjectId ?? null;
}

export function enterpriseWorkspaceUserId(actorUserId: number): number {
  return getEnterpriseProjectScope()?.ownerUserId ?? actorUserId;
}

export function runWithoutEnterpriseProjectScope<T>(action: () => T): T { return storage.run(undefined, action); }

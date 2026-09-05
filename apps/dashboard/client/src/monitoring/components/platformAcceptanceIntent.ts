const uuidPattern =
  "[a-f\\d]{8}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{4}-[a-f\\d]{12}";

export function acceptanceIntentKey(
  fingerprint: string,
  previousBatchId?: string,
) {
  return `platform-acceptance:${fingerprint}${previousBatchId ? `:after:${previousBatchId}` : ""}`;
}
function storageKey(ownerId: string, fingerprint: string) {
  return `frontmind:platform-acceptance:${ownerId}:${fingerprint}`;
}
export function restoreAcceptanceIntent(ownerId: string, fingerprint: string) {
  const initial = acceptanceIntentKey(fingerprint);
  try {
    const stored = sessionStorage.getItem(storageKey(ownerId, fingerprint));
    return stored &&
      new RegExp(`^${initial}(?::after:${uuidPattern})?$`, "u").test(stored)
      ? stored
      : initial;
  } catch {
    return initial;
  }
}
export function saveAcceptanceIntent(
  ownerId: string,
  fingerprint: string,
  key: string,
) {
  try {
    sessionStorage.setItem(storageKey(ownerId, fingerprint), key);
    if (sessionStorage.getItem(storageKey(ownerId, fingerprint)) !== key)
      throw new Error();
  } catch {
    throw new Error("无法保存本轮验收，请恢复浏览器会话存储后重试。");
  }
}

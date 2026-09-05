declare const __FRONTMIND_BUILD_VERSION__: string;

export type FrontMindBuildInfo = {
  version: string;
  gitSha?: string;
  builtAt?: string;
  copyRevision?: string;
};

const initialVersion = __FRONTMIND_BUILD_VERSION__;
const PENDING_BUILD_DRAFT_KEY = "frontmind.pending-build-draft";
export const FRONTMIND_BUILD_VERSION_CHECK_MAX_WAIT_MS = 500;
const FRONTMIND_BUILD_VERSION_CHECK_CACHE_MS = 30_000;
let reloadStarted = false;
let lastCurrentVersionCheckAt = 0;

const BUILD_VERSION_CHECK_TIMED_OUT = Symbol("build-version-check-timed-out");

export async function checkFrontMindBuildVersion(options?: {
  reloadOnMismatch?: boolean;
  pendingDraft?: string;
  maxWaitMs?: number;
}) {
  if (
    lastCurrentVersionCheckAt > 0 &&
    Date.now() - lastCurrentVersionCheckAt <
      FRONTMIND_BUILD_VERSION_CHECK_CACHE_MS
  ) {
    return true;
  }

  const controller = new AbortController();
  const maxWaitMs = Math.max(
    0,
    options?.maxWaitMs ?? FRONTMIND_BUILD_VERSION_CHECK_MAX_WAIT_MS,
  );
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    // This cache-busting request is a UX freshness hint, not an authority
    // check. Never let a stalled CDN/version endpoint delay a user action.
    const responsePromise = (async () => {
      const response = await fetch(
        `/__frontmind__/version.json?_t=${Date.now()}`,
        { cache: "no-store", signal: controller.signal },
      );
      if (!response.ok) return null;
      return (await response.json()) as Partial<FrontMindBuildInfo>;
    })();
    const data = await Promise.race([
      responsePromise,
      new Promise<typeof BUILD_VERSION_CHECK_TIMED_OUT>((resolve) => {
        timeoutId = setTimeout(() => {
          controller.abort();
          resolve(BUILD_VERSION_CHECK_TIMED_OUT);
        }, maxWaitMs);
      }),
    ]);
    if (data === BUILD_VERSION_CHECK_TIMED_OUT || data === null) return true;
    const version = typeof data.version === "string" ? data.version : null;
    if (!version || version === initialVersion) {
      lastCurrentVersionCheckAt = Date.now();
      return true;
    }
    if (options?.reloadOnMismatch !== false && !reloadStarted) {
      const pendingDraft = options?.pendingDraft;
      if (pendingDraft?.trim()) {
        sessionStorage.setItem(
          PENDING_BUILD_DRAFT_KEY,
          JSON.stringify({
            text: pendingDraft,
            savedAt: Date.now(),
          }),
        );
      }
      reloadStarted = true;
      console.info(
        `[VersionCheck] New version detected: ${version} (was ${initialVersion}). Reloading...`,
      );
      window.location.reload();
    }
    return false;
  } catch {
    return true;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function consumePendingFrontMindBuildDraft() {
  try {
    const raw = sessionStorage.getItem(PENDING_BUILD_DRAFT_KEY);
    sessionStorage.removeItem(PENDING_BUILD_DRAFT_KEY);
    if (!raw) return "";
    const value = JSON.parse(raw) as { text?: unknown; savedAt?: unknown };
    if (
      typeof value.text !== "string" ||
      typeof value.savedAt !== "number" ||
      Date.now() - value.savedAt > 30 * 60 * 1000
    ) {
      return "";
    }
    return value.text;
  } catch {
    return "";
  }
}

export async function requireCurrentFrontMindBuild(pendingDraft?: string) {
  return checkFrontMindBuildVersion({
    reloadOnMismatch: true,
    pendingDraft,
  });
}

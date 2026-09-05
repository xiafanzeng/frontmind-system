import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { launch as launchChrome } from "chrome-launcher";
import JSZip from "jszip";
import lighthouse from "lighthouse";
import { chromium, type Page } from "playwright";
import { z } from "zod";

import { siteBriefSchema, type SiteBrief } from "../../shared/siteops";
import {
  siteContentPlanV2Schema,
  type SiteContentPlanV2,
} from "../../shared/siteops-content-plan";
import { canonicalJson } from "../../shared/siteops-workflow";
import {
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
  NATIVE_SOURCE_MAX_FILES,
  NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH,
  type NativeRuntimeAudit,
  type ValidatedNativeReactSource,
} from "./native-react-source";
import { previewNavigationBridgeSource } from "./preview-routing";

const FIXED_ZIP_DATE = new Date("2000-01-01T00:00:00.000Z");
const MAX_BUILD_LOG_BYTES = 256 * 1024;
const MAX_DIST_BYTES = 30 * 1024 * 1024;
const MAX_DIST_FILES = 1_000;
const MAX_DIST_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_BUILD_TIMEOUT_MS = 90_000;
const MAX_BUILD_TIMEOUT_MS = 120_000;
const NATIVE_RENDERER = "twenty_first_native" as const;
const NATIVE_QA_POLICY = "siteops-native-hard-safety-v1" as const;
const SAFE_BUILD_ERROR_MARKER = "__FRONTMIND_NATIVE_BUILD_ERROR__";
const PINNED_SHADERS_REACT_BUNDLE_SHA256 =
  "ca34b0dbc19593b44b4dd017f2e763f8463b3b46383df769a41b1a5202400033";
const NATIVE_DOCUMENT_CSP =
  "default-src 'self'; img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'none'; worker-src 'none'; child-src 'none'; frame-src 'none'; object-src 'none'; media-src 'self' data:; manifest-src 'none'; base-uri 'self'; form-action 'none'";
const HOST_DEPENDENCY_ALLOWLIST = new Set<string>(
  NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
);

const buildCoordinatesSchema = z
  .object({
    id: z.string().uuid(),
    projectId: z.string().uuid(),
    knowledgeSnapshotId: z.string().max(191).nullable().optional(),
    workflowVersion: z.string().trim().min(1).max(64).nullable().optional(),
    selectionHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable()
      .optional(),
  })
  .strict();

export type NativeReactBuildCoordinates = z.infer<
  typeof buildCoordinatesSchema
>;

export type NativeReactBuildInput = {
  sourceZip: Buffer;
  validatedSource: ValidatedNativeReactSource;
  build: NativeReactBuildCoordinates;
  brief: SiteBrief | unknown;
  mode: "preview" | "production";
  canonicalOrigin?: string | null;
  target?: "global_excluding_cn" | "mainland_cn" | null;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** Tests and bounded smoke checks can omit Chromium without changing the
   * hard compile/static-safety decision. Omission is recorded as a warning. */
  browserQa?: boolean;
  lighthouseQa?: boolean;
  requiredUserMedia?: readonly {
    publicPath: string;
    contentSha256: string;
  }[];
  requiredKnowledgeMedia?: readonly {
    assetId: string;
    publicPath: string;
    contentSha256: string;
    routePaths: readonly string[];
  }[];
  /** The immutable information architecture and content contract for 2.9.
   * Its SHA is over `${canonicalJson(plan)}\n`, exactly matching the private
   * local-asset bytes persisted by the provider. */
  contentPlan?: SiteContentPlanV2 | unknown;
  contentPlanSha256?: string | null;
  /** V2 tasks must replay the auditor frozen with their receipt coordinates.
   * Direct V1 rebuilds retain the historical host-owned validation path. */
  runtimeAudit?: (input: {
    files: ReadonlyMap<string, Buffer>;
    expectedRoutePaths: readonly string[];
    requireCanonicalSitePathname?: boolean;
  }) => NativeRuntimeAudit;
};

export type NativeReactBuildWarning = {
  phase: "browser_qa" | "lighthouse";
  code: string;
  checkId: string;
};

export type NativeReactBuildDelivery = {
  renderMode: typeof NATIVE_RENDERER;
  qaStatus: "passed" | "passed_with_warnings";
  warningCodes: string[];
};

export type NativeReactBuildContractV1 = {
  schemaVersion: 1;
  contractKind: "twenty_first_native_build_contract";
  renderer: "twenty_first_native_react_v1";
  buildId: string;
  projectId: string;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  target: "global_excluding_cn" | "mainland_cn" | null;
  routes: string[];
  sourceSha256: string;
  distSha256: string;
  contentPlanSha256?: string;
  contentReceiptSha256?: string;
  contentReceipt?: NativeContentReceiptV1;
};

export type NativeContentReceiptV1 = {
  schemaVersion: 1;
  contentPlanSha256: string;
  routes: Array<{
    path: string;
    renderedTextSha256: string;
    sections: Array<{
      id: string;
      sourceDocumentIds: string[];
      mediaIds: string[];
      renderedTextSha256: string;
    }>;
  }>;
};

export type NativeContentPlanDomSnapshot = {
  path: string;
  pageText: string;
  mainText: string;
  h1Texts: string[];
  paragraphTexts: string[];
  links: Array<{
    text: string;
    pathname: string | null;
    protocol: string;
    sameOrigin: boolean;
    inGlobalNavigation: boolean;
  }>;
  sectionCandidates: Array<{
    id: string | null;
    text: string;
  }>;
};

export type NativeReactQaReportV1 = {
  schemaVersion: 1;
  policyVersion: typeof NATIVE_QA_POLICY;
  passed: true;
  mode: "preview" | "production";
  routes: string[];
  checks: Array<{ id: string; passed: true; detail: string }>;
  browser: {
    available: boolean;
    lighthouse: {
      performance: number | null;
      accessibility: number | null;
      bestPractices: number | null;
      seo: number | null;
      cls: number | null;
    };
    axeViolationCount: number;
    axeViolationIds: string[];
    screenshotFiles: string[];
  };
  buildDelivery: NativeReactBuildDelivery;
  warnings: NativeReactBuildWarning[];
  fileCount: number;
  totalBytes: number;
};

export type MaterializedNativeReactSite = {
  contract: NativeReactBuildContractV1;
  contractJson: Buffer;
  contractSha256: string;
  /** The exact validated Provider/Manus archive; it is never regenerated. */
  sourceZip: Buffer;
  sourceSha256: string;
  distZip: Buffer;
  distSha256: string;
  qaJson: Buffer;
  qaSha256: string;
  visualQaZip: Buffer;
  visualQaSha256: string;
  provenanceJson: Buffer;
  provenanceSha256: string;
  contentReceiptJson: Buffer | null;
  contentReceiptSha256: string | null;
  buildLog: Buffer;
  files: ReadonlyMap<string, Buffer>;
  buildDelivery: NativeReactBuildDelivery;
};

export type NativeReactBuildErrorCode =
  | "NATIVE_BUILD_INPUT_INVALID"
  | "NATIVE_BUILD_SOURCE_MISMATCH"
  | "NATIVE_BUILD_DEPENDENCY_UNAVAILABLE"
  | "NATIVE_BUILD_RUNTIME_AUDIT_UNAVAILABLE"
  | "NATIVE_BUILD_RUNTIME_UNAVAILABLE"
  | "NATIVE_BUILD_COMPILE_FAILED"
  | "NATIVE_BUILD_RENDER_FAILED"
  | "NATIVE_BUILD_TIMEOUT"
  | "NATIVE_BUILD_ABORTED"
  | "NATIVE_BUILD_LOG_LIMIT_EXCEEDED"
  | "NATIVE_BUILD_DIST_INVALID"
  | "NATIVE_BUILD_DIST_LIMIT_EXCEEDED"
  | "NATIVE_BUILD_ROUTE_MISSING"
  | "NATIVE_BUILD_LOCAL_ASSET_MISSING"
  | "NATIVE_BUILD_USER_MEDIA_INVALID"
  | "NATIVE_BUILD_CONTENT_PLAN_INVALID"
  | "NATIVE_BUILD_NETWORK_FORBIDDEN"
  | "NATIVE_BUILD_SECRET_FORBIDDEN";

export type NativeReactBuildDiagnostic = {
  code: string;
  file: string | null;
  line: number | null;
  column: number | null;
};

export class NativeReactBuildError extends Error {
  constructor(
    readonly code: NativeReactBuildErrorCode,
    readonly diagnostics: readonly NativeReactBuildDiagnostic[] = [],
  ) {
    super(code);
    this.name = "NativeReactBuildError";
  }
}

type OutputFile = { path: string; bytes: Buffer };

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonBuffer(value: unknown) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function assertNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new NativeReactBuildError("NATIVE_BUILD_ABORTED");
  }
}

function boundedTimeout(value: number | undefined) {
  if (!Number.isFinite(value)) return DEFAULT_BUILD_TIMEOUT_MS;
  return Math.min(Math.max(Math.trunc(value!), 5_000), MAX_BUILD_TIMEOUT_MS);
}

function validateCanonicalOrigin(
  mode: "preview" | "production",
  raw: string | null | undefined,
) {
  if (mode === "preview") {
    if (raw) throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
    return null;
  }
  if (!raw) throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.hostname === "localhost"
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  return parsed.origin;
}

function routePath(raw: string) {
  const trimmed = raw.trim();
  const withSlash =
    trimmed === "/" ? "/" : `/${trimmed.replace(/^\/+|\/+$/gu, "")}/`;
  const parts = withSlash.split("/").filter(Boolean);
  if (
    withSlash.includes("\\") ||
    withSlash.includes("%") ||
    withSlash.includes("?") ||
    withSlash.includes("#") ||
    withSlash.includes("\0") ||
    withSlash.normalize("NFKC") !== withSlash ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u.test(part),
    )
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}/`;
}

function normalizedRenderedText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function contentPlanDiagnostic(code: string, file: string | null = null) {
  return { code, file, line: null, column: null } as const;
}

function throwContentPlanInvalid(
  code: string,
  file: string | null = null,
): never {
  throw new NativeReactBuildError("NATIVE_BUILD_CONTENT_PLAN_INVALID", [
    contentPlanDiagnostic(code, file),
  ]);
}

function isWorkflowV29(workflowVersion: string | null | undefined) {
  return /^2\.9(?:\.|$)/u.test(workflowVersion ?? "");
}

function parseFrozenContentPlan(input: {
  contentPlan: unknown;
  contentPlanSha256: string | null | undefined;
  required: boolean;
  allowCoordinateOnly: boolean;
}) {
  if (input.contentPlan === undefined || input.contentPlan === null) {
    if (input.required) throwContentPlanInvalid("CONTENT_PLAN_REQUIRED");
    if (input.contentPlanSha256) {
      if (
        !input.allowCoordinateOnly ||
        !/^[a-f0-9]{64}$/u.test(input.contentPlanSha256)
      ) {
        throwContentPlanInvalid("CONTENT_PLAN_ARTIFACT_WITHOUT_PLAN");
      }
      return { plan: null, sha256: input.contentPlanSha256 };
    }
    return null;
  }
  const parsed = siteContentPlanV2Schema.safeParse(input.contentPlan);
  if (!parsed.success) {
    throw new NativeReactBuildError(
      "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      parsed.error.issues
        .slice(0, 32)
        .map((issue) =>
          contentPlanDiagnostic(
            `CONTENT_PLAN_SCHEMA:${issue.code}`,
            issue.path.length > 0 ? issue.path.join(".") : null,
          ),
        ),
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(input.contentPlanSha256 ?? "")) {
    throwContentPlanInvalid("CONTENT_PLAN_SHA_REQUIRED");
  }
  const actualSha256 = sha256(
    Buffer.from(`${canonicalJson(parsed.data)}\n`, "utf8"),
  );
  if (actualSha256 !== input.contentPlanSha256) {
    throwContentPlanInvalid("CONTENT_PLAN_SHA_MISMATCH");
  }
  return {
    plan: parsed.data,
    sha256: actualSha256,
  };
}

function snapshotSectionCandidate(input: {
  candidates: NativeContentPlanDomSnapshot["sectionCandidates"];
  id: string;
  heading: string;
  body: string;
}) {
  const semanticText = (value: string) =>
    normalizedRenderedText(value).replace(
      /([\p{Script=Han}\p{P}])\s+(?=[\p{Script=Han}\p{P}])/gu,
      "$1",
    );
  const expectedHeading = semanticText(input.heading);
  const expectedBodyFragments = input.body
    .split(/\n\s*\n/gu)
    .map(semanticText)
    .filter(Boolean);
  const containsBodyInOrder = (text: string) => {
    const rendered = semanticText(text);
    let cursor = 0;
    for (const fragment of expectedBodyFragments) {
      const index = rendered.indexOf(fragment, cursor);
      if (index < 0) return false;
      cursor = index + fragment.length;
    }
    return true;
  };
  const exactIdCandidates = input.candidates.filter(
    (candidate) => candidate.id === input.id,
  );
  const candidates =
    exactIdCandidates.length > 0 ? exactIdCandidates : input.candidates;
  return candidates
    .map((candidate) => ({
      candidate,
      text: normalizedRenderedText(candidate.text),
    }))
    .filter(
      ({ text }) =>
        semanticText(text).includes(expectedHeading) &&
        containsBodyInOrder(text),
    )
    .sort((left, right) => left.text.length - right.text.length)[0];
}

function observedSiteContentReceipt(input: {
  plan: SiteContentPlanV2;
  contentPlanSha256: string;
  snapshots: readonly NativeContentPlanDomSnapshot[];
}): NativeContentReceiptV1 {
  const snapshotsByPath = new Map(
    input.snapshots.map((snapshot) => [snapshot.path, snapshot] as const),
  );
  return {
    schemaVersion: 1,
    contentPlanSha256: input.contentPlanSha256,
    routes: input.plan.routes.map((route) => {
      const snapshot = snapshotsByPath.get(route.path);
      return {
        path: route.path,
        renderedTextSha256: sha256(
          normalizedRenderedText(snapshot?.mainText ?? ""),
        ),
        sections: route.sections.map((section) => {
          const candidate = snapshot
            ? snapshotSectionCandidate({
                candidates: snapshot.sectionCandidates,
                id: section.id,
                heading: section.heading,
                body: section.body,
              })
            : undefined;
          return {
            id: section.id,
            sourceDocumentIds: [
              ...new Set(
                section.sourceBindings.map(
                  (binding) => binding.sourceDocumentId,
                ),
              ),
            ],
            mediaIds: [...section.mediaIds],
            renderedTextSha256: sha256(candidate?.text ?? ""),
          };
        }),
      };
    }),
  };
}

function contentPlanAdvisoryWarnings(
  diagnostics: readonly NativeReactBuildDiagnostic[],
): NativeReactBuildWarning[] {
  const values =
    diagnostics.length > 0
      ? diagnostics
      : [contentPlanDiagnostic("CONTENT_PLAN_RENDER_DIAGNOSTIC")];
  return values.slice(0, 32).map((diagnostic, index) => ({
    phase: "browser_qa" as const,
    code: "NATIVE_CONTENT_PLAN_WARNING",
    checkId: `content-plan:${diagnostic.code}:${index + 1}`,
  }));
}

/** Audits browser-derived DOM snapshots against the frozen semantic plan.
 * The receipt contains hashes and evidence coordinates only; rendered customer
 * prose is deliberately not copied into build metadata. */
export function auditSiteContentPlanRenderedRoutes(input: {
  plan: SiteContentPlanV2;
  contentPlanSha256: string;
  snapshots: readonly NativeContentPlanDomSnapshot[];
}): NativeContentReceiptV1 {
  const manifest = input.plan.routes.map((route) => route.path);
  const manifestSet = new Set(manifest);
  if (
    input.snapshots.length !== manifest.length ||
    input.snapshots.some((snapshot, index) => snapshot.path !== manifest[index])
  ) {
    throwContentPlanInvalid("CONTENT_PLAN_BROWSER_ROUTE_MISMATCH");
  }

  const diagnostics: NativeReactBuildDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const recordDiagnostic = (code: string, file: string | null = null) => {
    const key = `${code}\0${file ?? ""}`;
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push(contentPlanDiagnostic(code, file));
  };
  const linkTarget = (link: NativeContentPlanDomSnapshot["links"][number]) => {
    if (link.pathname === null) return null;
    try {
      return routePath(link.pathname);
    } catch {
      return null;
    }
  };
  const matchesPlannedLinkLabel = (
    link: NativeContentPlanDomSnapshot["links"][number],
    label: string,
  ) => {
    const text = normalizedRenderedText(link.text);
    return text === label || text.includes(label);
  };

  const routeById = new Map(
    input.plan.routes.map((route) => [route.id, route]),
  );
  for (const coverage of input.plan.coverage) {
    if (coverage.status !== "used") continue;
    for (const routeId of coverage.routeIds) {
      const route = routeById.get(routeId);
      if (
        !route?.sections.some((section) =>
          section.sourceBindings.some(
            (binding) => binding.sourceDocumentId === coverage.sourceDocumentId,
          ),
        )
      ) {
        recordDiagnostic(
          "CONTENT_PLAN_USED_SOURCE_NOT_BOUND",
          route?.path ?? routeId,
        );
      }
    }
  }

  const exactMainTextOwners = new Map<string, string>();
  const paragraphOwners = new Map<string, string>();
  const receiptRoutes: NativeContentReceiptV1["routes"] = [];
  for (const [routeIndex, route] of input.plan.routes.entries()) {
    const snapshot = input.snapshots[routeIndex]!;
    const pageText = normalizedRenderedText(snapshot.pageText);
    const mainText = normalizedRenderedText(snapshot.mainText);
    const h1 = normalizedRenderedText(route.h1);
    const summary = normalizedRenderedText(route.summary);
    if (
      !snapshot.h1Texts.some((value) => normalizedRenderedText(value) === h1)
    ) {
      recordDiagnostic("CONTENT_PLAN_H1_MISSING", route.path);
    }
    if (!pageText.includes(summary)) {
      recordDiagnostic("CONTENT_PLAN_SUMMARY_MISSING", route.path);
    }

    const priorMainOwner = exactMainTextOwners.get(mainText);
    if (mainText && priorMainOwner && priorMainOwner !== route.path) {
      recordDiagnostic("CONTENT_PLAN_DUPLICATE_ROUTE_BODY", route.path);
    }
    if (mainText) exactMainTextOwners.set(mainText, route.path);
    for (const paragraph of snapshot.paragraphTexts) {
      const normalized = normalizedRenderedText(paragraph);
      if (normalized.length < 80) continue;
      const priorOwner = paragraphOwners.get(normalized);
      if (priorOwner && priorOwner !== route.path) {
        recordDiagnostic("CONTENT_PLAN_DUPLICATE_ROUTE_PARAGRAPH", route.path);
      }
      paragraphOwners.set(normalized, route.path);
    }

    for (const link of snapshot.links) {
      if (!link.sameOrigin) {
        if (link.protocol === "http:" || link.protocol === "https:") {
          recordDiagnostic(
            "CONTENT_PLAN_EXTERNAL_HTTP_LINK_FORBIDDEN",
            route.path,
          );
        }
        continue;
      }
      if (link.protocol !== "http:" && link.protocol !== "https:") {
        recordDiagnostic("CONTENT_PLAN_INTERNAL_LINK_INVALID", route.path);
        continue;
      }
      const target = linkTarget(link);
      if (target === null) {
        recordDiagnostic("CONTENT_PLAN_INTERNAL_LINK_INVALID", route.path);
        continue;
      }
      if (!manifestSet.has(target)) {
        recordDiagnostic(
          "CONTENT_PLAN_INTERNAL_LINK_OUTSIDE_MANIFEST",
          route.path,
        );
      }
    }
    for (const navigation of input.plan.navigation) {
      const label = normalizedRenderedText(navigation.label);
      if (
        !snapshot.links.some(
          (link) =>
            link.inGlobalNavigation &&
            link.sameOrigin &&
            matchesPlannedLinkLabel(link, label) &&
            linkTarget(link) === navigation.targetPath,
        )
      ) {
        recordDiagnostic("CONTENT_PLAN_NAVIGATION_MISSING", route.path);
      }
    }
    if (route.cta) {
      const label = normalizedRenderedText(route.cta.label);
      if (route.cta.targetPath) {
        const targetLinks = snapshot.links.filter(
          (link) =>
            link.sameOrigin && linkTarget(link) === route.cta!.targetPath,
        );
        if (!targetLinks.some((link) => matchesPlannedLinkLabel(link, label))) {
          recordDiagnostic(
            targetLinks.length > 0
              ? "CONTENT_PLAN_CTA_TEXT_MISMATCH"
              : "CONTENT_PLAN_CTA_MISSING",
            route.path,
          );
        }
      } else if (!mainText.includes(label)) {
        recordDiagnostic("CONTENT_PLAN_CTA_MISSING", route.path);
      }
    }

    const receiptSections: NativeContentReceiptV1["routes"][number]["sections"] =
      [];
    for (const section of route.sections) {
      const candidate = snapshotSectionCandidate({
        candidates: snapshot.sectionCandidates,
        id: section.id,
        heading: section.heading,
        body: section.body,
      });
      if (!candidate) {
        const headingPresent = mainText.includes(
          normalizedRenderedText(section.heading),
        );
        recordDiagnostic(
          headingPresent
            ? "CONTENT_PLAN_SECTION_BODY_MISSING"
            : "CONTENT_PLAN_SECTION_HEADING_MISSING",
          `${route.path}#${section.id}`,
        );
        continue;
      }
      receiptSections.push({
        id: section.id,
        sourceDocumentIds: [
          ...new Set(
            section.sourceBindings.map((binding) => binding.sourceDocumentId),
          ),
        ],
        mediaIds: [...section.mediaIds],
        renderedTextSha256: sha256(candidate.text),
      });
    }
    receiptRoutes.push({
      path: route.path,
      renderedTextSha256: sha256(mainText),
      sections: receiptSections,
    });
  }
  if (diagnostics.length > 0) {
    const sorted = [...diagnostics].sort((left, right) => {
      const leftKey = `${left.code}\0${left.file ?? ""}`;
      const rightKey = `${right.code}\0${right.file ?? ""}`;
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
    const firstByCode: NativeReactBuildDiagnostic[] = [];
    const representedCodes = new Set<string>();
    for (const diagnostic of sorted) {
      if (representedCodes.has(diagnostic.code)) continue;
      representedCodes.add(diagnostic.code);
      firstByCode.push(diagnostic);
    }
    const selectedKeys = new Set(
      firstByCode.map(
        (diagnostic) => `${diagnostic.code}\0${diagnostic.file ?? ""}`,
      ),
    );
    const repairDiagnostics = [
      ...firstByCode,
      ...sorted.filter(
        (diagnostic) =>
          !selectedKeys.has(`${diagnostic.code}\0${diagnostic.file ?? ""}`),
      ),
    ].slice(0, 32);
    throw new NativeReactBuildError(
      "NATIVE_BUILD_CONTENT_PLAN_INVALID",
      repairDiagnostics,
    );
  }
  return {
    schemaVersion: 1,
    contentPlanSha256: input.contentPlanSha256,
    routes: receiptRoutes,
  };
}

function routeOutput(route: string) {
  return route === "/" ? "index.html" : `${route.slice(1)}index.html`;
}

function archiveDependencies(packageJson: Readonly<Record<string, unknown>>) {
  const names = new Set<string>(["react", "react-dom"]);
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const value = packageJson[key];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    for (const name of Object.keys(value)) names.add(name);
  }
  for (const name of names) {
    if (!HOST_DEPENDENCY_ALLOWLIST.has(name)) {
      throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
    }
  }
  return [...names].sort();
}

function hostPackageRoot(name: string) {
  const require = createRequire(import.meta.url);
  try {
    let directory = path.dirname(require.resolve(name));
    for (let depth = 0; depth < 16; depth += 1) {
      const manifestPath = path.join(directory, "package.json");
      try {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as Record<string, unknown>;
        if (manifest.name === name) return directory;
      } catch {
        // Keep walking until the package root owning the resolved entry.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    throw new Error("HOST_PACKAGE_ROOT_NOT_FOUND");
  } catch {
    // CSS-only packages can expose only the `style` condition and therefore
    // have no CommonJS-resolvable entry. Their package root is still present
    // in Node's fixed lookup paths and can be linked without running code.
    for (const searchRoot of require.resolve.paths(name) ?? []) {
      const candidate = path.join(searchRoot, name);
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(candidate, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        if (manifest.name === name) return candidate;
      } catch {
        // Continue through the deterministic module search roots.
      }
    }
    throw new NativeReactBuildError("NATIVE_BUILD_DEPENDENCY_UNAVAILABLE", [
      { code: "HOST_PACKAGE_MISSING", file: null, line: null, column: null },
    ]);
  }
}

async function linkHostDependencies(root: string, dependencies: string[]) {
  const modules = path.join(root, "node_modules");
  await mkdir(modules, { recursive: false, mode: 0o700 });
  for (const dependency of dependencies) {
    const target = path.join(modules, ...dependency.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await symlink(hostPackageRoot(dependency), target, "dir");
  }
}

async function writeValidatedSource(
  root: string,
  source: ValidatedNativeReactSource,
) {
  for (const [filename, bytes] of [...source.files.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const target = path.join(root, ...filename.split("/"));
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { mode: 0o600 });
  }
  const indexPath = path.join(root, source.htmlEntrypoint);
  const raw = await readFile(indexPath, "utf8");
  const withoutExistingBase = raw.replace(/<base\b[^>]*>/giu, "");
  const normalized = /<head\b[^>]*>/iu.test(withoutExistingBase)
    ? withoutExistingBase.replace(
        /<head\b([^>]*)>/iu,
        '<head$1><base href="/">',
      )
    : `<!doctype html><html><head><base href="/"></head><body>${withoutExistingBase}</body></html>`;
  await writeFile(indexPath, normalized, { encoding: "utf8", mode: 0o600 });
}

function resolveHostModule(name: string) {
  const require = createRequire(import.meta.url);
  try {
    return pathToFileURL(require.resolve(name)).href;
  } catch {
    throw new NativeReactBuildError("NATIVE_BUILD_RUNTIME_UNAVAILABLE");
  }
}

function controlledViteBuilderSource(input: {
  viteModuleUrl: string;
  tailwindModuleUrl: string | null;
  tailwindV3ModuleUrl: string | null;
  tailwindAnimateModuleUrl: string | null;
  autoprefixerModuleUrl: string | null;
  tailwindV3Config: Record<string, unknown> | null;
  useTailwind: boolean;
  allowedDependencies: string[];
  sourceAliasRoot: "." | "src";
}) {
  return `
import { createHash } from "node:crypto";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { syncBuiltinESMExports } from "node:module";

const denyNetwork = () => { throw new Error("NATIVE_BUILD_NETWORK_FORBIDDEN"); };
for (const module of [http, https]) { module.request = denyNetwork; module.get = denyNetwork; }
net.connect = denyNetwork;
net.createConnection = denyNetwork;
tls.connect = denyNetwork;
dgram.createSocket = denyNetwork;
globalThis.fetch = denyNetwork;
globalThis.WebSocket = class { constructor() { denyNetwork(); } };
syncBuiltinESMExports();

const root = process.cwd();
const allowedDependencies = new Set(${JSON.stringify(input.allowedDependencies)});
const sourceBoundary = {
  name: "frontmind-native-source-boundary",
  enforce: "pre",
  resolveId(source, importer) {
    if (typeof source !== "string" || source.startsWith("\\0")) return null;
    const clean = source.split(/[?#]/, 1)[0];
    if (/^file:/iu.test(clean) || clean.startsWith("/@fs/")) {
      throw Object.assign(new Error("NATIVE_BUILD_SOURCE_BOUNDARY"), { code: "NATIVE_BUILD_SOURCE_BOUNDARY" });
    }
    if (!importer || !path.isAbsolute(importer)) return null;
    const importerRelative = path.relative(root, importer.split("?", 1)[0]);
    if (importerRelative.startsWith("../") || path.isAbsolute(importerRelative) || importerRelative.startsWith("node_modules/")) return null;
    if (clean.startsWith(".")) {
      const target = path.resolve(path.dirname(importer), clean);
      const relative = path.relative(root, target);
      if (relative.startsWith("../") || path.isAbsolute(relative)) {
        throw Object.assign(new Error("NATIVE_BUILD_SOURCE_BOUNDARY"), { code: "NATIVE_BUILD_SOURCE_BOUNDARY" });
      }
      return null;
    }
    if (clean === "vite/modulepreload-polyfill") return null;
    if (clean.startsWith("/") || clean.startsWith("@/")) return null;
    const dependency = clean.startsWith("@") ? clean.split("/", 2).join("/") : clean.split("/", 1)[0];
    if (!allowedDependencies.has(dependency)) {
      throw Object.assign(new Error("NATIVE_BUILD_DEPENDENCY_BOUNDARY"), { code: "NATIVE_BUILD_DEPENDENCY_BOUNDARY" });
    }
    return null;
  },
};
const dependencyCompatibility = {
  name: "frontmind-native-dependency-compatibility",
  enforce: "pre",
  transform(code, id) {
    const cleanId = typeof id === "string" ? id.split("?", 1)[0].replaceAll("\\\\", "/") : "";
    if (!cleanId.endsWith("/node_modules/shaders/dist/react/bundle.js")) return null;
    const digest = createHash("sha256").update(code).digest("hex");
    if (digest !== ${JSON.stringify(PINNED_SHADERS_REACT_BUNDLE_SHA256)}) {
      throw Object.assign(new Error("NATIVE_BUILD_DEPENDENCY_DRIFT"), { code: "NATIVE_BUILD_DEPENDENCY_DRIFT" });
    }
    // The pinned official bundle includes inert documentation URLs and an
    // opt-out telemetry endpoint. Customer builds run with telemetry disabled;
    // neutralize those literals so hard static QA remains fail-closed without
    // replacing or otherwise changing the shader implementation.
    return {
      code: code
        .replaceAll("https://", "about:blank#https-")
        .replaceAll("http://", "about:blank#http-"),
      map: null,
    };
  },
};
const safeDiagnostic = (error) => {
  const nested = Array.isArray(error?.errors) && error.errors.length > 0
    ? error.errors[0]
    : Array.isArray(error?.cause?.errors) && error.cause.errors.length > 0
      ? error.cause.errors[0]
      : error?.cause;
  const nestedLocation = nested?.location && typeof nested.location === "object" ? nested.location : null;
  const rawIdCandidate = typeof nestedLocation?.file === "string"
    ? nestedLocation.file
    : typeof nested?.id === "string"
      ? nested.id
      : typeof error?.id === "string"
        ? error.id
        : null;
  const rawId = rawIdCandidate ? rawIdCandidate.split("?")[0] : null;
  const relative = rawId && path.isAbsolute(rawId) ? path.relative(root, rawId).replaceAll("\\\\", "/") : rawId;
  const safeFile = relative && !relative.startsWith("../") && !path.isAbsolute(relative) && relative.length <= 240 ? relative : null;
  const location = error?.loc && typeof error.loc === "object" ? error.loc : null;
  const line = nestedLocation?.line ?? location?.line;
  const column = nestedLocation?.column ?? location?.column;
  const safeMessage = typeof error?.message === "string" ? error.message : "";
  const boundaryCode = ["NATIVE_BUILD_SOURCE_BOUNDARY", "NATIVE_BUILD_DEPENDENCY_BOUNDARY"].find((code) => safeMessage.includes(code));
  const diagnosticCode = boundaryCode ?? (typeof nested?.code === "string" ? nested.code : error?.code);
  return {
    code: typeof diagnosticCode === "string" && /^[A-Z0-9_:-]{1,80}$/.test(diagnosticCode) ? diagnosticCode : "VITE_BUILD_ERROR",
    file: safeFile,
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    column: Number.isSafeInteger(column) && column >= 0 ? column : null,
  };
};

try {
  const { build } = await import(${JSON.stringify(input.viteModuleUrl)});
  const plugins = [sourceBoundary, dependencyCompatibility];
  const postcssPlugins = [];
  if (${JSON.stringify(Boolean(input.tailwindV3Config))}) {
    const tailwindModule = await import(${JSON.stringify(input.tailwindV3ModuleUrl)});
    const tailwind = tailwindModule.default ?? tailwindModule;
    const config = ${JSON.stringify(input.tailwindV3Config)};
    config.content = ["./index.html", "./src/**/*.{js,jsx,ts,tsx}", "./app/**/*.{js,jsx,ts,tsx}", "./pages/**/*.{js,jsx,ts,tsx}"];
    if (Array.isArray(config.plugins) && config.plugins.includes("__frontmind_tailwindcss_animate__")) {
      const animateModule = await import(${JSON.stringify(input.tailwindAnimateModuleUrl)});
      config.plugins = [animateModule.default ?? animateModule];
    } else {
      config.plugins = [];
    }
    postcssPlugins.push(tailwind(config));
    const autoprefixerModule = await import(${JSON.stringify(input.autoprefixerModuleUrl)});
    const autoprefixer = autoprefixerModule.default ?? autoprefixerModule;
    postcssPlugins.push(autoprefixer());
  } else if (${JSON.stringify(input.useTailwind)}) {
    const tailwindModule = await import(${JSON.stringify(input.tailwindModuleUrl)});
    const tailwind = tailwindModule.default ?? tailwindModule;
    plugins.push(tailwind());
  }
  await build({
    root,
    base: "/",
    configFile: false,
    publicDir: "public",
    appType: "spa",
    plugins,
    logLevel: "silent",
    clearScreen: false,
    resolve: {
      alias: [
        { find: "@/frontmind-next", replacement: path.join(root, "src/frontmind-next") },
        { find: "@", replacement: path.join(root, ${JSON.stringify(input.sourceAliasRoot)}) },
      ],
      dedupe: ["react", "react-dom"],
    },
    define: {
      "process.env.NODE_ENV": JSON.stringify("production"),
      "process.env": JSON.stringify({}),
      "global": "globalThis",
    },
    esbuild: { jsx: "automatic", jsxDev: false },
    css: { postcss: { plugins: postcssPlugins } },
    build: {
      outDir: path.join(root, "dist"),
      emptyOutDir: true,
      copyPublicDir: true,
      assetsInlineLimit: 4096,
      cssCodeSplit: false,
      sourcemap: false,
      minify: "esbuild",
      target: "es2020",
      reportCompressedSize: false,
      rollupOptions: {
        input: path.join(root, "index.html"),
        output: {
          inlineDynamicImports: true,
          entryFileNames: "assets/app-[hash].js",
          chunkFileNames: "assets/chunk-[hash].js",
          assetFileNames: "assets/[name]-[hash][extname]",
        },
      },
    },
  });
} catch (error) {
  process.stderr.write(${JSON.stringify(SAFE_BUILD_ERROR_MARKER)} + JSON.stringify(safeDiagnostic(error)) + "\\n");
  process.exitCode = 1;
}
`;
}

function sourceUsesTailwind(files: ReadonlyMap<string, Buffer>) {
  for (const [filename, bytes] of files) {
    if (!/\.(?:css|less|sass|scss)$/iu.test(filename)) continue;
    const value = bytes.toString("utf8");
    if (
      /@tailwind\s+|@import\s+["']tailwindcss(?:\/[^"']*)?["']/iu.test(value)
    ) {
      return true;
    }
  }
  return false;
}

function sourceTailwindV3Config(files: ReadonlyMap<string, Buffer>) {
  const bytes = files.get(NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH);
  if (!bytes) return null;
  if (bytes.length < 1 || bytes.length > 128 * 1024) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  try {
    const parsed = z
      .object({
        schemaVersion: z.literal(1),
        config: z.record(z.string(), z.unknown()),
      })
      .strict()
      .parse(JSON.parse(bytes.toString("utf8")));
    return parsed.config;
  } catch {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
}

function sourceAliasRoot(files: ReadonlyMap<string, Buffer>): "." | "src" {
  const paths = [...files.keys()];
  const hasRootAliasTargets = paths.some((value) =>
    /^(?:app|components|hooks|lib|pages)\//u.test(value),
  );
  const hasSrcAliasTargets = paths.some((value) =>
    /^src\/(?:app|components|hooks|lib|pages)\//u.test(value),
  );
  return hasRootAliasTargets && !hasSrcAliasTargets ? "." : "src";
}

function parseBuildDiagnostics(output: Buffer) {
  const value = output.toString("utf8");
  const markerIndex = value.lastIndexOf(SAFE_BUILD_ERROR_MARKER);
  if (markerIndex < 0) return [];
  const raw = value
    .slice(markerIndex + SAFE_BUILD_ERROR_MARKER.length)
    .split(/\r?\n/u, 1)[0];
  try {
    const parsed = JSON.parse(raw) as NativeReactBuildDiagnostic;
    if (
      parsed &&
      typeof parsed.code === "string" &&
      (parsed.file === null || typeof parsed.file === "string") &&
      (parsed.line === null || Number.isSafeInteger(parsed.line)) &&
      (parsed.column === null || Number.isSafeInteger(parsed.column))
    ) {
      return [parsed];
    }
  } catch {
    // The caller receives only the stable compile code.
  }
  return [];
}

async function runControlledViteBuild(input: {
  root: string;
  source: ValidatedNativeReactSource;
  dependencies: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal);
  const useTailwind = sourceUsesTailwind(input.source.files);
  const tailwindV3Config = sourceTailwindV3Config(input.source.files);
  const viteModuleUrl = resolveHostModule("vite");
  const tailwindModuleUrl =
    useTailwind && !tailwindV3Config
      ? resolveHostModule("@tailwindcss/vite")
      : null;
  const tailwindV3ModuleUrl = tailwindV3Config
    ? resolveHostModule("tailwindcss-v3")
    : null;
  const tailwindAnimateModuleUrl =
    tailwindV3Config &&
    Array.isArray(tailwindV3Config.plugins) &&
    tailwindV3Config.plugins.includes("__frontmind_tailwindcss_animate__")
      ? resolveHostModule("tailwindcss-animate")
      : null;
  const autoprefixerModuleUrl = tailwindV3Config
    ? resolveHostModule("autoprefixer")
    : null;
  const builder = path.join(input.root, ".frontmind-native-build.mjs");
  await writeFile(
    builder,
    controlledViteBuilderSource({
      viteModuleUrl,
      tailwindModuleUrl,
      tailwindV3ModuleUrl,
      tailwindAnimateModuleUrl,
      autoprefixerModuleUrl,
      tailwindV3Config,
      useTailwind,
      allowedDependencies: input.dependencies,
      sourceAliasRoot: sourceAliasRoot(input.source.files),
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  return await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      // The admitted #22 template retains its original `shaders/react`
      // component subtree. Vite/Rollup peaks above 512 MiB while bundling the
      // frozen shader modules, so keep the child bounded but leave enough
      // headroom to compile the unmodified visual baseline.
      ["--max-old-space-size=768", builder],
      {
        cwd: input.root,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          NODE_ENV: "production",
          HOME: input.root,
          LANG: "C.UTF-8",
          TZ: "UTC",
          NO_COLOR: "1",
          CI: "1",
          PATH: path.dirname(process.execPath),
          npm_config_offline: "true",
          npm_config_ignore_scripts: "true",
          VITE_CJS_IGNORE_WARNING: "true",
        },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0;
    let overflow = false;
    const collect = (raw: Buffer) => {
      if (overflow) return;
      bytes += raw.length;
      if (bytes > MAX_BUILD_LOG_BYTES) {
        overflow = true;
        child.kill("SIGKILL");
        return;
      }
      chunks.push(raw);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const abort = () => child.kill("SIGKILL");
    input.abortSignal?.addEventListener("abort", abort, { once: true });
    const cleanup = () =>
      input.abortSignal?.removeEventListener("abort", abort);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, input.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      cleanup();
      reject(new NativeReactBuildError("NATIVE_BUILD_RUNTIME_UNAVAILABLE"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      cleanup();
      const output = Buffer.concat(
        chunks,
        Math.min(bytes, MAX_BUILD_LOG_BYTES),
      );
      if (input.abortSignal?.aborted) {
        reject(new NativeReactBuildError("NATIVE_BUILD_ABORTED"));
      } else if (timedOut) {
        reject(new NativeReactBuildError("NATIVE_BUILD_TIMEOUT"));
      } else if (overflow) {
        reject(new NativeReactBuildError("NATIVE_BUILD_LOG_LIMIT_EXCEEDED"));
      } else if (code !== 0) {
        reject(
          new NativeReactBuildError(
            "NATIVE_BUILD_COMPILE_FAILED",
            parseBuildDiagnostics(output),
          ),
        );
      } else {
        resolve(
          jsonBuffer({
            schemaVersion: 1,
            renderer: "twenty_first_native_react_v1",
            sourceFileCount: input.source.fileCount,
            buildLogBytes: output.length,
          }),
        );
      }
    });
  });
}

/** Compiles a previously validated archive with the same host-owned Vite
 * configuration used by preview and production. Provider package scripts and
 * provider build configuration are never executed; compilation runs in a
 * bounded child process with a minimal environment and no network grant. */
export async function compileValidatedNativeReactSource(input: {
  root: string;
  source: ValidatedNativeReactSource;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}) {
  assertNotAborted(input.abortSignal);
  await writeValidatedSource(input.root, input.source);
  const dependencies = archiveDependencies(input.source.packageJson);
  await linkHostDependencies(input.root, dependencies);
  const buildLog = await runControlledViteBuild({
    root: input.root,
    source: input.source,
    dependencies,
    timeoutMs: boundedTimeout(input.timeoutMs),
    abortSignal: input.abortSignal,
  });
  return {
    buildLog,
    dependencies,
    files: await readDistFiles(path.join(input.root, "dist")),
  };
}

function safeOutputPath(relative: string) {
  const normalized = relative.split(path.sep).join("/").normalize("NFKC");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized
      .split("/")
      .some((part) => !part || part === "." || part === "..") ||
    Buffer.byteLength(normalized, "utf8") > 300
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_DIST_INVALID");
  }
  return normalized;
}

async function readDistFiles(root: string) {
  const files: OutputFile[] = [];
  let totalBytes = 0;
  const walk = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_INVALID");
      }
      if (metadata.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!metadata.isFile()) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_INVALID");
      }
      const relative = safeOutputPath(path.relative(root, absolute));
      if (metadata.size > MAX_DIST_FILE_BYTES) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
      }
      const content = await readFile(absolute);
      totalBytes += content.length;
      files.push({ path: relative, bytes: content });
      if (files.length > MAX_DIST_FILES || totalBytes > MAX_DIST_BYTES) {
        throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
      }
    }
  };
  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function upsertHeadMarkup(html: string, markup: string) {
  if (/<head\b[^>]*>/iu.test(html)) {
    return html.replace(/<head\b([^>]*)>/iu, `<head$1>${markup}`);
  }
  return html.replace(/<html\b([^>]*)>/iu, `<html$1><head>${markup}</head>`);
}

function normalizeRoutePages(input: {
  files: OutputFile[];
  routes: string[];
  mode: "preview" | "production";
  canonicalOrigin: string | null;
}) {
  const fileMap = new Map(input.files.map((file) => [file.path, file.bytes]));
  const root = fileMap.get("index.html");
  if (!root) throw new NativeReactBuildError("NATIVE_BUILD_ROUTE_MISSING");
  const rootHtml = root.toString("utf8");
  const routeOutputs = new Set(input.routes.map(routeOutput));
  routeOutputs.add("404.html");
  for (const filename of fileMap.keys()) {
    if (/\.html$/iu.test(filename) && !routeOutputs.has(filename)) {
      fileMap.delete(filename);
    }
  }
  for (const output of routeOutputs) {
    const route =
      output === "404.html"
        ? null
        : input.routes.find((value) => routeOutput(value) === output)!;
    let html = rootHtml
      .replace(/<meta\s+name=["']robots["'][^>]*>/giu, "")
      .replace(/<link\s+rel=["']canonical["'][^>]*>/giu, "")
      .replace(
        /<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>/giu,
        "",
      );
    html = upsertHeadMarkup(
      html,
      `<meta http-equiv="Content-Security-Policy" content="${NATIVE_DOCUMENT_CSP}">`,
    );
    if (input.mode === "preview" || output === "404.html") {
      html = upsertHeadMarkup(
        html,
        '<meta name="robots" content="noindex,nofollow">',
      );
    } else {
      const canonical = new URL(route!, input.canonicalOrigin!).toString();
      html = upsertHeadMarkup(
        html,
        `<link rel="canonical" href="${canonical}">`,
      );
    }
    fileMap.set(output, Buffer.from(html, "utf8"));
  }
  if (input.mode === "preview") {
    fileMap.set(
      "robots.txt",
      Buffer.from("User-agent: *\nDisallow: /\n", "utf8"),
    );
    fileMap.delete("sitemap.xml");
  } else {
    const urls = input.routes
      .map(
        (route) =>
          `  <url><loc>${new URL(route, input.canonicalOrigin!).toString()}</loc></url>`,
      )
      .join("\n");
    fileMap.set(
      "sitemap.xml",
      Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
        "utf8",
      ),
    );
    fileMap.set(
      "robots.txt",
      Buffer.from(
        `User-agent: *\nAllow: /\nSitemap: ${input.canonicalOrigin}/sitemap.xml\n`,
        "utf8",
      ),
    );
  }
  return [...fileMap.entries()]
    .map(([filename, bytes]) => ({ path: filename, bytes }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

const DIST_SENSITIVE_TEXT =
  /(?:-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----|\bAKIA[A-Z0-9]{16}\b|\bLTAI[A-Za-z0-9]{12,}\b|\bsk-(?:live|proj)?-?[A-Za-z0-9_-]{20,}\b|(?:access[_-]?key[_-]?secret|api[_-]?key|app[_-]?secret|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["'][^"'\r\n]{12,}["'])/iu;

const SAFE_COMPILED_ABSOLUTE_URLS = new Set([
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/2001/XMLSchema-instance",
  "http://www.w3.org/XML/1998/namespace",
  "http://www.sitemaps.org/schemas/sitemap/0.9",
]);

function compiledTextHasForbiddenExternalUrl(input: {
  text: string;
  mode: "preview" | "production";
  canonicalOrigin: string | null;
}) {
  const absoluteUrls = input.text.match(/https?:\/\/[^\s"'`<>{}\\]+/giu) ?? [];
  for (const raw of absoluteUrls) {
    if (
      SAFE_COMPILED_ABSOLUTE_URLS.has(raw) ||
      raw === "https://tailwindcss.com" ||
      raw.startsWith("https://react.dev/errors/")
    ) {
      continue;
    }
    if (input.mode === "production" && input.canonicalOrigin) {
      try {
        if (new URL(raw).origin === new URL(input.canonicalOrigin).origin) {
          continue;
        }
      } catch {
        return true;
      }
    }
    return true;
  }
  return /["'`]\/\/[A-Za-z0-9\[]/u.test(input.text);
}

function localReferencePath(raw: string, from: string) {
  const clean = raw.split(/[?#]/u, 1)[0]!;
  if (
    !clean ||
    clean.startsWith("#") ||
    /^(?:data:|blob:|mailto:|tel:)/iu.test(clean)
  ) {
    return null;
  }
  if (/^(?:https?:)?\/\//iu.test(clean)) return "__external__";
  const resolved = clean.startsWith("/")
    ? clean.slice(1)
    : path.posix.normalize(path.posix.join(path.posix.dirname(from), clean));
  if (!resolved || resolved.startsWith("../") || resolved.includes("\\")) {
    return "__invalid__";
  }
  return resolved;
}

function assertStaticHardSafety(input: {
  files: OutputFile[];
  routes: string[];
  mode: "preview" | "production";
  canonicalOrigin: string | null;
  forbiddenTokens: string[];
}) {
  const fileMap = new Map(input.files.map((file) => [file.path, file.bytes]));
  const checks: NativeReactQaReportV1["checks"] = [];
  const requireCheck = (
    id: string,
    condition: boolean,
    detail: string,
    code: NativeReactBuildErrorCode,
  ) => {
    if (!condition) throw new NativeReactBuildError(code);
    checks.push({ id, passed: true, detail });
  };
  requireCheck(
    "route-manifest",
    input.routes.every((route) => fileMap.has(routeOutput(route))) &&
      fileMap.has("404.html"),
    `${input.routes.length} routes and 404 are present`,
    "NATIVE_BUILD_ROUTE_MISSING",
  );
  const textFiles = input.files.filter((file) =>
    /\.(?:css|html|js|json|mjs|svg|txt|xml)$/iu.test(file.path),
  );
  requireCheck(
    "secret-scan",
    input.files.every(
      (file) =>
        !DIST_SENSITIVE_TEXT.test(file.bytes.toString("latin1")) &&
        input.forbiddenTokens.every(
          (token) =>
            token.length === 0 || !file.bytes.includes(Buffer.from(token)),
        ),
    ),
    "compiled output contains no credential-shaped material",
    "NATIVE_BUILD_SECRET_FORBIDDEN",
  );
  for (const file of textFiles) {
    const text = file.bytes.toString("utf8");
    requireCheck(
      `external-url-literals:${file.path}`,
      !compiledTextHasForbiddenExternalUrl({
        text,
        mode: input.mode,
        canonicalOrigin: input.canonicalOrigin,
      }),
      "compiled text contains no untrusted external URL literal",
      "NATIVE_BUILD_NETWORK_FORBIDDEN",
    );
    if (/\.html$/iu.test(file.path)) {
      requireCheck(
        `no-frame:${file.path}`,
        !/<(?:iframe|object|embed)\b/iu.test(text),
        "embedded browsing contexts are absent",
        "NATIVE_BUILD_NETWORK_FORBIDDEN",
      );
      const resourceReferences = [
        ...text.matchAll(
          /<(?:script|img|source|video|audio)\b[^>]*\bsrc=["']([^"']+)["']/giu,
        ),
        ...text.matchAll(
          /<link\b(?=[^>]*\brel=["'](?:stylesheet|icon|preload|modulepreload)["'])[^>]*\bhref=["']([^"']+)["']/giu,
        ),
      ].map((match) => match[1]!);
      for (const reference of resourceReferences) {
        const local = localReferencePath(reference, file.path);
        requireCheck(
          `resource-origin:${file.path}`,
          local !== "__external__" && local !== "__invalid__",
          "resource URLs stay on the generated origin",
          "NATIVE_BUILD_NETWORK_FORBIDDEN",
        );
        if (local) {
          requireCheck(
            `local-asset:${file.path}:${local}`,
            fileMap.has(local),
            "referenced local asset exists",
            "NATIVE_BUILD_LOCAL_ASSET_MISSING",
          );
        }
      }
    }
    if (/\.css$/iu.test(file.path)) {
      for (const match of text.matchAll(
        /url\(\s*["']?([^"')]+)["']?\s*\)/giu,
      )) {
        const local = localReferencePath(match[1]!, file.path);
        requireCheck(
          `css-resource-origin:${file.path}`,
          local !== "__external__" && local !== "__invalid__",
          "CSS resources stay on the generated origin",
          "NATIVE_BUILD_NETWORK_FORBIDDEN",
        );
        if (local) {
          requireCheck(
            `css-local-asset:${file.path}:${local}`,
            fileMap.has(local),
            "CSS local asset exists",
            "NATIVE_BUILD_LOCAL_ASSET_MISSING",
          );
        }
      }
    }
    if (/\.(?:js|mjs)$/iu.test(file.path)) {
      requireCheck(
        `compiled-network:${file.path}`,
        !/(?:src|poster)\s*:\s*["'](?:https?:)?\/\//iu.test(text),
        "compiled code contains no external resource binding",
        "NATIVE_BUILD_NETWORK_FORBIDDEN",
      );
      for (const match of text.matchAll(
        /(?:src|poster)\s*:\s*["'](\/[a-zA-Z0-9_./-]+)["']/gu,
      )) {
        const local = match[1]!.slice(1);
        requireCheck(
          `compiled-local-asset:${file.path}:${local}`,
          fileMap.has(local),
          "compiled local media asset exists",
          "NATIVE_BUILD_LOCAL_ASSET_MISSING",
        );
      }
    }
  }
  if (input.mode === "preview") {
    requireCheck(
      "preview-noindex",
      input.routes.every((route) =>
        fileMap
          .get(routeOutput(route))!
          .toString("utf8")
          .includes('name="robots" content="noindex,nofollow"'),
      ),
      "all preview routes are noindex",
      "NATIVE_BUILD_DIST_INVALID",
    );
  } else {
    requireCheck(
      "production-canonical",
      input.routes.every((route) =>
        fileMap
          .get(routeOutput(route))!
          .toString("utf8")
          .includes(
            `href="${new URL(route, input.canonicalOrigin!).toString()}"`,
          ),
      ),
      "all production routes bind the requested canonical origin",
      "NATIVE_BUILD_DIST_INVALID",
    );
  }
  return checks;
}

function servedMime(filename: string) {
  const extension = path.posix.extname(filename).toLowerCase();
  if (extension === ".html") return "text/html; charset=utf-8";
  if (extension === ".css") return "text/css; charset=utf-8";
  if ([".js", ".mjs"].includes(extension))
    return "text/javascript; charset=utf-8";
  if (extension === ".svg") return "image/svg+xml";
  if (extension === ".png") return "image/png";
  if ([".jpg", ".jpeg"].includes(extension)) return "image/jpeg";
  if (extension === ".webp") return "image/webp";
  if (extension === ".woff2") return "font/woff2";
  if (extension === ".json") return "application/json";
  return "application/octet-stream";
}

type NativeBrowserRuntimeFailureCode =
  | "NATIVE_BROWSER_PAGE_ERROR"
  | "NATIVE_BROWSER_CONSOLE_ERROR";

async function assertNativeBrowserRouteRendered(
  page: Page,
  runtimeFailureCodes: ReadonlySet<NativeBrowserRuntimeFailureCode>,
) {
  await page.waitForTimeout(250);
  if (runtimeFailureCodes.size > 0) {
    throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
  }
  const rootState = await page.evaluate(() => {
    const root = document.querySelector("#root");
    if (!root) {
      return {
        exists: false,
        hasContent: false,
        hasLayout: false,
        hasVisibleContent: false,
      };
    }
    const hasDirectText = [...root.childNodes].some(
      (node) =>
        node.nodeType === Node.TEXT_NODE && Boolean(node.textContent?.trim()),
    );
    const visibleCandidates = [
      ...(hasDirectText ? [root] : []),
      ...root.querySelectorAll("*"),
    ];
    let hasVisibleContent = false;
    for (const element of visibleCandidates) {
      const bounds = element.getBoundingClientRect();
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      let current: Element | null = element;
      let visible = true;
      while (current) {
        const style = window.getComputedStyle(current);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.contentVisibility === "hidden" ||
          Number.parseFloat(style.opacity) === 0
        ) {
          visible = false;
          break;
        }
        current = current.parentElement;
      }
      if (visible) {
        hasVisibleContent = true;
        break;
      }
    }
    const rootBounds = root.getBoundingClientRect();
    return {
      exists: true,
      hasContent: hasDirectText || root.children.length > 0,
      hasLayout: rootBounds.width > 0 && rootBounds.height > 0,
      hasVisibleContent,
    };
  });
  if (
    runtimeFailureCodes.size > 0 ||
    !rootState.exists ||
    !rootState.hasContent ||
    !rootState.hasLayout ||
    !rootState.hasVisibleContent
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
  }
}

async function runBrowserQaStrict(input: {
  files: OutputFile[];
  routes: string[];
  mode: "preview" | "production";
  workRoot: string;
  runLighthouse: boolean;
  abortSignal?: AbortSignal;
  requiredUserMedia: readonly {
    publicPath: string;
    contentSha256: string;
  }[];
  requiredKnowledgeMedia: readonly {
    assetId: string;
    publicPath: string;
    contentSha256: string;
    routePaths: readonly string[];
  }[];
  contentPlan: SiteContentPlanV2 | null;
  contentPlanSha256: string | null;
}) {
  const privatePreviewPrefix = "/__frontmind-siteops-preview-qa__/";
  const privatePreviewQa =
    input.mode === "preview" && Boolean(input.contentPlan);
  const fileMap = new Map(input.files.map((file) => [file.path, file.bytes]));
  const warnings: NativeReactBuildWarning[] = [];
  const screenshots: OutputFile[] = [];
  const server = createServer((request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const decoded = decodeURIComponent(url.pathname);
      if (
        decoded.includes("\\") ||
        decoded.includes("\0") ||
        decoded.split("/").some((part) => part === "." || part === "..")
      ) {
        response.writeHead(400).end();
        return;
      }
      const canonicalDecoded =
        privatePreviewQa && decoded.startsWith(privatePreviewPrefix)
          ? `/${decoded.slice(privatePreviewPrefix.length)}`
          : decoded;
      const clean = canonicalDecoded.replace(/^\/+|\/+$/gu, "");
      const candidates = clean
        ? path.posix.extname(clean)
          ? [clean]
          : [`${clean}/index.html`, clean]
        : ["index.html"];
      const filename = candidates.find((candidate) => fileMap.has(candidate));
      const bytes = filename ? fileMap.get(filename) : fileMap.get("404.html");
      if (!bytes) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(filename ? 200 : 404, {
        "Cache-Control": "no-store",
        "Content-Type": servedMime(filename ?? "404.html"),
        "Content-Length": bytes.length,
        "Content-Security-Policy": NATIVE_DOCUMENT_CSP,
        ...(input.mode === "preview"
          ? { "X-Robots-Tag": "noindex, nofollow, noarchive" }
          : {}),
      });
      response.end(bytes);
    } catch {
      response.writeHead(400).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("NATIVE_BROWSER_SERVER_UNAVAILABLE");
  }
  const origin = `http://127.0.0.1:${address.port}`;
  const closeServer = async () => {
    if (!server.listening) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  let axeViolationCount = 0;
  const axeViolationIds = new Set<string>();
  let browserAvailable = false;
  let contentReceipt: NativeContentReceiptV1 | null = null;
  const contentPlanSnapshots: NativeContentPlanDomSnapshot[] = [];
  const renderedUserMedia = new Set<string>();
  try {
    assertNotAborted(input.abortSignal);
    const browser = await chromium.launch({
      headless: true,
      chromiumSandbox: false,
      args: ["--disable-background-networking", "--disable-sync"],
      env: {
        HOME: input.workRoot,
        LANG: "C.UTF-8",
        TZ: "UTC",
        PATH: path.dirname(process.execPath),
      },
    });
    try {
      browserAvailable = true;
      const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion: "reduce",
        serviceWorkers: "block",
      });
      const page = await context.newPage();
      const renderedKnowledgeMedia = new Set<string>();
      const runtimeFailureCodes = new Set<NativeBrowserRuntimeFailureCode>();
      let externalRequestDetected = false;
      let cspViolationDetected = false;
      page.on("pageerror", () => {
        runtimeFailureCodes.add("NATIVE_BROWSER_PAGE_ERROR");
      });
      await page.exposeBinding("__frontmindNativeConsoleError", () => {
        runtimeFailureCodes.add("NATIVE_BROWSER_CONSOLE_ERROR");
      });
      await page.exposeBinding("__frontmindNativePolicyViolation", () => {
        cspViolationDetected = true;
      });
      if (privatePreviewQa) {
        await page.addInitScript({
          content: `if(location.pathname.startsWith(${JSON.stringify(privatePreviewPrefix)})){${previewNavigationBridgeSource(privatePreviewPrefix)}}`,
        });
      }
      await page.addInitScript(() => {
        const scope = globalThis as typeof globalThis & {
          __frontmindNativeConsoleError: () => Promise<void>;
          __frontmindNativePolicyViolation: () => Promise<void>;
        };
        const originalConsoleError = console.error.bind(console);
        console.error = (...args: unknown[]) => {
          void scope.__frontmindNativeConsoleError();
          originalConsoleError(...args);
        };
        document.addEventListener("securitypolicyviolation", (event) => {
          const blocked = event.blockedURI;
          if (
            /^(?:https?:)?\/\//iu.test(blocked) &&
            new URL(blocked, window.location.href).origin !==
              window.location.origin
          ) {
            void scope.__frontmindNativePolicyViolation();
          }
        });
      });
      await page.route("**/*", async (route) => {
        const requestUrl = new URL(route.request().url());
        if (requestUrl.origin !== origin) {
          externalRequestDetected = true;
          await route.abort("blockedbyclient");
          return;
        }
        await route.continue();
      });
      const navigateAndAssertRendered = async (
        route: string,
        usePrivatePreviewPath: boolean,
        recordEvidence: boolean,
      ) => {
        runtimeFailureCodes.clear();
        const browserPath = usePrivatePreviewPath
          ? `${privatePreviewPrefix}${route.slice(1)}`
          : route;
        const response = await page.goto(`${origin}${browserPath}`, {
          waitUntil: "networkidle",
          timeout: 15_000,
        });
        if (!response?.ok()) {
          throw new NativeReactBuildError("NATIVE_BUILD_RENDER_FAILED");
        }
        if (externalRequestDetected || cspViolationDetected) {
          throw new NativeReactBuildError("NATIVE_BUILD_NETWORK_FORBIDDEN");
        }
        await assertNativeBrowserRouteRendered(page, runtimeFailureCodes);
        const imageReferences = await page
          .locator("img")
          .evaluateAll((images) =>
            images.map((image) => ({
              pathname: new URL(
                (image as HTMLImageElement).currentSrc ||
                  (image as HTMLImageElement).src,
                document.baseURI,
              ).pathname,
              alt: image.getAttribute("alt")?.trim() ?? "",
            })),
          );
        if (recordEvidence) {
          for (const required of input.requiredUserMedia) {
            if (
              imageReferences.some(
                (reference) =>
                  reference.pathname === required.publicPath &&
                  reference.alt.length > 0,
              )
            ) {
              renderedUserMedia.add(required.publicPath);
            }
          }
          for (const required of input.requiredKnowledgeMedia) {
            if (
              required.routePaths.includes(route) &&
              imageReferences.some(
                (reference) =>
                  reference.pathname === required.publicPath &&
                  reference.alt.length > 0,
              )
            ) {
              renderedKnowledgeMedia.add(`${required.assetId}:${route}`);
            }
          }
        }
        if (externalRequestDetected || cspViolationDetected) {
          throw new NativeReactBuildError("NATIVE_BUILD_NETWORK_FORBIDDEN");
        }
        return await page.evaluate((currentPath) => {
          const main =
            document.querySelector("main") ?? document.querySelector("#root");
          const candidateElements: Element[] = [];
          const seenCandidates = new Set<Element>();
          for (const element of document.querySelectorAll(
            "[data-siteops-section-id], [data-section-id], section, article",
          )) {
            if (seenCandidates.has(element)) continue;
            seenCandidates.add(element);
            candidateElements.push(element);
          }
          if (main && !seenCandidates.has(main)) {
            candidateElements.push(main);
          }
          const visibleTextParts: string[] = [];
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
          );
          let node = walker.nextNode();
          while (node) {
            const parent = node.parentElement;
            if (
              parent &&
              !parent.closest("script, style, nav, footer, [role=navigation]")
            ) {
              let current: Element | null = parent;
              let visible = true;
              while (current) {
                const style = window.getComputedStyle(current);
                if (
                  style.display === "none" ||
                  style.visibility === "hidden" ||
                  style.contentVisibility === "hidden" ||
                  Number.parseFloat(style.opacity) === 0
                ) {
                  visible = false;
                  break;
                }
                current = current.parentElement;
              }
              if (visible && node.textContent?.trim()) {
                visibleTextParts.push(node.textContent);
              }
            }
            node = walker.nextNode();
          }
          const h1Texts: string[] = [];
          for (const element of document.querySelectorAll("h1")) {
            h1Texts.push(
              ((element as HTMLElement).innerText ?? "")
                .replace(/\s+/gu, " ")
                .trim(),
            );
          }
          const paragraphTexts: string[] = [];
          for (const element of document.querySelectorAll(
            "main p, main li, main blockquote",
          )) {
            paragraphTexts.push(
              ((element as HTMLElement).innerText ?? "")
                .replace(/\s+/gu, " ")
                .trim(),
            );
          }
          const links: NativeContentPlanDomSnapshot["links"] = [];
          for (const element of document.querySelectorAll("a[href]")) {
            const anchor = element as HTMLAnchorElement;
            let target: URL | null = null;
            try {
              target = new URL(anchor.href, document.baseURI);
            } catch {
              target = null;
            }
            links.push({
              text: (anchor.innerText || anchor.textContent || "")
                .replace(/\s+/gu, " ")
                .trim(),
              pathname: target?.pathname ?? null,
              protocol: target?.protocol ?? "invalid:",
              sameOrigin: target?.origin === window.location.origin,
              inGlobalNavigation: Boolean(
                anchor.closest("nav, header, footer, [role=navigation]"),
              ),
            });
          }
          const sectionCandidates: NativeContentPlanDomSnapshot["sectionCandidates"] =
            [];
          for (const element of candidateElements) {
            sectionCandidates.push({
              id:
                element.getAttribute("data-siteops-section-id")?.trim() ||
                element.getAttribute("data-section-id")?.trim() ||
                element.id.trim() ||
                null,
              text: ((element as HTMLElement).innerText ?? "")
                .replace(/\s+/gu, " ")
                .trim(),
            });
          }
          return {
            path: currentPath,
            pageText: visibleTextParts.join(" ").replace(/\s+/gu, " ").trim(),
            mainText: ((main as HTMLElement | null)?.innerText ?? "")
              .replace(/\s+/gu, " ")
              .trim(),
            h1Texts,
            paragraphTexts,
            links,
            sectionCandidates,
          } satisfies NativeContentPlanDomSnapshot;
        }, route);
      };
      for (const [routeIndex, route] of input.routes.entries()) {
        if (privatePreviewQa) {
          await navigateAndAssertRendered(route, false, false);
        }
        const snapshot = await navigateAndAssertRendered(
          route,
          privatePreviewQa,
          true,
        );
        if (input.contentPlan) contentPlanSnapshots.push(snapshot);
        if (routeIndex >= 3) continue;
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
          .analyze();
        for (const violation of axe.violations.filter((value) =>
          ["critical", "serious"].includes(value.impact ?? ""),
        )) {
          axeViolationCount += 1;
          axeViolationIds.add(violation.id);
        }
      }
      if (input.contentPlan) {
        if (!input.contentPlanSha256) {
          throwContentPlanInvalid("CONTENT_PLAN_SHA_REQUIRED");
        }
        contentReceipt = auditSiteContentPlanRenderedRoutes({
          plan: input.contentPlan,
          contentPlanSha256: input.contentPlanSha256,
          snapshots: contentPlanSnapshots,
        });
      }
      const missingUserMedia = input.requiredUserMedia.filter(
        (asset) => !renderedUserMedia.has(asset.publicPath),
      );
      if (missingUserMedia.length > 0) {
        throw new NativeReactBuildError(
          "NATIVE_BUILD_USER_MEDIA_INVALID",
          missingUserMedia.map((asset) => ({
            code: "USER_MEDIA_IMG_ALT_REQUIRED",
            file: asset.publicPath,
            line: null,
            column: null,
          })),
        );
      }
      const missingKnowledgeMedia = input.requiredKnowledgeMedia.flatMap(
        (asset) =>
          asset.routePaths
            .filter(
              (route) =>
                !renderedKnowledgeMedia.has(`${asset.assetId}:${route}`),
            )
            .map((route) => ({ asset, route })),
      );
      if (missingKnowledgeMedia.length > 0) {
        throw new NativeReactBuildError(
          "NATIVE_BUILD_CONTENT_PLAN_INVALID",
          missingKnowledgeMedia.map(({ asset, route }) => ({
            code: "CONTENT_PLAN_MEDIA_IMG_ALT_REQUIRED",
            file: `${route}#${asset.assetId}`,
            line: null,
            column: null,
          })),
        );
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await navigateAndAssertRendered("/", privatePreviewQa, false);
      screenshots.push({
        path: "screenshots/home-1440.png",
        bytes: Buffer.from(
          await page.screenshot({ fullPage: true, type: "png" }),
        ),
      });
      await page.setViewportSize({ width: 390, height: 844 });
      screenshots.push({
        path: "screenshots/home-390.png",
        bytes: Buffer.from(
          await page.screenshot({ fullPage: true, type: "png" }),
        ),
      });
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (error) {
    if (input.abortSignal?.aborted) {
      await closeServer();
      throw new NativeReactBuildError("NATIVE_BUILD_ABORTED");
    }
    if (error instanceof NativeReactBuildError) {
      if (
        error.code === "NATIVE_BUILD_CONTENT_PLAN_INVALID" &&
        input.contentPlan &&
        input.contentPlanSha256
      ) {
        const missingUserMedia = input.requiredUserMedia.filter(
          (asset) => !renderedUserMedia.has(asset.publicPath),
        );
        if (missingUserMedia.length > 0) {
          await closeServer();
          throw new NativeReactBuildError(
            "NATIVE_BUILD_USER_MEDIA_INVALID",
            missingUserMedia.map((asset) => ({
              code: "USER_MEDIA_IMG_ALT_REQUIRED",
              file: asset.publicPath,
              line: null,
              column: null,
            })),
          );
        }
        warnings.push(...contentPlanAdvisoryWarnings(error.diagnostics));
        contentReceipt ??= observedSiteContentReceipt({
          plan: input.contentPlan,
          contentPlanSha256: input.contentPlanSha256,
          snapshots: contentPlanSnapshots,
        });
      } else {
        await closeServer();
        throw error;
      }
    } else if (input.contentPlan && input.contentPlanSha256) {
      if (input.requiredUserMedia.length > 0) {
        await closeServer();
        throw new NativeReactBuildError("NATIVE_BUILD_USER_MEDIA_INVALID", [
          {
            code: "USER_MEDIA_BROWSER_AUDIT_UNAVAILABLE",
            file: null,
            line: null,
            column: null,
          },
        ]);
      }
      warnings.push({
        phase: "browser_qa",
        code: "NATIVE_BROWSER_QA_UNAVAILABLE",
        checkId: "browser:runtime",
      });
      contentReceipt ??= observedSiteContentReceipt({
        plan: input.contentPlan,
        contentPlanSha256: input.contentPlanSha256,
        snapshots: contentPlanSnapshots,
      });
    } else {
      warnings.push({
        phase: "browser_qa",
        code: "NATIVE_BROWSER_QA_UNAVAILABLE",
        checkId: "browser:runtime",
      });
    }
  }
  for (const violationId of [...axeViolationIds].sort()) {
    warnings.push({
      phase: "browser_qa",
      code: "NATIVE_AXE_WARNING",
      checkId: `axe:${violationId}`,
    });
  }
  const lighthouseScores = {
    performance: null as number | null,
    accessibility: null as number | null,
    bestPractices: null as number | null,
    seo: null as number | null,
    cls: null as number | null,
  };
  if (input.runLighthouse && browserAvailable) {
    const chromeRoot = path.join(input.workRoot, "lighthouse");
    try {
      await mkdir(chromeRoot, { recursive: true, mode: 0o700 });
      const launched = await launchChrome({
        chromePath: chromium.executablePath(),
        chromeFlags: [
          "--headless=new",
          "--disable-background-networking",
          "--disable-extensions",
          "--disable-sync",
          "--no-first-run",
          "--no-sandbox",
        ],
        userDataDir: path.join(chromeRoot, "profile"),
        handleSIGINT: false,
        logLevel: "silent",
        envVars: {
          HOME: chromeRoot,
          LANG: "C.UTF-8",
          TZ: "UTC",
          PATH: path.dirname(process.execPath),
        },
      });
      try {
        const result = await lighthouse(`${origin}/`, {
          port: launched.port,
          output: "json",
          logLevel: "silent",
          onlyCategories: [
            "performance",
            "accessibility",
            "best-practices",
            "seo",
          ],
          skipAudits: input.mode === "preview" ? ["is-crawlable"] : undefined,
        });
        if (!result?.lhr) throw new Error("NATIVE_LIGHTHOUSE_NO_RESULT");
        const score = (name: string) =>
          Math.round((result.lhr.categories[name]?.score ?? 0) * 100);
        lighthouseScores.performance = score("performance");
        lighthouseScores.accessibility = score("accessibility");
        lighthouseScores.bestPractices = score("best-practices");
        lighthouseScores.seo = score("seo");
        lighthouseScores.cls = Number(
          result.lhr.audits["cumulative-layout-shift"]?.numericValue ?? 1,
        );
        if (
          lighthouseScores.performance < 85 ||
          lighthouseScores.accessibility < 95 ||
          lighthouseScores.bestPractices < 90 ||
          lighthouseScores.seo < 95 ||
          lighthouseScores.cls >= 0.1
        ) {
          warnings.push({
            phase: "lighthouse",
            code: "NATIVE_LIGHTHOUSE_WARNING",
            checkId: "lighthouse:threshold",
          });
        }
      } finally {
        try {
          launched.kill();
        } catch {
          // Lighthouse/Chromium failures are reported as non-blocking QA.
        }
      }
    } catch {
      warnings.push({
        phase: "lighthouse",
        code: "NATIVE_LIGHTHOUSE_UNAVAILABLE",
        checkId: "lighthouse:runtime",
      });
    }
  } else if (!input.runLighthouse) {
    warnings.push({
      phase: "lighthouse",
      code: "NATIVE_LIGHTHOUSE_SKIPPED",
      checkId: "lighthouse:skipped",
    });
  }
  await closeServer();
  return {
    summary: {
      available: browserAvailable,
      lighthouse: lighthouseScores,
      axeViolationCount,
      axeViolationIds: [...axeViolationIds].sort(),
      screenshotFiles: screenshots.map((file) => file.path),
    },
    warnings,
    screenshots,
    contentReceipt,
  };
}

async function runBrowserQa(input: Parameters<typeof runBrowserQaStrict>[0]) {
  try {
    return await runBrowserQaStrict(input);
  } catch (error) {
    if (
      input.abortSignal?.aborted ||
      (error instanceof NativeReactBuildError &&
        error.code === "NATIVE_BUILD_ABORTED")
    ) {
      throw new NativeReactBuildError("NATIVE_BUILD_ABORTED");
    }
    if (error instanceof NativeReactBuildError) throw error;
    if (input.requiredUserMedia.length > 0) {
      throw new NativeReactBuildError("NATIVE_BUILD_USER_MEDIA_INVALID", [
        {
          code: "USER_MEDIA_BROWSER_AUDIT_UNAVAILABLE",
          file: null,
          line: null,
          column: null,
        },
      ]);
    }
    const contentReceipt =
      input.contentPlan && input.contentPlanSha256
        ? observedSiteContentReceipt({
            plan: input.contentPlan,
            contentPlanSha256: input.contentPlanSha256,
            snapshots: [],
          })
        : null;
    return {
      summary: {
        available: false,
        lighthouse: {
          performance: null,
          accessibility: null,
          bestPractices: null,
          seo: null,
          cls: null,
        },
        axeViolationCount: 0,
        axeViolationIds: [] as string[],
        screenshotFiles: [] as string[],
      },
      warnings: [
        {
          phase: "browser_qa" as const,
          code: "NATIVE_BROWSER_QA_UNAVAILABLE",
          checkId: "browser:runtime",
        },
      ],
      screenshots: [] as OutputFile[],
      contentReceipt,
    };
  }
}

async function deterministicZip(
  files: readonly OutputFile[],
  maxBytes: number,
) {
  const archive = new JSZip();
  let total = 0;
  for (const file of [...files].sort((left, right) =>
    left.path.localeCompare(right.path),
  )) {
    total += file.bytes.length;
    if (total > maxBytes)
      throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
    archive.file(file.path, file.bytes, {
      date: FIXED_ZIP_DATE,
      createFolders: false,
      unixPermissions: 0o100644,
    });
  }
  const output = await archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: "UNIX",
  });
  if (output.length > maxBytes)
    throw new NativeReactBuildError("NATIVE_BUILD_DIST_LIMIT_EXCEEDED");
  return output;
}

function validateSourceBinding(input: NativeReactBuildInput) {
  const sourceHash = sha256(input.sourceZip);
  if (
    sourceHash !== input.validatedSource.sourceSha256 ||
    sourceHash !== input.validatedSource.archiveSha256 ||
    !input.sourceZip.equals(input.validatedSource.sourceZip) ||
    !input.validatedSource.files.has(input.validatedSource.htmlEntrypoint) ||
    !input.validatedSource.files.has(input.validatedSource.entrypoint)
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_SOURCE_MISMATCH");
  }
  return sourceHash;
}

export async function materializeNativeReactSource(
  input: NativeReactBuildInput,
): Promise<MaterializedNativeReactSite> {
  assertNotAborted(input.abortSignal);
  const parsedBuild = buildCoordinatesSchema.safeParse(input.build);
  const parsedBrief = siteBriefSchema.safeParse(input.brief);
  if (!parsedBuild.success || !parsedBrief.success) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const build = parsedBuild.data;
  const brief = parsedBrief.data;
  const frozenContentPlan = parseFrozenContentPlan({
    contentPlan: input.contentPlan,
    contentPlanSha256: input.contentPlanSha256,
    required: isWorkflowV29(build.workflowVersion),
    allowCoordinateOnly:
      input.mode === "production" && !isWorkflowV29(build.workflowVersion),
  });
  const briefRoutes = brief.routes.map((route) => routePath(route.slug));
  const planRoutes = frozenContentPlan?.plan?.routes.map((route) => route.path);
  if (
    input.mode === "preview" &&
    planRoutes &&
    (briefRoutes.length !== planRoutes.length ||
      briefRoutes.some((route, index) => route !== planRoutes[index]))
  ) {
    throwContentPlanInvalid("CONTENT_PLAN_ROUTE_MANIFEST_MISMATCH");
  }
  const routes = planRoutes ?? briefRoutes;
  if (new Set(routes).size !== routes.length) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const canonicalOrigin = validateCanonicalOrigin(
    input.mode,
    input.canonicalOrigin,
  );
  const target =
    input.mode === "production"
      ? input.target === "global_excluding_cn" || input.target === "mainland_cn"
        ? input.target
        : null
      : null;
  if (input.mode === "production" && target === null) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const sourceSha256 = validateSourceBinding(input);
  const requiredUserMedia = input.requiredUserMedia ?? [];
  if (
    // Eight is the per-message admission limit. A verified child build may
    // inherit media from many completed revisions, so replay is bounded by
    // the immutable native source archive's file ceiling instead.
    requiredUserMedia.length > NATIVE_SOURCE_MAX_FILES ||
    new Set(requiredUserMedia.map((asset) => asset.publicPath)).size !==
      requiredUserMedia.length ||
    requiredUserMedia.some(
      (asset) =>
        !/^\/frontmind-user-media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u.test(
          asset.publicPath,
        ) || !/^[a-f0-9]{64}$/u.test(asset.contentSha256),
    )
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  const requiredKnowledgeMedia = input.requiredKnowledgeMedia ?? [];
  if (
    requiredKnowledgeMedia.length > 100 ||
    new Set(requiredKnowledgeMedia.map((asset) => asset.assetId)).size !==
      requiredKnowledgeMedia.length ||
    new Set(requiredKnowledgeMedia.map((asset) => asset.publicPath)).size !==
      requiredKnowledgeMedia.length ||
    requiredKnowledgeMedia.some(
      (asset) =>
        !asset.assetId.trim() ||
        asset.assetId.length > 191 ||
        !/^\/frontmind-knowledge-media\/[a-f0-9]{64}\.(?:png|jpg|webp)$/u.test(
          asset.publicPath,
        ) ||
        !/^[a-f0-9]{64}$/u.test(asset.contentSha256) ||
        asset.routePaths.length < 1 ||
        new Set(asset.routePaths).size !== asset.routePaths.length ||
        asset.routePaths.some((route) => !routes.includes(route)),
    )
  ) {
    throw new NativeReactBuildError("NATIVE_BUILD_INPUT_INVALID");
  }
  if (frozenContentPlan?.plan) {
    const expectedKnowledgeMedia = new Map<string, Set<string>>();
    for (const route of frozenContentPlan.plan.routes) {
      for (const mediaId of new Set(
        route.sections.flatMap((section) => section.mediaIds),
      )) {
        if (mediaId.startsWith("customer-media:")) continue;
        const routePaths = expectedKnowledgeMedia.get(mediaId) ?? new Set();
        routePaths.add(route.path);
        expectedKnowledgeMedia.set(mediaId, routePaths);
      }
    }
    const actualById = new Map(
      requiredKnowledgeMedia.map((asset) => [asset.assetId, asset] as const),
    );
    if (
      actualById.size !== expectedKnowledgeMedia.size ||
      [...expectedKnowledgeMedia].some(([assetId, expectedRoutes]) => {
        const actual = actualById.get(assetId);
        return (
          !actual ||
          actual.routePaths.length !== expectedRoutes.size ||
          actual.routePaths.some((route) => !expectedRoutes.has(route))
        );
      })
    ) {
      throwContentPlanInvalid("CONTENT_PLAN_MEDIA_COORDINATES_MISMATCH");
    }
  } else if (requiredKnowledgeMedia.length > 0) {
    throwContentPlanInvalid("CONTENT_PLAN_MEDIA_WITHOUT_PLAN");
  }
  if ("runtimeContractVersion" in input.validatedSource.receipt) {
    if (!input.runtimeAudit) {
      throw new NativeReactBuildError("NATIVE_BUILD_RUNTIME_AUDIT_UNAVAILABLE");
    }
    const runtimeAudit = input.runtimeAudit({
      files: input.validatedSource.files,
      expectedRoutePaths: frozenContentPlan?.plan
        ? routes
        : brief.routes.map((route) => route.slug),
      requireCanonicalSitePathname: isWorkflowV29(build.workflowVersion),
    });
    if (!runtimeAudit.ok) {
      throw new NativeReactBuildError(
        "NATIVE_BUILD_INPUT_INVALID",
        runtimeAudit.issues.map((issue) => ({
          code: issue.code,
          file: issue.path,
          line: null,
          column: null,
        })),
      );
    }
  }
  const dependencies = archiveDependencies(input.validatedSource.packageJson);
  const root = await mkdtemp(path.join(tmpdir(), "frontmind-native-react-"));
  try {
    const compiled = await compileValidatedNativeReactSource({
      root,
      source: input.validatedSource,
      timeoutMs: input.timeoutMs,
      abortSignal: input.abortSignal,
    });
    const buildLog = compiled.buildLog;
    let files = compiled.files;
    files = normalizeRoutePages({
      files,
      routes,
      mode: input.mode,
      canonicalOrigin,
    });
    const checks = assertStaticHardSafety({
      files,
      routes,
      mode: input.mode,
      canonicalOrigin,
      forbiddenTokens: [input.validatedSource.receipt.operationToken],
    });
    for (const asset of requiredUserMedia) {
      const outputPath = asset.publicPath.replace(/^\//u, "");
      const output = files.find((file) => file.path === outputPath);
      if (!output || sha256(output.bytes) !== asset.contentSha256) {
        throw new NativeReactBuildError("NATIVE_BUILD_USER_MEDIA_INVALID", [
          {
            code: "USER_MEDIA_DIST_FILE_MISSING_OR_CHANGED",
            file: asset.publicPath,
            line: null,
            column: null,
          },
        ]);
      }
    }
    for (const asset of requiredKnowledgeMedia) {
      const outputPath = asset.publicPath.replace(/^\//u, "");
      const output = files.find((file) => file.path === outputPath);
      if (!output || sha256(output.bytes) !== asset.contentSha256) {
        throw new NativeReactBuildError("NATIVE_BUILD_CONTENT_PLAN_INVALID", [
          {
            code: "CONTENT_PLAN_MEDIA_DIST_FILE_MISSING_OR_CHANGED",
            file: asset.publicPath,
            line: null,
            column: null,
          },
        ]);
      }
    }
    if (input.browserQa === false) {
      if (requiredUserMedia.length > 0) {
        throw new NativeReactBuildError("NATIVE_BUILD_USER_MEDIA_INVALID", [
          {
            code: "USER_MEDIA_BROWSER_AUDIT_REQUIRED",
            file: null,
            line: null,
            column: null,
          },
        ]);
      }
    }
    const browserQa =
      input.browserQa === false
        ? {
            summary: {
              available: false,
              lighthouse: {
                performance: null,
                accessibility: null,
                bestPractices: null,
                seo: null,
                cls: null,
              },
              axeViolationCount: 0,
              axeViolationIds: [] as string[],
              screenshotFiles: [] as string[],
            },
            warnings: [
              {
                phase: "browser_qa" as const,
                code: "NATIVE_BROWSER_QA_SKIPPED",
                checkId: "browser:skipped",
              },
            ],
            screenshots: [] as OutputFile[],
            contentReceipt:
              frozenContentPlan?.plan && frozenContentPlan.sha256
                ? observedSiteContentReceipt({
                    plan: frozenContentPlan.plan,
                    contentPlanSha256: frozenContentPlan.sha256,
                    snapshots: [],
                  })
                : null,
          }
        : await runBrowserQa({
            files,
            routes,
            mode: input.mode,
            workRoot: root,
            runLighthouse: input.lighthouseQa !== false,
            abortSignal: input.abortSignal,
            requiredUserMedia,
            requiredKnowledgeMedia,
            contentPlan: frozenContentPlan?.plan ?? null,
            contentPlanSha256: frozenContentPlan?.sha256 ?? null,
          });
    if (frozenContentPlan?.plan && !browserQa.contentReceipt) {
      throwContentPlanInvalid("CONTENT_PLAN_BROWSER_RECEIPT_MISSING");
    }
    if (requiredUserMedia.length > 0) {
      checks.push({
        id: "user-media:dist-and-dom",
        passed: true,
        detail: `${requiredUserMedia.length} frozen user media assets retain exact bytes and render as img elements with non-empty alt text.`,
      });
    }
    if (requiredKnowledgeMedia.length > 0) {
      checks.push({
        id: "knowledge-media:dist",
        passed: true,
        detail: `${requiredKnowledgeMedia.length} frozen knowledge media assets retain exact bytes in the compiled output.`,
      });
    }
    const screenshotBytes = browserQa.screenshots.reduce(
      (total, file) => total + file.bytes.length,
      0,
    );
    const visualScreenshots =
      screenshotBytes <= 20 * 1024 * 1024 ? browserQa.screenshots : [];
    if (visualScreenshots.length !== browserQa.screenshots.length) {
      browserQa.warnings.push({
        phase: "browser_qa",
        code: "NATIVE_BROWSER_SCREENSHOT_LIMIT",
        checkId: "browser:screenshot-limit",
      });
      browserQa.summary.screenshotFiles = [];
    }
    const warningCodes = [
      ...new Set(browserQa.warnings.map((warning) => warning.code)),
    ].sort();
    const buildDelivery: NativeReactBuildDelivery = {
      renderMode: NATIVE_RENDERER,
      qaStatus: warningCodes.length > 0 ? "passed_with_warnings" : "passed",
      warningCodes,
    };
    const distZip = await deterministicZip(files, MAX_DIST_BYTES);
    const distSha256 = sha256(distZip);
    const contentReceipt = browserQa.contentReceipt;
    const contentReceiptJson = contentReceipt
      ? Buffer.from(`${canonicalJson(contentReceipt)}\n`, "utf8")
      : null;
    const contentReceiptSha256 = contentReceiptJson
      ? sha256(contentReceiptJson)
      : null;
    const contract: NativeReactBuildContractV1 = {
      schemaVersion: 1,
      contractKind: "twenty_first_native_build_contract",
      renderer: "twenty_first_native_react_v1",
      buildId: build.id,
      projectId: build.projectId,
      mode: input.mode,
      canonicalOrigin,
      target,
      routes,
      sourceSha256,
      distSha256,
      ...(frozenContentPlan?.plan
        ? {
            contentPlanSha256: frozenContentPlan.sha256,
            contentReceiptSha256: contentReceiptSha256!,
            contentReceipt: contentReceipt!,
          }
        : frozenContentPlan
          ? { contentPlanSha256: frozenContentPlan.sha256 }
          : {}),
    };
    const contractJson = jsonBuffer(contract);
    const qa: NativeReactQaReportV1 = {
      schemaVersion: 1,
      policyVersion: NATIVE_QA_POLICY,
      passed: true,
      mode: input.mode,
      routes,
      checks,
      browser: browserQa.summary,
      buildDelivery,
      warnings: browserQa.warnings,
      fileCount: files.length,
      totalBytes: files.reduce((total, file) => total + file.bytes.length, 0),
    };
    const qaJson = jsonBuffer(qa);
    const visualQaZip = await deterministicZip(
      [{ path: "visual-qa/report.json", bytes: qaJson }, ...visualScreenshots],
      MAX_DIST_BYTES,
    );
    const provenance = {
      schemaVersion: 1,
      renderer: "twenty_first_native_react_v1",
      buildId: build.id,
      projectId: build.projectId,
      knowledgeSnapshotId: build.knowledgeSnapshotId ?? null,
      workflowVersion: build.workflowVersion ?? null,
      selectionHash: build.selectionHash ?? null,
      sourceSha256,
      distSha256,
      providerCodeReused: true,
      providerPromptPersisted: false,
      providerPackageScriptsExecuted: false,
      providerViteConfigExecuted: false,
      runtimeInstallPerformed: false,
      linkedHostDependencies: dependencies,
      buildDelivery,
      ...(frozenContentPlan?.plan
        ? {
            contentPlanSha256: frozenContentPlan.sha256,
            contentReceiptSha256: contentReceiptSha256!,
            contentReceipt: contentReceipt!,
          }
        : frozenContentPlan
          ? { contentPlanSha256: frozenContentPlan.sha256 }
          : {}),
    };
    const provenanceJson = jsonBuffer(provenance);
    return {
      contract,
      contractJson,
      contractSha256: sha256(contractJson),
      sourceZip: Buffer.from(input.sourceZip),
      sourceSha256,
      distZip,
      distSha256,
      qaJson,
      qaSha256: sha256(qaJson),
      visualQaZip,
      visualQaSha256: sha256(visualQaZip),
      provenanceJson,
      provenanceSha256: sha256(provenanceJson),
      contentReceiptJson,
      contentReceiptSha256,
      buildLog,
      files: new Map(files.map((file) => [file.path, file.bytes])),
      buildDelivery,
    };
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Production promotion rebuilds the exact stored source archive under a new
 * trusted canonical origin. It never re-runs Manus or package scripts. */
export function rebuildNativeReactProductionFromSource(
  input: Omit<NativeReactBuildInput, "mode" | "canonicalOrigin" | "target"> & {
    canonicalOrigin: string;
    target: "global_excluding_cn" | "mainland_cn";
  },
) {
  return materializeNativeReactSource({
    ...input,
    mode: "production",
    canonicalOrigin: input.canonicalOrigin,
    target: input.target,
  });
}

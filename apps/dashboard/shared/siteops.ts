import { z } from "zod";

/** Every persisted/runtime workflow coordinate must satisfy this shared
 * boundary before quota reservation or build persistence begins. */
export const siteOpsPersistedWorkflowCoordinateSchema = z
  .string()
  .min(1)
  .max(32);

const siteOpsPersistedWorkflowCoordinatesSchema = z
  .object({
    upstreamVersion: siteOpsPersistedWorkflowCoordinateSchema,
    frontMindVersion: siteOpsPersistedWorkflowCoordinateSchema,
    starterVersion: siteOpsPersistedWorkflowCoordinateSchema,
    componentLibraryVersion: siteOpsPersistedWorkflowCoordinateSchema,
  })
  .strict();

export function parseSiteOpsPersistedWorkflowCoordinates(input: {
  readonly upstreamVersion: string;
  readonly frontMindVersion: string;
  readonly starterVersion: string;
  readonly componentLibraryVersion: string;
}) {
  return siteOpsPersistedWorkflowCoordinatesSchema.parse(input);
}

/** Immutable coordinates for the FrontMind 1.2 host materializer. Keep this
 * record when a later workflow registers a new handler. */
export const SITEOPS_MATERIALIZER_V1_2 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.2.0",
  runtimeManifestSha256:
    "5123e62b0ee7f5c73a9ee42410bb62276938a765781d28ad2345b7ce3814cad6",
  starterVersion: "1.2.0",
  starterSha256:
    "441c938e156745de1469f527649397a087ca4379bffa2a4e47d12bcbc94662fe",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "ba508966169adbd03f87444d499644697b2a5ccaa9b67d0b74730448aaf1eecf",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.3 keeps the trusted materializer implementation while changing
 * the frozen visual-provider evidence contract to search-only V2 bundles. */
export const SITEOPS_MATERIALIZER_V1_3 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.3.0",
  runtimeManifestSha256:
    "6c4b7aed53a2ba821a05a749690efe7686c75dbfd4011b6dcc7b8ae1550fe1bf",
  starterVersion: "1.3.0",
  starterSha256:
    "ad058ea2db058859e5bf5f6399ae027af98f256fba98eeff32c3b075a27cbbff",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "f309d1ecabbef376df54fcd9976c37ff5408a62a9f16aabfc8ca699413c76b5a",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.4 keeps the trusted host materializer while freezing Hero-only
 * visual evidence, attachment-bound knowledge and flat provider wire output. */
export const SITEOPS_MATERIALIZER_V1_4 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.4.0",
  runtimeManifestSha256:
    "a0e52bf6b61c7e1bbd6c506d1b00a6922e2e844f88d9c198b363b04a6c3f4039",
  starterVersion: "1.4.0",
  starterSha256:
    "a7b23f68b51c4a4f3b14ed74a625dfda855817e59c865c9424b9ffd45dcacc4d",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "981a1af2cc6d9030173b9be0a7ec073e60d0303ab4af3c8769b27293221bdce7",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.5 removes redundant provider-owned SEO/order fields while
 * retaining the same strict canonical specifications and trusted host. */
export const SITEOPS_MATERIALIZER_V1_5 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.5.0",
  runtimeManifestSha256:
    "4c7230dc43444e51eb6e87c531168a401f3ce0e787ec70b3e1070671daeb8248",
  starterVersion: "1.5.0",
  starterSha256:
    "07e07aa3618e8967e120cba6b68897b4b73d8a7a79edbfd10f747bb69d75ba69",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.0.0",
  materializerSha256:
    "4b28fdd0f22a1a694b2b1248cffdf59c9eb3e37f383ec4bae1e340d1147a351a",
  qaPolicyVersion: "siteops-qa-v1",
} as const;

/** FrontMind 1.6 freezes Dashboard-owned JSON-data/Astro-template
 * materialization, SHA-alias asset decisions, semantic contrast roles and
 * typed host materialization stages while retaining Wire V2 provider output. */
export const SITEOPS_MATERIALIZER_V1_6 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "1.6.0",
  runtimeManifestSha256:
    "89d3b2986f82c460dc5115405b1d2204dff8820a5b15eeeab489e7e2ae806cd3",
  starterVersion: "1.6.0",
  starterSha256:
    "cdb266816ee05d32f57a697ea4e9f54575d84715af63eb231c0c7516cd653c2d",
  componentLibraryVersion: "1.0.0",
  materializerVersion: "1.6.0",
  materializerSha256:
    "fc2a878a5880cd1a66a487dff5feccc8188389dc643088f25881340fc157f2c7",
  qaPolicyVersion: "siteops-qa-v2",
} as const;

/** React Static 2.0 freezes the high-fidelity ReferenceBlueprintV2, renders
 * host-owned React 19 components to complete static HTML and finalizes an
 * immutable BuildContractV3 only after source/dist digests exist. */
export const SITEOPS_MATERIALIZER_V2_0 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.0.0",
  runtimeManifestSha256:
    "aa45fddb4c9c98e87e53ef0441c6e8e310881ef863809182e0b351c94c10885a",
  starterVersion: "2.0.0",
  starterSha256:
    "9bef440d7d732f384adccd0d2443610010315c43611335c7292bba84937d93ac",
  componentLibraryVersion: "2.0.0",
  materializerVersion: "2.0.0",
  materializerSha256:
    "21585382fdf923667c23ad6290fe9dc71a7faf7fe2f140a46a074c3026cb32c5",
  qaPolicyVersion: "siteops-qa-v3",
} as const;

/** React Static 2.1 renders nine unique FrontMind-owned visual candidates,
 * freezes ReferenceBlueprintV3 and removes public provenance labels while
 * retaining the internal evidence graph. */
export const SITEOPS_MATERIALIZER_V2_1 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.1.0",
  runtimeManifestSha256:
    "1888aaea37c68820910264d7a7aa5922cf67198b14f30085f3774dcd790e57e4",
  starterVersion: "2.1.0",
  starterSha256:
    "126c3304e41e3ead775f716098881c3ef254a44d9af8173bdd093e27f1cabbae",
  componentLibraryVersion: "2.1.0",
  materializerVersion: "2.1.0",
  materializerSha256:
    "b0e3a395902e880dcde8fdc84d04cb171bc5471be10a7c5590365b08787bb148",
  qaPolicyVersion: "siteops-qa-v3",
} as const;

/** React Static 2.2 adds a snapshot-only typed content graph, conditional
 * knowledge routes and host-owned SEO/GEO projection without changing the
 * nine frozen visual families. */
export const SITEOPS_MATERIALIZER_V2_2 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.2.0",
  runtimeManifestSha256:
    "6d69ef19446654f20be4d78989e1f46d8feb03989aac9de7949bac7fd2241716",
  starterVersion: "2.2.0",
  starterSha256:
    "305686b993e31f544d69d88d7d83a12609724d3ddf118abd6eb50c25ed5fe5e7",
  componentLibraryVersion: "2.2.0",
  materializerVersion: "2.2.0",
  materializerSha256:
    "5e947cb8526043d65f439eb5e966e9ce78722d7984e496908ce99e2b163684c6",
  qaPolicyVersion: "siteops-qa-v4",
} as const;

/** React Static 2.3 binds nine distinct real provider references one-to-one
 * with nine independently rendered trusted visual blueprints. */
export const SITEOPS_MATERIALIZER_V2_3 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.3.0",
  runtimeManifestSha256:
    "8b184d606d593a88f74e5298bb7149e253694cdc0d09aaf7a24ede3612e6ed16",
  starterVersion: "2.3.0",
  starterSha256:
    "ad8f0d7c8e2cdbab0480ea4065a48bf8da0e536dcc5348b34eadbe527e7163f2",
  componentLibraryVersion: "2.3.0",
  materializerVersion: "2.3.0",
  materializerSha256:
    "9822b8c2da2ab1d336c0837c1fe464adf171f74572552dd78b9045ba58abd9d7",
  qaPolicyVersion: "siteops-qa-v4",
} as const;

/** Immutable 2.4 content-draft coordinates retained for historical builds. */
export const SITEOPS_MATERIALIZER_V2_4 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.4.0",
  runtimeManifestSha256:
    "b74d40a593f18d34cb21518db5da773358783a070ee38ee791d9b97ac099ff33",
  starterVersion: "2.4.0",
  starterSha256:
    "9b1c9a41b28e64aae8531afca48592c317a32484f98a6185ea3245f37296f74b",
  componentLibraryVersion: "2.4.0",
  materializerVersion: "2.4.0",
  materializerSha256:
    "58b09dd2789ba1aad6a66a8824fef2ab36bf2d5a8488df4248142f019283fed1",
  qaPolicyVersion: "siteops-qa-v5",
} as const;

/** Compatibility alias used by the exact source-replay registry. */
export const SITEOPS_MATERIALIZER_V2_4_LEGACY = SITEOPS_MATERIALIZER_V2_4;

/** Native React 2.5 freezes the complete 21st source/Demo/CSS/dependency
 * bundle, asks Manus for one complete source archive, and compiles that
 * archive directly. It deliberately has no host-owned visual renderer. */
export const SITEOPS_MATERIALIZER_V2_5 = {
  upstreamVersion: "21st-native-react-v1",
  upstreamSha256:
    "18cb8afc97cc07b75a8189dbddb04afa2dc705da585d65a773f340965543991c",
  frontMindVersion: "2.5.0",
  runtimeManifestSha256:
    "20269281a2dccad71186be8aa4c2d96b54d89d0235b119faa31319930acd6b94",
  starterVersion: "twenty-first-native-react-v1",
  starterSha256:
    "18cb8afc97cc07b75a8189dbddb04afa2dc705da585d65a773f340965543991c",
  componentLibraryVersion: "twenty-first-native-react-v1",
  materializerVersion: "2.5.0",
  materializerSha256:
    "f799c987dd62dc3c0dfa55aeb8f9ffb62b30e34870aaec6410d6031d84bc00df",
  qaPolicyVersion: "siteops-native-qa-v1",
} as const;

/** Host-owned immutable baseline. Manus may only return SiteContentPatchV1;
 * it cannot modify source, routes, components, styles, dependencies or paths. */
export const SITEOPS_MATERIALIZER_V2_6 = {
  upstreamVersion: "1.0.0",
  upstreamSha256:
    "ca9387c9f0c7915a443e0a11449adf36f35037825d40643d12b9958d2e32856a",
  frontMindVersion: "2.6.0",
  runtimeManifestSha256:
    "452b2738d73ad3c9a55438da6c3fd3cb5919b682b1524c0226d03459d8a20455",
  starterVersion: "2.6.0",
  starterSha256:
    "4c862312094f62e9ab01c265ec9504ddbe470a76af9eb5da4d614316095a288d",
  componentLibraryVersion: "2.6.0",
  materializerVersion: "2.6.0",
  materializerSha256:
    "88671cbe362cdab533b081e4af71680175bb648c112fd923e7cbaf3110431680",
  qaPolicyVersion: "siteops-qa-v5",
} as const;

/** Native Template 2.7 freezes a complete, locally compiled V6 Template and
 * asks Manus to adapt that exact source archive with the frozen enterprise
 * dossier. It deliberately keeps the existing native hard-safety/build
 * boundary and does not add a host-owned visual or content-quality contract. */
export const SITEOPS_MATERIALIZER_V2_7 = {
  upstreamVersion: "twenty-first-native-template-v1",
  // sha256("frontmind:siteops:2.7.0:twenty-first-native-template-v1")
  upstreamSha256:
    "3f59368c6e41fc9214af6ab449fb8f99d184e12c16053475ea88a404fad03373",
  frontMindVersion: "2.7.0",
  // sha256("frontmind:siteops:2.7.0:runtime-selection-v6")
  runtimeManifestSha256:
    "6b45bfbf91e499876a1e545c4c041e3b070c4aa768db4570790d6c1e0655d924",
  starterVersion: "twenty-first-native-template-v1",
  // sha256("frontmind:siteops:2.7.0:starter")
  starterSha256:
    "9e45cd2d7e5e98aa461f692610dba397a1e1ecba21bac947dd789ac7c2f7b77a",
  componentLibraryVersion: "twenty-first-native-template-v1",
  materializerVersion: "2.7.0",
  // sha256("frontmind:siteops:2.7.0:materializer")
  materializerSha256:
    "59eb18e00212ca12906cef99ea02abc3c6b1cb0cd5d78c17221ecc69bfd47137",
  qaPolicyVersion: "siteops-native-qa-v1",
} as const;

/** Static Template Catalog 2.8 freezes one FrontMind-owned catalog of 32
 * complete Template archives. Customer visual-search operations only bind
 * the immutable catalog coordinates; no provider lookup, download, candidate
 * compilation or source archive is embedded in the customer selection page. */
export const SITEOPS_MATERIALIZER_V2_8 = {
  upstreamVersion: "frontmind-static-catalog-v1",
  upstreamSha256:
    "772d8938e73213f505dbd7b078a61f2bed9351262d3a429d31a8621b3cc0ce4f",
  frontMindVersion: "2.8.0",
  runtimeManifestSha256:
    "c846027250d6519860a9458696e3e185a2bb14b7863be58b88afb367293983f9",
  starterVersion: "frontmind-static-catalog-v1",
  starterSha256:
    "d7a87a67ecb83fc89320c59c97070c18c23af49fa5dde7bbe14f177e2f4e898e",
  componentLibraryVersion: "frontmind-static-catalog-v1",
  materializerVersion: "2.8.0",
  materializerSha256:
    "806e2e87226f454ad6344f2e14d687f997d9716783536a336757113641ec26ce",
  qaPolicyVersion: "siteops-native-qa-v1",
} as const;

/** Dynamic Information Architecture 2.9 retains the admitted static template
 * catalog while moving page selection to a source-bound Manus content plan.
 * Historical 2.8 builds remain registered against their original bytes. */
export const SITEOPS_MATERIALIZER_V2_9 = {
  upstreamVersion: "frontmind-static-catalog-v1",
  upstreamSha256:
    "84dfe4652fb1aa9f3ff31e3b3515dec1361c7cd9191e656aa3c5f39d9554d4ca",
  frontMindVersion: "2.9.0",
  runtimeManifestSha256:
    "2e4ed3b5fda75794e84cc12c68db53fdd20e34cee2e57913a44027d052affba9",
  starterVersion: "frontmind-static-catalog-v1",
  starterSha256:
    "35bce4f24d8498cbb508ab1fcf777ca43503fa59e32c58d4265535d665cf2644",
  componentLibraryVersion: "frontmind-static-catalog-v1",
  materializerVersion: "2.9.0",
  materializerSha256:
    "67de87d7364f498891e4b7245995261a790c247e6a2b11f1e2406f943eb4ea37",
  qaPolicyVersion: "siteops-native-qa-v2-dynamic-ia",
} as const;

/** Current host-owned renderer. Historical 2.6 builds and the explicitly
 * labelled native fallback keep using these immutable coordinates. */
export const SITEOPS_WORKFLOW = SITEOPS_MATERIALIZER_V2_6;

/** Workflow frozen for every newly admitted/reset SiteOps root. */
export const SITEOPS_DEFAULT_WORKFLOW = SITEOPS_MATERIALIZER_V2_9;

export const SITEOPS_WORKFLOWS_BY_VERSION = {
  [SITEOPS_MATERIALIZER_V1_2.frontMindVersion]: SITEOPS_MATERIALIZER_V1_2,
  [SITEOPS_MATERIALIZER_V1_3.frontMindVersion]: SITEOPS_MATERIALIZER_V1_3,
  [SITEOPS_MATERIALIZER_V1_4.frontMindVersion]: SITEOPS_MATERIALIZER_V1_4,
  [SITEOPS_MATERIALIZER_V1_5.frontMindVersion]: SITEOPS_MATERIALIZER_V1_5,
  [SITEOPS_MATERIALIZER_V1_6.frontMindVersion]: SITEOPS_MATERIALIZER_V1_6,
  [SITEOPS_MATERIALIZER_V2_0.frontMindVersion]: SITEOPS_MATERIALIZER_V2_0,
  [SITEOPS_MATERIALIZER_V2_1.frontMindVersion]: SITEOPS_MATERIALIZER_V2_1,
  [SITEOPS_MATERIALIZER_V2_2.frontMindVersion]: SITEOPS_MATERIALIZER_V2_2,
  [SITEOPS_MATERIALIZER_V2_3.frontMindVersion]: SITEOPS_MATERIALIZER_V2_3,
  [SITEOPS_MATERIALIZER_V2_4.frontMindVersion]: SITEOPS_MATERIALIZER_V2_4,
  [SITEOPS_MATERIALIZER_V2_5.frontMindVersion]: SITEOPS_MATERIALIZER_V2_5,
  [SITEOPS_MATERIALIZER_V2_6.frontMindVersion]: SITEOPS_MATERIALIZER_V2_6,
  [SITEOPS_MATERIALIZER_V2_7.frontMindVersion]: SITEOPS_MATERIALIZER_V2_7,
  [SITEOPS_MATERIALIZER_V2_8.frontMindVersion]: SITEOPS_MATERIALIZER_V2_8,
  [SITEOPS_MATERIALIZER_V2_9.frontMindVersion]: SITEOPS_MATERIALIZER_V2_9,
} as const;

// Fail at module load if any current or historical registry entry crosses the
// shared persisted/runtime coordinate boundary.
for (const workflow of Object.values(SITEOPS_WORKFLOWS_BY_VERSION)) {
  parseSiteOpsPersistedWorkflowCoordinates({
    upstreamVersion: workflow.upstreamVersion,
    frontMindVersion: workflow.frontMindVersion,
    starterVersion: workflow.starterVersion,
    componentLibraryVersion: workflow.componentLibraryVersion,
  });
}

export function siteOpsWorkflowForVersion(version: string) {
  const workflow =
    SITEOPS_WORKFLOWS_BY_VERSION[
      version as keyof typeof SITEOPS_WORKFLOWS_BY_VERSION
    ];
  if (!workflow)
    throw new Error(`SITEOPS_WORKFLOW_VERSION_UNSUPPORTED:${version}`);
  return workflow;
}

export const siteOpsProjectStatusSchema = z.enum([
  "draft",
  "collecting_brief",
  "visual_searching",
  "awaiting_visual_selection",
  "building",
  "preview_ready",
  "approved",
  "live",
  "attention_required",
  "failed",
  "cancelled",
]);

export const siteOpsOperationKindSchema = z.enum([
  "brief_message",
  "visual_search",
  "site_build",
  "build_revision",
  "deploy",
  "rollback",
  "social_package",
  "domain_sync",
  "dns_apply",
  "dns_rollback",
]);

export const siteOpsOperationStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "outcome_unknown",
  "attention_required",
  "cancelled",
]);

export const siteOpsBuildStatusSchema = z.enum([
  "preparing",
  "visual_searching",
  "awaiting_visual_selection",
  "design_compiling",
  "contract_ready",
  "building",
  "qa_running",
  "preview_ready",
  "approved",
  "failed",
  "attention_required",
  "cancelled",
  "superseded",
]);

export const siteOpsCardKindSchema = z.enum([
  "brief_question",
  "visual_board",
  "visual_choice",
  "build_progress",
  "build_preview",
  "qa_failed",
  "publish_options",
  "domain_status",
  "icp_status",
  "content_review",
  "social_package",
  "release_status",
]);

export const siteOpsNativeVisualFailureCategorySchema = z.enum([
  "provider_quota",
  "get_component_contract",
  "source_incomplete",
  "dependency_unsupported",
  "source_unsafe",
  "compile_failed",
  "browser_unavailable",
  "render_failed",
  "deadline_exhausted",
]);

export type SiteOpsNativeVisualFailureCategory = z.infer<
  typeof siteOpsNativeVisualFailureCategorySchema
>;

/**
 * Failures emitted by the complete-template visual workflow. Keep this
 * separate from the V5 component-source categories so cached observations and
 * immutable operation results remain readable during the rolling upgrade.
 */
export const siteOpsNativeTemplateFailureCategorySchema = z.enum([
  "catalog_unavailable",
  "entitlement_required",
  "download_failed",
  "dependency_unsupported",
  "source_unsafe",
  "compile_failed",
  "browser_unavailable",
  "render_failed",
  "deadline_exhausted",
  "insufficient_live_templates",
]);

export type SiteOpsNativeTemplateFailureCategory = z.infer<
  typeof siteOpsNativeTemplateFailureCategorySchema
>;

/** Rolling public compatibility across source-backed V5 and template V6. */
export const siteOpsVisualFailureCategorySchema = z.union([
  siteOpsNativeTemplateFailureCategorySchema,
  siteOpsNativeVisualFailureCategorySchema,
  z.literal("persistence_failed"),
]);

export type SiteOpsVisualFailureCategory = z.infer<
  typeof siteOpsVisualFailureCategorySchema
>;

export const siteOpsCardSchema = z
  .object({
    kind: siteOpsCardKindSchema,
    subjectId: z.string().trim().min(1).max(191),
    revision: z.number().int().positive(),
    status: z.enum(["active", "resolved", "expired"]),
    payload: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const siteContentInventoryKindSchema = z.enum([
  "product",
  "service",
  "application",
  "case_study",
  "blog",
  "company_news",
  "faq",
]);

/** Dashboard-owned inventory derived only from customer-visible documents in
 * the frozen knowledge snapshot. Absence is meaningful: the materializer may
 * omit a collection route, or render the legal company-news empty state, but
 * it may never fill a gap with externally acquired or synthetic content. */
export const siteContentInventorySchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.literal("frozen_knowledge_snapshot"),
    entries: z
      .array(
        z
          .object({
            kind: siteContentInventoryKindSchema,
            sourceDocumentIds: z
              .array(z.string().trim().min(1).max(191))
              .min(1)
              .max(100),
          })
          .strict(),
      )
      .max(7),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.entries.map((entry) => entry.kind)).size !==
      value.entries.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["entries"],
        message: "Content inventory kinds must be unique",
      });
    }
  });

export const siteBriefSchema = z
  .object({
    companyName: z.string().trim().min(1).max(255),
    primaryLanguage: z.literal("zh-CN").or(z.string().trim().min(2).max(32)),
    contacts: z
      .array(
        z
          .object({
            kind: z.enum(["email", "phone", "address"]),
            value: z.string().trim().min(1).max(512),
            sourceDocumentIds: z.array(z.string().max(191)).max(20).default([]),
          })
          .strict(),
      )
      .max(20)
      .default([]),
    offerings: z.array(z.string().trim().min(1).max(500)).max(50),
    audience: z.array(z.string().trim().min(1).max(500)).max(30),
    conversionGoal: z.string().trim().min(1).max(500),
    contentInventory: siteContentInventorySchema.default({
      schemaVersion: 1,
      source: "frozen_knowledge_snapshot",
      entries: [],
    }),
    routes: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(64),
            slug: z.string().trim().min(1).max(191),
            title: z.string().trim().min(1).max(255),
            sourceDocumentIds: z.array(z.string().max(191)).max(100),
          })
          .strict(),
      )
      .min(1)
      .max(30),
    verifiedFacts: z
      .array(
        z
          .object({
            statement: z.string().trim().min(1).max(2_000),
            sourceDocumentIds: z.array(z.string().max(191)).min(1).max(50),
          })
          .strict(),
      )
      .max(200),
    publicAssetIds: z.array(z.string().max(191)).max(100).default([]),
    unknowns: z.array(z.string().trim().min(1).max(500)).max(50).default([]),
  })
  .strict();

export const visualTaxonomySchema = z
  .object({
    role: z.enum(["foundation", "section", "motion"]),
    palette: z.array(z.string().trim().min(1).max(64)).max(12).default([]),
    typography: z.array(z.string().trim().min(1).max(128)).max(12).default([]),
    layout: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    motion: z.array(z.string().trim().min(1).max(128)).max(20).default([]),
    accessibility: z
      .array(z.string().trim().min(1).max(128))
      .max(20)
      .default([]),
  })
  .strict();

export const visualEvidenceV1Schema = z
  .object({
    evidenceKind: z.literal("catalog_metadata_preview_v1"),
    providerItemKey: z
      .string()
      .trim()
      .min(3)
      .max(514)
      .regex(/^(?:n:[1-9]\d*|s:.+)$/u),
    metadataSha256: z.string().regex(/^[a-f0-9]{64}$/),
    providerResponseSha256: z.string().regex(/^[a-f0-9]{64}$/),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomyDerivationVersion: z.literal("catalog-metadata-preview-v1"),
    evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE = 9;
export const SITEOPS_VISUAL_CANDIDATE_MAX_PAGES = 3;
export const SITEOPS_VISUAL_CANDIDATE_MAX_TOTAL =
  SITEOPS_VISUAL_CANDIDATE_PAGE_SIZE * SITEOPS_VISUAL_CANDIDATE_MAX_PAGES;

export const visualCandidateSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-I]$/),
    providerItemKey: z.string().trim().min(3).max(514),
    visualEvidence: visualEvidenceV1Schema,
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomy: visualTaxonomySchema,
    score: z.number().finite().min(0).max(100),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerItemKey !== value.visualEvidence.providerItemKey) {
      context.addIssue({
        code: "custom",
        path: ["visualEvidence", "providerItemKey"],
        message: "Visual evidence provider item does not match candidate",
      });
    }
    if (value.previewSha256 !== value.visualEvidence.previewSha256) {
      context.addIssue({
        code: "custom",
        path: ["visualEvidence", "previewSha256"],
        message: "Visual evidence preview does not match candidate",
      });
    }
  });

export const visualSelectionBundleV1Schema = z
  .object({
    queryHash: z.string().regex(/^[a-f0-9]{64}$/),
    searchTarget: z.literal(18),
    detailTarget: z.literal(12),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateSchema).min(1).max(9),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict();

export const visualQueryAxisSchema = z.enum([
  "foundation_split",
  "foundation_editorial_modular",
  "section_proof_conversion",
  "motion_accessible",
]);

const visualCandidateV2BaseSchema = z
  .object({
    id: z.string().trim().min(1).max(191),
    queryAxis: visualQueryAxisSchema,
    providerItemKey: z.string().trim().min(3).max(514),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(300).nullable(),
    author: z.string().trim().min(1).max(300).nullable(),
    sourceUrl: z.string().url().max(2_048).nullable(),
    visualEvidence: visualEvidenceV1Schema,
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
    taxonomy: visualTaxonomySchema,
    score: z.number().finite().min(0).max(100),
    rationale: z.string().trim().min(1).max(2_000),
  })
  .strict();

function expectedRoleForVisualAxis(
  axis: z.infer<typeof visualQueryAxisSchema>,
) {
  if (axis.startsWith("foundation_")) return "foundation" as const;
  if (axis.startsWith("section_")) return "section" as const;
  return "motion" as const;
}

function validateVisualCandidateCoordinates(
  value: z.infer<typeof visualCandidateV2BaseSchema>,
  context: z.RefinementCtx,
) {
  if (value.providerItemKey !== value.visualEvidence.providerItemKey) {
    context.addIssue({
      code: "custom",
      path: ["visualEvidence", "providerItemKey"],
      message: "Visual evidence provider item does not match candidate",
    });
  }
  if (value.previewSha256 !== value.visualEvidence.previewSha256) {
    context.addIssue({
      code: "custom",
      path: ["visualEvidence", "previewSha256"],
      message: "Visual evidence preview does not match candidate",
    });
  }
  if (value.taxonomy.role !== expectedRoleForVisualAxis(value.queryAxis)) {
    context.addIssue({
      code: "custom",
      path: ["taxonomy", "role"],
      message: "Visual taxonomy role does not match query axis",
    });
  }
}

export const visualCandidateV2Schema = visualCandidateV2BaseSchema
  .extend({ label: z.string().regex(/^[A-I]$/) })
  .strict()
  .superRefine(validateVisualCandidateCoordinates);

export const visualSupportingCandidateV2Schema =
  visualCandidateV2BaseSchema.superRefine(validateVisualCandidateCoordinates);

export const visualSelectionBundleV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    queryPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    searchTarget: z.literal(18),
    shortlistTarget: z.literal(12),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateV2Schema).min(1).max(9),
    supportingCandidates: z
      .array(visualSupportingCandidateV2Schema)
      .max(2)
      .default([]),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const labels = new Set<string>();
    for (const candidate of value.candidates) {
      if (labels.has(candidate.label)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", "label"],
          message: "Visual candidate labels must be unique",
        });
      }
      labels.add(candidate.label);
    }
    const ids = new Set<string>();
    const providerKeys = new Set<string>();
    const assetIds = new Set<string>();
    const evidenceHashes = new Set<string>();
    for (const candidate of [
      ...value.candidates,
      ...value.supportingCandidates,
    ]) {
      for (const [collection, coordinate, path] of [
        [ids, candidate.id, "id"],
        [providerKeys, candidate.providerItemKey, "providerItemKey"],
        [assetIds, candidate.previewLocalAssetId, "previewLocalAssetId"],
        [
          evidenceHashes,
          candidate.visualEvidence.evidenceSha256,
          "visualEvidence.evidenceSha256",
        ],
      ] as const) {
        if (collection.has(coordinate)) {
          context.addIssue({
            code: "custom",
            path: [path],
            message: "Visual selection coordinates must be unique",
          });
        }
        collection.add(coordinate);
      }
    }
    if (
      value.selectedCandidateId !== null &&
      !value.candidates.some(
        (candidate) => candidate.id === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected visual candidate is absent",
      });
    }
  });

const visualHeroFamilyV3Schema = z.enum([
  "floating_orbit",
  "split_media",
  "editorial",
  "bento",
  "feature_grid",
  "centered_dual_cta",
  "immersive_visual",
  "product_stage",
  "full_bleed_statement",
]);

/** Artifact-side mirror of ReferenceBlueprintV3. The design contract performs
 * its canonical hash validation; the selection artifact additionally binds it
 * to the exact candidate, local preview and inspiration hashes. */
export const visualReferenceBlueprintV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    candidateId: z.string().trim().min(1).max(191),
    providerItemKey: z
      .string()
      .trim()
      .min(3)
      .max(514)
      .regex(/^(?:n:[1-9]\d*|s:.+)$/u),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    previewLocalAssetId: z.string().uuid(),
    heroFamily: visualHeroFamilyV3Schema,
    alignment: z.enum(["left", "center", "right"]),
    contentEmphasis: z.enum(["statement", "balanced", "product", "proof"]),
    mediaRegion: z.enum(["none", "inline", "split", "surround", "full_bleed"]),
    mediaRatio: z.enum(["none", "square", "portrait", "landscape", "wide"]),
    composition: z.enum([
      "centered",
      "split",
      "editorial",
      "modular",
      "immersive",
    ]),
    backgroundStyle: z.enum([
      "warm_light",
      "cool_light",
      "dark",
      "gradient",
      "image_stage",
    ]),
    gradientStyle: z.enum(["none", "soft_radial", "mesh", "spotlight"]),
    borderStyle: z.enum(["none", "subtle", "defined"]),
    radiusStyle: z.enum(["none", "soft", "rounded", "pill"]),
    decorationStyle: z.enum([
      "none",
      "orbital",
      "grid",
      "glow",
      "editorial_lines",
    ]),
    navStyle: z.enum(["minimal", "floating", "bordered"]),
    ctaStyle: z.enum(["single", "dual", "pill", "text_link"]),
    cardStyle: z.enum(["flat", "bordered", "soft_depth", "layered"]),
    containerStyle: z.enum(["contained", "wide", "edge_to_edge"]),
    typographyStyle: z.enum([
      "restrained",
      "editorial",
      "display",
      "technical",
    ]),
    density: z.enum(["compact", "balanced", "spacious"]),
    responsiveBehavior: z.enum(["stack", "reflow", "crop_safe"]),
    motionLevel: z.enum(["none", "subtle", "floating_subtle"]),
    mediaStrategy: z.enum(["customer_asset", "procedural_brand_svg", "none"]),
    palette: z
      .object({
        canvas: z.string().regex(/^#[a-f0-9]{6}$/u),
        ink: z.string().regex(/^#[a-f0-9]{6}$/u),
        accent: z.string().regex(/^#[a-f0-9]{6}$/u),
        muted: z.string().regex(/^#[a-f0-9]{6}$/u),
      })
      .strict(),
    typeSystem: z.enum([
      "display_sans",
      "editorial_serif",
      "technical_sans",
      "humanist_sans",
    ]),
    componentManifest: z.array(z.string().trim().min(1).max(96)).min(2).max(16),
    inspirationEvidenceIds: z
      .array(z.string().regex(/^[a-f0-9]{64}$/u))
      .min(1)
      .max(3),
    blueprintHash: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const visualCandidateV3Schema = visualCandidateV2BaseSchema
  .extend({
    label: z.string().regex(/^[A-I]$/u),
    referenceBlueprint: visualReferenceBlueprintV3Schema,
  })
  .strict()
  .superRefine((value, context) => {
    validateVisualCandidateCoordinates(value, context);
    if (
      value.referenceBlueprint.candidateId !== value.id ||
      value.referenceBlueprint.providerItemKey !== value.providerItemKey ||
      value.referenceBlueprint.previewLocalAssetId !==
        value.previewLocalAssetId ||
      value.referenceBlueprint.previewSha256 !== value.previewSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceBlueprint"],
        message: "V3 blueprint does not match its host-rendered candidate",
      });
    }
  });

export const visualSelectionBundleV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    queryPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
    searchTarget: z.literal(18),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateV3Schema).length(9),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = (coordinates: string[], path: string) => {
      if (new Set(coordinates).size !== coordinates.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `V3 visual ${path} coordinates must be unique`,
        });
      }
    };
    unique(
      value.candidates.map((candidate) => candidate.id),
      "candidateId",
    );
    unique(
      value.candidates.map((candidate) => candidate.label),
      "label",
    );
    unique(
      value.candidates.map((candidate) => candidate.previewLocalAssetId),
      "previewLocalAssetId",
    );
    unique(
      value.candidates.map((candidate) => candidate.previewSha256),
      "previewSha256",
    );
    unique(
      value.candidates.map(
        (candidate) => candidate.referenceBlueprint.heroFamily,
      ),
      "heroFamily",
    );
    if (
      value.selectedCandidateId !== null &&
      !value.candidates.some(
        (candidate) => candidate.id === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected visual candidate is absent",
      });
    }
  });

/** V4 keeps the provider's immutable 21st preview as the customer-facing
 * reference while binding a separate host-rendered realization to the exact
 * trusted component blueprint. One reference may influence exactly one
 * candidate; no global theme projection is permitted. */
export const visualReferenceBlueprintV4Schema = visualReferenceBlueprintV3Schema
  .omit({ schemaVersion: true })
  .extend({
    schemaVersion: z.literal(4),
    referencePreviewLocalAssetId: z.string().uuid(),
    referencePreviewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    inspirationTaxonomySha256: z.string().regex(/^[a-f0-9]{64}$/u),
    styleSignature: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

function visualHashHammingDistance(left: string, right: string) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    let bits =
      Number.parseInt(left[index]!, 16) ^ Number.parseInt(right[index]!, 16);
    while (bits > 0) {
      distance += bits & 1;
      bits >>>= 1;
    }
  }
  return distance;
}

export const visualCandidateV4Schema = visualCandidateV2BaseSchema
  .extend({
    label: z.string().regex(/^[A-I]$/u),
    realizationPreviewLocalAssetId: z.string().uuid(),
    realizationPreviewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    referencePerceptualHash: z.string().regex(/^[a-f0-9]{16}$/u),
    realizationPerceptualHash: z.string().regex(/^[a-f0-9]{16}$/u),
    referenceBlueprint: visualReferenceBlueprintV4Schema,
  })
  .strict()
  .superRefine((value, context) => {
    validateVisualCandidateCoordinates(value, context);
    if (value.providerItemKey.startsWith("s:frontmind:")) {
      context.addIssue({
        code: "custom",
        path: ["providerItemKey"],
        message: "V4 candidates must bind a real provider item",
      });
    }
    if (
      value.referenceBlueprint.candidateId !== value.id ||
      value.referenceBlueprint.providerItemKey !== value.providerItemKey ||
      value.referenceBlueprint.referencePreviewLocalAssetId !==
        value.previewLocalAssetId ||
      value.referenceBlueprint.referencePreviewSha256 !== value.previewSha256 ||
      value.referenceBlueprint.previewLocalAssetId !==
        value.realizationPreviewLocalAssetId ||
      value.referenceBlueprint.previewSha256 !==
        value.realizationPreviewSha256 ||
      value.referenceBlueprint.inspirationEvidenceIds.length !== 1 ||
      value.referenceBlueprint.inspirationEvidenceIds[0] !==
        value.visualEvidence.evidenceSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["referenceBlueprint"],
        message:
          "V4 blueprint does not close over its reference and realization",
      });
    }
  });

export const visualSelectionBundleV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    queryPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
    // Nine base queries at the live limit (up to eighteen) plus at most nine
    // Hall-deficiency rescue queries at that same limit. Persist the truthful
    // effective search budget rather than a truncated legacy target.
    searchTarget: z.number().int().min(9).max(324),
    referenceTarget: z.literal(9),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateV4Schema).length(9),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = (coordinates: string[], path: string) => {
      if (new Set(coordinates).size !== coordinates.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `V4 visual ${path} coordinates must be unique`,
        });
      }
    };
    const candidates = value.candidates;
    unique(
      candidates.map((candidate) => candidate.id),
      "candidateId",
    );
    unique(
      candidates.map((candidate) => candidate.label),
      "label",
    );
    unique(
      candidates.map((candidate) => candidate.providerItemKey),
      "providerItemKey",
    );
    unique(
      candidates.map((candidate) => candidate.previewLocalAssetId),
      "referencePreviewLocalAssetId",
    );
    unique(
      candidates.map((candidate) => candidate.previewSha256),
      "referencePreviewSha256",
    );
    unique(
      candidates.map((candidate) => candidate.visualEvidence.evidenceSha256),
      "evidenceSha256",
    );
    unique(
      candidates.map((candidate) => candidate.realizationPreviewLocalAssetId),
      "realizationPreviewLocalAssetId",
    );
    unique(
      candidates.map((candidate) => candidate.realizationPreviewSha256),
      "realizationPreviewSha256",
    );
    unique(
      candidates.map((candidate) => candidate.referenceBlueprint.heroFamily),
      "heroFamily",
    );
    unique(
      candidates.map(
        (candidate) => candidate.referenceBlueprint.styleSignature,
      ),
      "styleSignature",
    );
    unique(
      candidates.map((candidate) => candidate.referenceBlueprint.blueprintHash),
      "blueprintHash",
    );

    const paletteFingerprints = new Set(
      candidates.map(({ referenceBlueprint: blueprint }) =>
        [
          blueprint.palette.canvas,
          blueprint.palette.ink,
          blueprint.palette.accent,
          blueprint.palette.muted,
        ].join(":"),
      ),
    );
    for (const [coordinate, actual, minimum] of [
      [
        "backgroundStyle",
        new Set(
          candidates.map(
            (candidate) => candidate.referenceBlueprint.backgroundStyle,
          ),
        ).size,
        3,
      ],
      [
        "typeSystem",
        new Set(
          candidates.map(
            (candidate) => candidate.referenceBlueprint.typeSystem,
          ),
        ).size,
        3,
      ],
      [
        "composition",
        new Set(
          candidates.map(
            (candidate) => candidate.referenceBlueprint.composition,
          ),
        ).size,
        4,
      ],
      ["palette", paletteFingerprints.size, 4],
    ] as const) {
      if (actual < minimum) {
        context.addIssue({
          code: "custom",
          path: ["candidates"],
          message: `V4 visual diversity requires at least ${minimum} ${coordinate} variants`,
        });
      }
    }

    for (let left = 0; left < candidates.length; left += 1) {
      for (let right = left + 1; right < candidates.length; right += 1) {
        if (
          visualHashHammingDistance(
            candidates[left]!.referencePerceptualHash,
            candidates[right]!.referencePerceptualHash,
          ) < 6
        ) {
          context.addIssue({
            code: "custom",
            path: ["candidates", right, "referencePerceptualHash"],
            message: "V4 provider references are perceptually too similar",
          });
        }
        if (
          visualHashHammingDistance(
            candidates[left]!.realizationPerceptualHash,
            candidates[right]!.realizationPerceptualHash,
          ) < 4
        ) {
          context.addIssue({
            code: "custom",
            path: ["candidates", right, "realizationPerceptualHash"],
            message: "V4 realizations are perceptually too similar",
          });
        }
      }
    }
    if (
      value.selectedCandidateId !== null &&
      !candidates.some(
        (candidate) => candidate.id === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected visual candidate is absent",
      });
    }
  });

/**
 * V5 is the first source-backed visual contract. The customer-facing preview
 * is rendered from the exact frozen React source archive; the provider's
 * catalog preview remains separate evidence and is never substituted for the
 * local render. The manifest lives inside a bounded application/zip artifact
 * together with one nested source archive per candidate.
 */
export const visualCandidateV5Schema = visualCandidateV2BaseSchema
  .omit({ previewLocalAssetId: true, previewSha256: true })
  .extend({
    label: z.string().regex(/^[A-I]$/u),
    providerItemId: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    referencePreviewLocalAssetId: z.string().uuid(),
    referencePreviewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    referencePerceptualHash: z.string().regex(/^[a-f0-9]{16}$/u),
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchivePath: z.string().regex(/^candidates\/[A-I]\/source\.zip$/u),
    entrypoint: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[cm]?[jt]sx?$/u),
    demoEntrypoint: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .regex(/^(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+\.[cm]?[jt]sx?$/u),
    sourceDirectory: z.literal("source"),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.providerItemKey !== value.visualEvidence.providerItemKey) {
      context.addIssue({
        code: "custom",
        path: ["visualEvidence", "providerItemKey"],
        message: "V5 provider evidence does not match candidate",
      });
    }
    if (value.referencePreviewSha256 !== value.visualEvidence.previewSha256) {
      context.addIssue({
        code: "custom",
        path: ["visualEvidence", "previewSha256"],
        message: "V5 provider evidence does not match reference preview",
      });
    }
    if (value.taxonomy.role !== expectedRoleForVisualAxis(value.queryAxis)) {
      context.addIssue({
        code: "custom",
        path: ["taxonomy", "role"],
        message: "V5 visual taxonomy role does not match query axis",
      });
    }
    if (value.sourceArchivePath !== `candidates/${value.label}/source.zip`) {
      context.addIssue({
        code: "custom",
        path: ["sourceArchivePath"],
        message: "V5 source archive path does not match candidate label",
      });
    }
  });

export const visualSelectionBundleV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    renderer: z.literal("twenty_first_native_react_v1"),
    queryPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
    searchTarget: z.number().int().min(9).max(324),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateV5Schema).length(9),
    selectedCandidateId: z.string().max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = (coordinates: string[], path: string) => {
      if (new Set(coordinates).size !== coordinates.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `V5 visual ${path} coordinates must be unique`,
        });
      }
    };
    unique(
      value.candidates.map((candidate) => candidate.id),
      "candidateId",
    );
    unique(
      value.candidates.map((candidate) => candidate.label),
      "label",
    );
    unique(
      value.candidates.map((candidate) => candidate.providerItemKey),
      "providerItemKey",
    );
    unique(
      value.candidates.map((candidate) => candidate.referencePreviewSha256),
      "referencePreviewSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.previewSha256),
      "previewSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.sourceTreeSha256),
      "sourceTreeSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.sourceArchivePath),
      "sourceArchivePath",
    );
    if (
      value.selectedCandidateId !== null &&
      !value.candidates.some(
        (candidate) => candidate.id === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected visual candidate is absent",
      });
    }
  });

const visualTemplateSourcePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(240)
  // Next.js route groups are filesystem-only coordinates such as
  // `src/app/(marketing)/page.tsx`; they do not create a URL segment. Keep
  // parentheses confined to a complete, static route-group segment so
  // dynamic, parallel and intercepting routes remain outside the contract.
  .regex(
    /^(?:[a-zA-Z0-9_.-]+|\([a-zA-Z0-9_-]+\))(?:\/(?:[a-zA-Z0-9_.-]+|\([a-zA-Z0-9_-]+\)))*$/u,
  )
  .refine(
    (value) =>
      !value.split("/").some((segment) => segment === "." || segment === ".."),
    "Template source path cannot traverse directories",
  );

/**
 * A small, host-derived style contract frozen beside a V6 candidate. The
 * preview contributes only bounded image statistics and the inert provider
 * archive contributes only enum-valued typography/spacing signals. No source
 * text, CSS token, provider URL or executable coordinate crosses this
 * boundary.
 */
export const visualCandidateStyleTokensV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    derivation: z.literal("normalized-preview-bounded-source-v1"),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    dominantHex: z.string().regex(/^#[a-f0-9]{6}$/u),
    canvasTone: z.enum(["light", "dark"]),
    contrast: z.enum(["low", "balanced", "high"]),
    typeSystem: z.enum([
      "display_sans",
      "editorial_serif",
      "technical_sans",
      "humanist_sans",
      "unknown",
    ]),
    density: z.enum(["compact", "balanced", "spacious"]),
  })
  .strict();

/**
 * V6 stores only the immutable coordinates needed to bind a locally rendered
 * preview to the exact complete 21st template source tree. Provider download
 * URLs, license receipts and archives stay inside the server artifact
 * boundary and are intentionally absent from the public/shared manifest.
 */
export const visualCandidateV6Schema = z
  .object({
    id: z.string().trim().min(1).max(191),
    sampleId: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-I]$/u),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(300).nullable(),
    author: z.string().trim().min(1).max(300).nullable(),
    previewLocalAssetId: z.string().uuid(),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    /** Added additively so historical V6 bundles remain readable. */
    previewPerceptualHash: z
      .string()
      .regex(/^[a-f0-9]{16}$/u)
      .optional(),
    /** Added additively so historical V6 bundles remain readable. */
    styleTokens: visualCandidateStyleTokensV1Schema.optional(),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z
      .string()
      .trim()
      .min(1)
      .max(191)
      .regex(/^[a-zA-Z0-9]+(?:[._\/-][a-zA-Z0-9]+)*$/u),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceFormat: z
      .enum(["normalized_v1", "provider_archive_v1"])
      .default("normalized_v1"),
    framework: z.enum(["vite_react", "next_static"]),
    sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchivePath: z.string().regex(/^candidates\/[A-I]\/source\.zip$/u),
    sourceDirectory: visualTemplateSourcePathSchema,
    entrypoint: visualTemplateSourcePathSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== value.sampleId) {
      context.addIssue({
        code: "custom",
        path: ["sampleId"],
        message: "V6 sample ID must match the canonical candidate ID",
      });
    }
    if (value.sourceArchivePath !== `candidates/${value.label}/source.zip`) {
      context.addIssue({
        code: "custom",
        path: ["sourceArchivePath"],
        message: "V6 source archive path does not match candidate label",
      });
    }
    if (
      value.styleTokens &&
      value.styleTokens.previewSha256 !== value.previewSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["styleTokens", "previewSha256"],
        message: "V6 style tokens do not match the immutable preview",
      });
    }
    if (
      value.styleTokens &&
      value.styleTokens.sourceTreeSha256 !== value.sourceTreeSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["styleTokens", "sourceTreeSha256"],
        message: "V6 style tokens do not match the immutable source tree",
      });
    }
  });

export const visualSelectionBundleV6Schema = z
  .object({
    schemaVersion: z.literal(6),
    renderer: z.literal("twenty_first_native_template_v1"),
    queryPlanHash: z.string().regex(/^[a-f0-9]{64}$/u),
    displayTarget: z.literal(9),
    candidates: z.array(visualCandidateV6Schema).length(9),
    selectedCandidateId: z.string().trim().min(1).max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = (coordinates: string[], path: string) => {
      if (new Set(coordinates).size !== coordinates.length) {
        context.addIssue({
          code: "custom",
          path: ["candidates", path],
          message: `V6 visual ${path} coordinates must be unique`,
        });
      }
    };

    unique(
      value.candidates.map((candidate) => candidate.id),
      "id",
    );
    unique(
      value.candidates.map((candidate) => candidate.sampleId),
      "sampleId",
    );
    unique(
      value.candidates.map((candidate) => candidate.label),
      "label",
    );
    unique(
      value.candidates.map((candidate) => candidate.providerTemplateId),
      "providerTemplateId",
    );
    unique(
      value.candidates.map((candidate) => candidate.providerSlug),
      "providerSlug",
    );
    unique(
      value.candidates.map((candidate) => candidate.sourceTreeSha256),
      "sourceTreeSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.previewSha256),
      "previewSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.previewLocalAssetId),
      "previewLocalAssetId",
    );
    unique(
      value.candidates.map((candidate) => candidate.sourceArchiveSha256),
      "sourceArchiveSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.sourceArchivePath),
      "sourceArchivePath",
    );

    if (
      value.selectedCandidateId !== null &&
      !value.candidates.some(
        (candidate) => candidate.sampleId === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected V6 visual candidate is absent",
      });
    }
  });

/**
 * V7 is a lightweight view over the FrontMind-owned static Template catalog.
 * It deliberately contains only immutable asset/hash coordinates. Complete
 * source archives remain catalog assets and are read only after selection;
 * they are never copied into a per-page bundle.
 */
export const staticTemplateExecutionAdmissionEvidenceSchema =
  z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("admitted"),
        rawSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        normalizedSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        sourceTreeSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        runtimeContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        executionShellSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        deliveryContractSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        distSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        qaSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        browserReceiptSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        qaStatus: z.enum(["passed", "passed_with_warnings"]),
        admissionEvidenceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict(),
    z
      .object({
        status: z.literal("unavailable"),
        rawSourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        code: z.string().regex(/^[A-Z0-9_]{3,120}$/u),
        reason: z.string().trim().min(1).max(500),
      })
      .strict(),
  ]);

export const visualCandidateV7Schema = z
  .object({
    id: z.string().trim().min(1).max(191),
    sampleId: z.string().trim().min(1).max(191),
    label: z.string().regex(/^[A-H]$/u),
    title: z.string().trim().min(1).max(300),
    description: z.string().trim().min(1).max(1_000).nullable(),
    catalogVersion: z.string().trim().min(1).max(191),
    catalogPosition: z.number().int().min(1).max(32),
    catalogCandidateId: z.string().trim().min(1).max(191),
    providerTemplateId: z.string().trim().min(1).max(191),
    providerSlug: z.string().trim().min(1).max(191),
    providerVersion: z.string().trim().min(1).max(191).nullable(),
    sourceOwner: z.string().trim().min(1).max(191),
    sourceRepo: z.string().trim().min(1).max(191),
    sourceCommitSha: z.string().regex(/^[a-f0-9]{40}$/u),
    sourceSubdirectory: z.string().trim().min(1).max(1_024).nullable(),
    sourceLicense: z.enum(["MIT", "Apache-2.0"]),
    sourceAssetId: z.string().trim().min(1).max(512),
    sourceArchiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceArchiveBytes: z
      .number()
      .int()
      .positive()
      .max(192 * 1024 * 1024),
    previewAssetId: z.string().trim().min(1).max(512),
    previewSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    previewMimeType: z.enum([
      "image/avif",
      "image/jpeg",
      "image/png",
      "image/webp",
    ]),
    previewWidth: z.number().int().positive().max(50_000),
    previewHeight: z.number().int().positive().max(50_000),
    executionAdmission: staticTemplateExecutionAdmissionEvidenceSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.id !== value.sampleId) {
      context.addIssue({
        code: "custom",
        path: ["sampleId"],
        message: "V7 sample ID must match the canonical candidate ID",
      });
    }
    if (
      value.executionAdmission.status === "admitted" &&
      value.executionAdmission.normalizedSourceSha256 !==
        value.sourceArchiveSha256
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceArchiveSha256"],
        message: "V7 execution source hash must match its admission receipt",
      });
    }
  });

export const visualSelectionBundleV7Schema = z
  .object({
    schemaVersion: z.literal(7),
    renderer: z.literal("frontmind_static_template_catalog_v1"),
    workflowVersion: z.enum(["2.8.0", "2.9.0"]),
    catalogVersion: z.string().trim().min(1).max(191),
    pageNumber: z.number().int().min(1).max(4),
    pageSize: z.literal(8),
    pageCount: z.literal(4),
    displayTarget: z.literal(8),
    candidates: z.array(visualCandidateV7Schema).length(8),
    selectedCandidateId: z.string().trim().min(1).max(191).nullable(),
    delegated: z.boolean().default(false),
    degradedReasons: z.array(z.string().max(500)).max(30).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    const unique = (coordinates: string[], path: string) => {
      if (new Set(coordinates).size !== coordinates.length) {
        context.addIssue({
          code: "custom",
          path: ["candidates", path],
          message: `V7 visual ${path} coordinates must be unique`,
        });
      }
    };
    unique(
      value.candidates.map((candidate) => candidate.id),
      "id",
    );
    unique(
      value.candidates.map((candidate) => candidate.catalogCandidateId),
      "catalogCandidateId",
    );
    unique(
      value.candidates.map((candidate) => candidate.providerTemplateId),
      "providerTemplateId",
    );
    unique(
      value.candidates.map((candidate) => candidate.sourceArchiveSha256),
      "sourceArchiveSha256",
    );
    unique(
      value.candidates.map((candidate) => candidate.previewSha256),
      "previewSha256",
    );
    if (
      value.candidates.some(
        (candidate) =>
          candidate.catalogVersion !== value.catalogVersion ||
          Math.ceil(candidate.catalogPosition / value.pageSize) !==
            value.pageNumber,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["candidates"],
        message: "V7 candidates must belong to the frozen catalog page",
      });
    }
    if (
      value.selectedCandidateId !== null &&
      !value.candidates.some(
        (candidate) => candidate.sampleId === value.selectedCandidateId,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedCandidateId"],
        message: "Selected V7 visual candidate is absent",
      });
    }
  });

/** Immutable V1-V6 artifacts remain readable; the static catalog writes V7. */
export const visualSelectionBundleSchema = z.union([
  visualSelectionBundleV7Schema,
  visualSelectionBundleV6Schema,
  visualSelectionBundleV5Schema,
  visualSelectionBundleV4Schema,
  visualSelectionBundleV3Schema,
  visualSelectionBundleV2Schema,
  visualSelectionBundleV1Schema,
]);

export const buildContractV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    source: z
      .object({
        knowledgeSnapshotId: z.string().uuid(),
        archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
        sourceBuildId: z.string().max(191).nullable(),
        sourceBuildRevision: z.number().int().nonnegative().nullable(),
      })
      .strict(),
    workflow: z
      .object({
        upstreamSha256: z.string().regex(/^[a-f0-9]{64}$/),
        version: z.string().max(32),
        packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
        starterVersion: z.string().max(32),
      })
      .strict(),
    identity: z
      .object({
        companyName: z.string().min(1).max(255),
        primaryLanguage: z.string().min(2).max(32),
        verifiedContacts: z.array(z.string().max(512)).max(20),
      })
      .strict(),
    visual: z
      .object({
        queryHash: z.string().regex(/^[a-f0-9]{64}$/),
        selectedCandidateId: z.string().max(191),
        promptSha256: z.string().regex(/^[a-f0-9]{64}$/),
        previewSha256: z.string().regex(/^[a-f0-9]{64}$/),
        taxonomy: visualTaxonomySchema,
      })
      .strict(),
    routes: siteBriefSchema.shape.routes,
    assets: z
      .array(
        z
          .object({
            id: z.string().max(191),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            decision: z.enum(["publish", "omit", "quarantine"]),
          })
          .strict(),
      )
      .max(500),
    seo: z.record(z.string(), z.unknown()),
    target: z
      .object({
        environment: z.enum(["preview", "global_excluding_cn", "mainland_cn"]),
        canonicalOrigin: z.string().url().nullable(),
      })
      .strict(),
    qaPolicyVersion: z.string().max(64),
    specHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export const siteOpsOpenInputSchema = z.object({}).strict().optional();

export const siteOpsObserveInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    afterSequence: z.number().int().nonnegative().optional(),
  })
  .strict();

export const siteOpsAliyunConnectionInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
  })
  .strict();

export const siteOpsAliyunDomainSchema = z
  .object({
    domain: z.string().trim().min(1).max(255),
    displayDomain: z.string().trim().min(1).max(255),
  })
  .strict();

export const siteOpsAliyunDomainListSchema = z
  .object({
    domains: z.array(siteOpsAliyunDomainSchema).max(10_000),
  })
  .strict();

export const siteOpsSendMessageInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    clientRequestId: z.string().trim().min(8).max(128),
    text: z.string().trim().min(1).max(20_000),
    localAssetIds: z
      .array(z.string().regex(/^asset_[A-Za-z0-9_-]{1,185}$/u))
      .max(8)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "附件不能重复。",
      })
      .default([]),
    expectedProjectRevision: z.number().int().positive(),
  })
  .strict();

export const siteOpsActionSchema = z.enum([
  "request_rebuild",
  "select_snapshot",
  "start_visual_search",
  "reselect_visual",
  "select_visual",
  "delegate_visual",
  "approve_build",
  "request_revision",
  "publish_global",
  "publish_mainland",
  "rollback",
  "create_wechat_package",
  "create_xiaohongshu_package",
  "domain_sync",
]);

export const siteOpsActInputSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(191),
    messageId: z.string().trim().min(1).max(191).optional(),
    cardKind: siteOpsCardKindSchema.optional(),
    action: siteOpsActionSchema,
    clientRequestId: z.string().trim().min(8).max(128),
    expectedRevision: z.number().int().positive(),
    input: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export type SiteOpsCard = z.infer<typeof siteOpsCardSchema>;
export type SiteBrief = z.infer<typeof siteBriefSchema>;
export type SiteContentInventory = z.infer<typeof siteContentInventorySchema>;
export type VisualSelectionBundleV1 = z.infer<
  typeof visualSelectionBundleV1Schema
>;
export type VisualSelectionBundleV2 = z.infer<
  typeof visualSelectionBundleV2Schema
>;
export type VisualSelectionBundleV3 = z.infer<
  typeof visualSelectionBundleV3Schema
>;
export type VisualSelectionBundleV4 = z.infer<
  typeof visualSelectionBundleV4Schema
>;
export type VisualSelectionBundleV5 = z.infer<
  typeof visualSelectionBundleV5Schema
>;
export type VisualSelectionBundleV6 = z.infer<
  typeof visualSelectionBundleV6Schema
>;
export type VisualSelectionBundleV7 = z.infer<
  typeof visualSelectionBundleV7Schema
>;
export type VisualCandidateStyleTokensV1 = z.infer<
  typeof visualCandidateStyleTokensV1Schema
>;
export type VisualSelectionBundle = z.infer<typeof visualSelectionBundleSchema>;
export type BuildContractV1 = z.infer<typeof buildContractV1Schema>;
export type SiteOpsActInput = z.infer<typeof siteOpsActInputSchema>;
export type SiteOpsAliyunDomain = z.infer<typeof siteOpsAliyunDomainSchema>;
export type SiteOpsAliyunDomainList = z.infer<
  typeof siteOpsAliyunDomainListSchema
>;

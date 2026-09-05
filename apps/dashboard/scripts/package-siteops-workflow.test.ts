import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  SITEOPS_MATERIALIZER_V1_5,
  SITEOPS_MATERIALIZER_V1_6,
  SITEOPS_MATERIALIZER_V2_0,
  SITEOPS_MATERIALIZER_V2_1,
  SITEOPS_MATERIALIZER_V2_2,
  SITEOPS_MATERIALIZER_V2_3,
  SITEOPS_MATERIALIZER_V2_4,
  SITEOPS_MATERIALIZER_V2_6,
  SITEOPS_WORKFLOW,
} from "../shared/siteops";
import {
  SITEOPS_MATERIALIZER_VERSION,
  SITEOPS_RUNTIME_VERSION,
  SITEOPS_UPSTREAM_SHA256,
  createSiteOpsRuntimeManifest,
  verifySiteOpsRuntimeWorkflow,
  verifyUpstreamSiteOpsWorkflow,
} from "./package-siteops-workflow.mjs";

const workflowRoot = `private-workflows/react-static-company-site-workflow-v${SITEOPS_RUNTIME_VERSION}`;

describe("SiteOps runtime workflow package", () => {
  it("retains and verifies the exact read-only upstream 1.0.0 archive", async () => {
    await expect(verifyUpstreamSiteOpsWorkflow()).resolves.toEqual({
      archiveHash: SITEOPS_UPSTREAM_SHA256,
      files: 58,
    });
  });

  it("freezes the current deterministic FrontMind 2.6 host-patch workflow", async () => {
    const generated = await createSiteOpsRuntimeManifest();
    expect(generated).toMatchObject({
      version: "2.6.0",
      upstream: { archiveSha256: SITEOPS_UPSTREAM_SHA256 },
      host: {
        starterSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        componentLibraryVersion: "2.6.0",
        materializerVersion: SITEOPS_MATERIALIZER_VERSION,
        materializerSha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      },
    });
    await expect(verifySiteOpsRuntimeWorkflow()).resolves.toEqual(generated);

    const [runtimeBytes, manifestBytes, starterBytes] = await Promise.all([
      readFile(`${workflowRoot}/runtime-contract.json`, "utf8"),
      readFile(`${workflowRoot}/MANIFEST.json`),
      readFile(`${workflowRoot}/assets/host-starter-contract.json`, "utf8"),
    ]);
    const runtime = JSON.parse(runtimeBytes);
    expect(runtime).toMatchObject({
      schema: "frontmind-siteops-runtime/v9",
      adapterVersion: "2.6.0",
      aiTask: {
        taskCount: 1,
        stageCount: 1,
        output: "SiteContentPatchWireV1",
        outputSchema: "schemas/site-content-patch-wire-v1.schema.json",
        outputFilename: "frontmind-site-content-patch-v1.json",
        sourceOutputAllowed: false,
        designOutputAllowed: false,
        fullObjectRepairAllowed: false,
      },
      providerWire: {
        schema: "schemas/site-content-patch-wire-v1.schema.json",
        hostPatch: "SiteContentPatchV1",
        canonical: "CanonicalPreviewModelV1",
        canonicalizerOwner: "dashboard",
        routeCoordinatesAcceptedFromProvider: false,
        designCoordinatesAcceptedFromProvider: false,
      },
      hostDesign: {
        owner: "dashboard",
        factory: "createHostOwnedSiteDesignResultV2",
        output: "SiteDesignResultV2",
        routesAndPathsFrozen: true,
        slotsAndComponentsFrozen: true,
        responsiveLayoutFrozen: true,
        paletteFrozen: true,
      },
      renderer: {
        primary: "react_static_v2",
        fallback: "trusted_static_html_v1",
        componentLibraryVersion: "2.6.0",
        materializerVersion: "2.6.0",
      },
      contentSystem: {
        providerPatch: "SiteContentPatchV1",
        canonical: "CanonicalPreviewModelV1",
        missingContentPolicy: "verified-brief-fallback",
      },
      typedMaterialization: {
        schema: "schemas/materialization-stage-v3.schema.json",
        hostFailureRepairByAiAllowed: false,
      },
    });
    expect(runtime.aiTask).not.toHaveProperty("phaseOneOutput");
    expect(runtime.aiTask).not.toHaveProperty("phaseTwoOutput");
    expect(runtime.providerWire).not.toHaveProperty("phaseOneSchema");
    expect(runtime.providerWire).not.toHaveProperty("phaseTwoSchema");

    expect(JSON.parse(starterBytes)).toMatchObject({
      schema: "frontmind-siteops-host-starter/v5",
      version: "2.6.0",
      providerBoundary: {
        acceptedOutput: "SiteContentPatchWireV1",
        providerDesignAllowed: false,
        providerMarkupAllowed: false,
        providerExternalResourcesAllowed: false,
      },
      output: {
        routeDocuments: "every-frozen-route-plus-404",
        trustedFallback: "fixed-high-contrast-no-javascript",
      },
      qualityPolicy: {
        artifactSafetyAndBinding: "blocking",
        axeAndLighthouse: "warning",
        previewRequiredWhenEitherTrustedRendererSucceeds: true,
      },
    });

    expect(SITEOPS_WORKFLOW).toBe(SITEOPS_MATERIALIZER_V2_6);
    expect(SITEOPS_WORKFLOW).toMatchObject({
      frontMindVersion: "2.6.0",
      runtimeManifestSha256: createHash("sha256")
        .update(manifestBytes)
        .digest("hex"),
      starterVersion: "2.6.0",
      starterSha256: generated.host.starterSha256,
      materializerVersion: SITEOPS_MATERIALIZER_VERSION,
      materializerSha256: generated.host.materializerSha256,
      qaPolicyVersion: "siteops-qa-v5",
    });
  });

  it("ships a bounded slot patch wire and typed warning-aware materialization", async () => {
    const [patchBytes, stageBytes, envelopeBytes] = await Promise.all([
      readFile(
        `${workflowRoot}/schemas/site-content-patch-wire-v1.schema.json`,
        "utf8",
      ),
      readFile(
        `${workflowRoot}/schemas/materialization-stage-v3.schema.json`,
        "utf8",
      ),
      readFile(
        `${workflowRoot}/schemas/frontmind-run-envelope.schema.json`,
        "utf8",
      ),
    ]);
    const patch = JSON.parse(patchBytes) as {
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(patch.required.sort()).toEqual(
      [
        "wireSchemaVersion",
        "operationToken",
        "baseSourceSha256",
        "slots",
      ].sort(),
    );
    expect(patch.properties).not.toHaveProperty("source");
    expect(patch.properties).not.toHaveProperty("dependencies");
    expect(patch.properties).not.toHaveProperty("styles");
    expect(patchBytes).not.toContain("componentName");

    const stage = JSON.parse(stageBytes) as {
      properties: {
        phase: { enum: string[] };
        disposition: { enum: string[] };
      };
    };
    expect(stage.properties.phase.enum).toEqual([
      "wire_intake",
      "content_canonicalization",
      "palette_normalization",
      "primary_render",
      "fallback_render",
      "static_safety",
      "browser_qa",
      "artifact_persistence",
    ]);
    expect(stage.properties.disposition.enum).toEqual(["blocking", "warning"]);

    const envelope = JSON.parse(envelopeBytes) as {
      properties: {
        schemaVersion: unknown;
        workflow: { properties: Record<string, unknown> };
      };
    };
    expect(envelope.properties.schemaVersion).toEqual({ const: 9 });
    expect(envelope.properties.workflow.properties).toMatchObject({
      version: { const: "2.6.0" },
    });
  });

  it("retains immutable historical manifests, including 2.4", async () => {
    const coordinates = [
      [
        "private-workflows/astro-company-site-workflow-v1.5.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V1_5.runtimeManifestSha256,
      ],
      [
        "private-workflows/astro-company-site-workflow-v1.6.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V1_6.runtimeManifestSha256,
      ],
      [
        "private-workflows/react-static-company-site-workflow-v2.0.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V2_0.runtimeManifestSha256,
      ],
      [
        "private-workflows/react-static-company-site-workflow-v2.1.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V2_1.runtimeManifestSha256,
      ],
      [
        "private-workflows/react-static-company-site-workflow-v2.2.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V2_2.runtimeManifestSha256,
      ],
      [
        "private-workflows/react-static-company-site-workflow-v2.3.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V2_3.runtimeManifestSha256,
      ],
      [
        "private-workflows/react-static-company-site-workflow-v2.4.0/MANIFEST.json",
        SITEOPS_MATERIALIZER_V2_4.runtimeManifestSha256,
      ],
    ] as const;
    for (const [manifestPath, expectedSha256] of coordinates) {
      const manifest = await readFile(manifestPath);
      expect(createHash("sha256").update(manifest).digest("hex")).toBe(
        expectedSha256,
      );
    }
  });
});

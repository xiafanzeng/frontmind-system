// Generated from private-workflows/socratic-kb-builder/references/working-set-policy.json.
// Run `node scripts/generate-knowledge-base-working-set-policy.mjs` after changing the source.
// prettier-ignore
export const GENERATED_KNOWLEDGE_BASE_WORKING_SET_POLICY = {
  "schemaVersion": 1,
  "archive": {
    "maxCompressedBytes": 125829120,
    "maxUncompressedBytes": 125829120,
    "maxEntryCount": 1500,
    "maxCompressionRatio": 200,
    "maxAssetBytes": 20971520,
    "patchWarningLimit": 50
  },
  "evidence": {
    "textExtensions": [
      ".md",
      ".markdown",
      ".txt"
    ],
    "textMimeTypes": [
      "text/markdown",
      "text/plain"
    ],
    "optionalBinary": {
      "disposition": "drop",
      "warning": {
        "code": "OPTIONAL_BINARY_EVIDENCE_SKIPPED",
        "area": "evidence"
      }
    },
    "optionalInvalidText": {
      "disposition": "drop",
      "warning": {
        "code": "EVIDENCE_INCOMPLETE",
        "area": "evidence"
      }
    }
  },
  "authority": {
    "initial": {
      "hard": [
        "operationId",
        "archiveSafety",
        "manifestMultiplicity"
      ],
      "serverOwned": [
        "buildId",
        "generation",
        "contentVersion",
        "skill",
        "treePolicyVersion",
        "company"
      ]
    },
    "revision": {
      "hard": [
        "operationId",
        "baseWorkingSetSha256",
        "targetLeafId",
        "archiveSafety",
        "manifestMultiplicity",
        "removalOwnership",
        "frozenUploadBytes"
      ],
      "serverOwned": [
        "buildId",
        "generation",
        "baseContentVersion"
      ]
    }
  },
  "warnings": {
    "serverCoordinateNormalized": {
      "code": "SERVER_COORDINATE_NORMALIZED",
      "area": "manifest"
    },
    "evidenceIncomplete": {
      "code": "EVIDENCE_INCOMPLETE",
      "area": "evidence"
    },
    "optionalBinaryEvidenceSkipped": {
      "code": "OPTIONAL_BINARY_EVIDENCE_SKIPPED",
      "area": "evidence"
    },
    "optionalAssetSkipped": {
      "code": "OPTIONAL_ASSET_SKIPPED",
      "area": "assets"
    },
    "resultIncomplete": {
      "code": "RESULT_INCOMPLETE"
    },
    "presentationNormalized": {
      "code": "PRESENTATION_NORMALIZED"
    }
  }
} as const;

import { createHash } from "node:crypto";
import JSZip from "jszip";

class ProbeError extends Error {
  constructor(
    readonly code: string,
    readonly status?: number,
  ) {
    super(code);
  }
}

const serviceToken =
  process.env.FRONTMIND_PRESALES_SERVICE_TOKEN?.trim() || "";
const baseUrl =
  process.env.FRONTMIND_PRESALES_PROBE_BASE_URL?.trim() ||
  `http://127.0.0.1:${process.env.PORT || "3001"}/api/internal/presales/v2`;
const headers = {
  "x-frontmind-service-token": serviceToken,
};

async function errorCode(response: Response) {
  try {
    const body = (await response.json()) as {
      error?: { code?: unknown };
    };
    return typeof body.error?.code === "string"
      ? body.error.code.slice(0, 80)
      : "UNSPECIFIED";
  } catch {
    return "NON_JSON_RESPONSE";
  }
}

async function expectOk(response: Response, code: string) {
  if (response.ok) return;
  throw new ProbeError(`${code}:${await errorCode(response)}`, response.status);
}

async function buildProbeArchive() {
  const archive = new JSZip();
  archive.file("frontmind-presales-roundtrip.txt", "frontmind\n", {
    date: new Date("2026-01-01T00:00:00.000Z"),
  });
  return archive.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
}

if (!serviceToken) {
  console.error(
    JSON.stringify({ status: "failed", code: "SERVICE_TOKEN_MISSING" }),
  );
  process.exit(1);
}

let fileId = "";
let cleanupStatus: number | null = null;

try {
  const bytes = await buildProbeArchive();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const filename = `frontmind-presales-roundtrip-${Date.now()}.zip`;
  const created = await fetch(`${baseUrl}/files`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      filename,
      mimeType: "application/zip",
      sizeBytes: bytes.length,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  await expectOk(created, "CREATE_FAILED");
  const createdBody = (await created.json()) as {
    id?: unknown;
    proxy_upload_ticket?: unknown;
  };
  fileId = typeof createdBody.id === "string" ? createdBody.id : "";
  const uploadTicket =
    typeof createdBody.proxy_upload_ticket === "string"
      ? createdBody.proxy_upload_ticket
      : "";
  if (!fileId || !uploadTicket) {
    throw new ProbeError("CREATE_RESPONSE_INVALID", created.status);
  }

  const uploaded = await fetch(
    `${baseUrl}/files/${encodeURIComponent(fileId)}/content`,
    {
      method: "PUT",
      headers: {
        ...headers,
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "x-frontmind-upload-ticket": uploadTicket,
        "x-original-content-type": "application/zip",
      },
      body: bytes,
      signal: AbortSignal.timeout(60_000),
    },
  );
  await expectOk(uploaded, "UPLOAD_FAILED");

  const downloaded = await fetch(
    `${baseUrl}/files/${encodeURIComponent(fileId)}/content?download=1`,
    {
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  await expectOk(downloaded, "READBACK_FAILED");
  const readback = Buffer.from(await downloaded.arrayBuffer());
  const readbackSha256 = createHash("sha256")
    .update(readback)
    .digest("hex");
  if (!readback.equals(bytes) || readbackSha256 !== sha256) {
    throw new ProbeError("READBACK_HASH_MISMATCH", downloaded.status);
  }
  if (
    downloaded.headers.get("content-type") !== "application/zip" ||
    !downloaded.headers.get("content-disposition")?.includes(filename)
  ) {
    throw new ProbeError("READBACK_HEADERS_INVALID", downloaded.status);
  }

  const removed = await fetch(
    `${baseUrl}/files/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
      headers,
      signal: AbortSignal.timeout(30_000),
    },
  );
  cleanupStatus = removed.status;
  await expectOk(removed, "CLEANUP_FAILED");
  fileId = "";

  console.log(
    JSON.stringify(
      {
        status: "ok",
        providerUploadStatus: uploaded.status,
        localReadbackStatus: downloaded.status,
        bytes: bytes.length,
        sha256,
        cleanupStatus,
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (fileId) {
    try {
      const removed = await fetch(
        `${baseUrl}/files/${encodeURIComponent(fileId)}`,
        {
          method: "DELETE",
          headers,
          signal: AbortSignal.timeout(30_000),
        },
      );
      cleanupStatus = removed.status;
    } catch {
      cleanupStatus = null;
    }
  }
  console.error(
    JSON.stringify({
      status: "failed",
      code: error instanceof ProbeError ? error.code : "PROBE_FAILED",
      httpStatus: error instanceof ProbeError ? error.status : undefined,
      cleanupStatus,
    }),
  );
  process.exit(1);
}

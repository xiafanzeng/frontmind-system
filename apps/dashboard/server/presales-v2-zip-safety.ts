import JSZip from "jszip";

export const PRESALES_V2_ZIP_MAX_ENTRIES = 1_500;
export const PRESALES_V2_ZIP_MAX_UNCOMPRESSED_BYTES = 150 * 1024 * 1024;
export const PRESALES_V2_ZIP_MAX_COMPRESSION_RATIO = 200;

export class PresalesV2ZipSafetyError extends Error {
  readonly code = "PRESALES_V2_ZIP_UNSAFE";

  constructor(message: string) {
    super(message);
    this.name = "PresalesV2ZipSafetyError";
  }
}

function unsafe(message: string): never {
  throw new PresalesV2ZipSafetyError(message);
}

function assertSafeEntryPath(value: string) {
  if (
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    value
      .split("/")
      .filter(Boolean)
      .some((part) => part === "." || part === "..")
  ) {
    unsafe("ZIP entry path is unsafe");
  }
}

/**
 * Validates a Website candidate/final ZIP before it becomes a local artifact.
 * JSZip exposes the original unsafe name and central-directory size hints,
 * while async extraction performs CRC verification and enforces the real
 * aggregate uncompressed byte ceiling.
 */
export async function assertPresalesV2ZipSafe(bytes: Buffer) {
  if (bytes.length < 4) unsafe("ZIP is empty or truncated");
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  } catch {
    unsafe("ZIP parsing or CRC validation failed");
  }
  const entries = Object.values(zip.files);
  if (!entries.length || entries.length > PRESALES_V2_ZIP_MAX_ENTRIES) {
    unsafe("ZIP entry count is outside the permitted range");
  }
  const names = new Set<string>();
  let totalUncompressedBytes = 0;
  for (const entry of entries) {
    const raw = entry as typeof entry & {
      unsafeOriginalName?: string;
      unixPermissions?: number | string | null;
      _data?: { compressedSize?: number; uncompressedSize?: number };
    };
    assertSafeEntryPath(entry.name);
    if (
      raw.unsafeOriginalName &&
      raw.unsafeOriginalName.replace(/\/$/u, "") !==
        entry.name.replace(/\/$/u, "")
    ) {
      unsafe("ZIP entry name was sanitized because it traversed directories");
    }
    const canonicalName = entry.name.replace(/\/$/u, "");
    if (names.has(canonicalName)) unsafe("ZIP contains duplicate entry names");
    names.add(canonicalName);
    const unixPermissions =
      typeof raw.unixPermissions === "string"
        ? Number.parseInt(raw.unixPermissions, 8)
        : raw.unixPermissions;
    if (
      typeof unixPermissions === "number" &&
      (unixPermissions & 0o170000) === 0o120000
    ) {
      unsafe("ZIP contains a symbolic link");
    }
    if (entry.dir) continue;
    const compressedHint = Number(raw._data?.compressedSize || 0);
    const uncompressedHint = Number(raw._data?.uncompressedSize || 0);
    if (
      uncompressedHint > PRESALES_V2_ZIP_MAX_UNCOMPRESSED_BYTES ||
      (compressedHint > 0 &&
        uncompressedHint / compressedHint >
          PRESALES_V2_ZIP_MAX_COMPRESSION_RATIO)
    ) {
      unsafe("ZIP entry expansion ratio or size is unsafe");
    }
    const payload = await entry.async("nodebuffer");
    totalUncompressedBytes += payload.length;
    if (totalUncompressedBytes > PRESALES_V2_ZIP_MAX_UNCOMPRESSED_BYTES) {
      unsafe("ZIP aggregate uncompressed bytes exceed the limit");
    }
  }
}

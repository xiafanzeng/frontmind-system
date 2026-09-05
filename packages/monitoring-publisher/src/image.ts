import { decodeIco, isIco } from "icojs";
import sharp from "sharp";
import { sha256Hex } from "./hash.js";
import type { NormalizedPublisherImage } from "./types.js";

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_PIXELS = 40_000_000;
const MAX_EDGE = 2_560;
const SUPPORTED_MIME_TYPES = new Set([
  "image/avif",
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/vnd.microsoft.icon",
  "image/x-icon",
  "image/tiff",
]);
const SUPPORTED_DECODED_FORMATS = new Set([
  "heif",
  "jpeg",
  "png",
  "webp",
  "gif",
  "tiff",
]);

const WORDMARK_PALETTES = [
  ["#3636E2", "#7777F4"],
  ["#B71424", "#E15B65"],
  ["#2457D6", "#55A3F3"],
  ["#6F2DA8", "#A86CDC"],
  ["#137D68", "#46AE94"],
  ["#9A4C13", "#D28A4C"],
] as const;

export class PublisherImageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 422,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PublisherImageError";
  }
}

export async function normalizePublisherImage(input: {
  bytes: Uint8Array;
  sourceMimeType: string;
}): Promise<NormalizedPublisherImage> {
  const sourceMimeType =
    input.sourceMimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (!SUPPORTED_MIME_TYPES.has(sourceMimeType)) {
    throw new PublisherImageError(
      "unsupported_image_format",
      "Only JPEG, PNG, WebP, GIF and TIFF images are supported",
      415,
    );
  }
  if (
    input.bytes.byteLength === 0 ||
    input.bytes.byteLength > MAX_INPUT_BYTES
  ) {
    throw new PublisherImageError(
      "image_too_large",
      "Source image must be non-empty and no larger than 10 MiB",
      413,
    );
  }

  const rasterInput = await decodePublisherRasterInput(
    input.bytes,
    sourceMimeType,
  );
  let pipeline = sharp(rasterInput, {
    failOn: "error",
    limitInputPixels: MAX_INPUT_PIXELS,
    animated: false,
  });
  let metadata: Awaited<ReturnType<typeof pipeline.metadata>>;
  try {
    metadata = await pipeline.metadata();
  } catch (cause) {
    throw new PublisherImageError(
      "corrupt_image",
      "Image is corrupt or cannot be decoded",
      422,
      { cause },
    );
  }
  if (!metadata.width || !metadata.height) {
    throw new PublisherImageError(
      "missing_image_dimensions",
      "Image dimensions could not be determined",
    );
  }
  if (!metadata.format || !SUPPORTED_DECODED_FORMATS.has(metadata.format)) {
    throw new PublisherImageError(
      "unsupported_image_format",
      "Decoded image format is not an allowed raster format",
      415,
    );
  }
  const warnings =
    (metadata.pages ?? 1) > 1
      ? [
          {
            code: "animation_flattened",
            message:
              "Animated or multi-page image was flattened to its first frame",
            blocking: false,
            source: "image" as const,
          },
        ]
      : [];
  pipeline = pipeline
    .rotate()
    .resize({
      width: MAX_EDGE,
      height: MAX_EDGE,
      fit: "inside",
      withoutEnlargement: true,
    })
    .toColorspace("srgb");
  const preservePng =
    sourceMimeType === "image/png" ||
    sourceMimeType === "image/x-icon" ||
    sourceMimeType === "image/vnd.microsoft.icon" ||
    Boolean(metadata.hasAlpha);
  const output = preservePng
    ? await pipeline
        .png({ compressionLevel: 9, adaptiveFiltering: true })
        .toBuffer({ resolveWithObject: true })
    : await pipeline
        .jpeg({ quality: 88, mozjpeg: true })
        .toBuffer({ resolveWithObject: true });
  if (output.data.byteLength > MAX_OUTPUT_BYTES) {
    throw new PublisherImageError(
      "normalized_image_too_large",
      "Normalized image exceeds 10 MiB",
      413,
    );
  }
  const bytes = Uint8Array.from(output.data);
  return {
    bytes,
    sha256: sha256Hex(bytes),
    mimeType: preservePng ? "image/png" : "image/jpeg",
    width: output.info.width,
    height: output.info.height,
    warnings,
  };
}

async function decodePublisherRasterInput(
  bytes: Uint8Array,
  sourceMimeType: string,
): Promise<Uint8Array> {
  if (
    sourceMimeType !== "image/x-icon" &&
    sourceMimeType !== "image/vnd.microsoft.icon"
  ) {
    return bytes;
  }
  const buffer = Buffer.from(bytes);
  if (!isIco(buffer)) {
    throw new PublisherImageError(
      "corrupt_image",
      "ICO image is corrupt or cannot be decoded",
      422,
    );
  }
  let decoded: Awaited<ReturnType<typeof decodeIco>>;
  try {
    decoded = await decodeIco(buffer, "image/png");
  } catch (cause) {
    throw new PublisherImageError(
      "corrupt_image",
      "ICO image is corrupt or cannot be decoded",
      422,
      { cause },
    );
  }
  const best = decoded
    .filter(
      (image) =>
        Number.isSafeInteger(image.width) &&
        Number.isSafeInteger(image.height) &&
        image.width > 0 &&
        image.height > 0,
    )
    .sort(
      (left, right) =>
        right.width * right.height - left.width * left.height ||
        right.bpp - left.bpp,
    )[0];
  if (!best?.buffer.byteLength) {
    throw new PublisherImageError(
      "corrupt_image",
      "ICO image contains no decodable frame",
      422,
    );
  }
  return Uint8Array.from(new Uint8Array(best.buffer));
}

/**
 * Creates a deterministic, server-owned raster mark for a catalog row that
 * has no verifiable logo yet. The result is intentionally a generated
 * fallback, never evidence of a real brand logo. Keeping it as a private PNG
 * means every media row has a renderable same-origin asset while later syncs
 * can still upgrade it to a provider or verified logo.
 */
export async function createPublisherMediaFallbackMark(input: {
  name: string;
  stableId: string;
}): Promise<NormalizedPublisherImage> {
  const identity = `${input.stableId.trim()}\u0000${input.name.trim().normalize("NFKC")}`;
  const identityHash = sha256Hex(new TextEncoder().encode(identity));
  const palette =
    WORDMARK_PALETTES[
      Number.parseInt(identityHash.slice(0, 2), 16) % WORDMARK_PALETTES.length
    ]!;
  const glyphs =
    Array.from(
      input.name
        .trim()
        .normalize("NFKC")
        .replace(/[\s·（）()【】_-]+/gu, "")
        .replaceAll("[", "")
        .replaceAll("]", ""),
    )
      .slice(0, 2)
      .join("") || "媒体";
  const escapedGlyphs = escapeSvgText(glyphs);
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="${palette[0]}"/><stop offset="1" stop-color="${palette[1]}"/></linearGradient></defs>
      <rect width="128" height="128" rx="28" fill="url(#g)"/>
      <circle cx="103" cy="25" r="24" fill="#fff" opacity=".10"/>
      <circle cx="24" cy="108" r="30" fill="#000" opacity=".08"/>
      <text x="64" y="71" text-anchor="middle" dominant-baseline="middle" fill="#fff" font-size="44" font-weight="700" font-family="Arial, PingFang SC, Microsoft YaHei, sans-serif">${escapedGlyphs}</text>
      <rect x="42" y="101" width="44" height="5" rx="2.5" fill="#fff" opacity=".72"/>
    </svg>`,
    "utf8",
  );
  const output = await sharp(svg, {
    failOn: "error",
    limitInputPixels: 128 * 128,
  })
    .png({ compressionLevel: 9, adaptiveFiltering: true })
    .toBuffer({ resolveWithObject: true });
  const bytes = Uint8Array.from(output.data);
  return {
    bytes,
    sha256: sha256Hex(bytes),
    mimeType: "image/png",
    width: output.info.width,
    height: output.info.height,
    warnings: [],
  };
}

function escapeSvgText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

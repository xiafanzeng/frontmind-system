import { createHash } from "node:crypto";
import sharp from "sharp";
import { RemoteMediaRejectedError } from "./errors.js";

export interface ImageDerivative {
  body: Uint8Array;
  contentType: "image/webp";
  size: number;
  sha256: string;
  width: number;
  height: number;
}

export interface ImageDerivatives {
  display: ImageDerivative;
  thumbnail: ImageDerivative;
}

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

async function render(
  source: Uint8Array,
  maxWidth: number,
  maxHeight: number,
  quality: number,
): Promise<ImageDerivative> {
  const { data, info } = await sharp(source, {
    animated: false,
    failOn: "warning",
    limitInputPixels: 40_000_000,
  })
    .rotate()
    .resize({
      width: maxWidth,
      height: maxHeight,
      fit: "inside",
      withoutEnlargement: true,
    })
    // withMetadata is deliberately not called: EXIF/GPS/comments are stripped.
    .webp({ quality, effort: 4, smartSubsample: true })
    .toBuffer({ resolveWithObject: true });
  return {
    body: data,
    contentType: "image/webp",
    size: data.byteLength,
    sha256: digest(data),
    width: info.width,
    height: info.height,
  };
}

export async function createImageDerivatives(
  source: Uint8Array,
): Promise<ImageDerivatives> {
  try {
    // Decode sequentially so the configured media concurrency remains the real
    // upper bound on Sharp memory pressure for large screenshots.
    const display = await render(source, 1_920, 1_920, 82);
    const thumbnail = await render(source, 480, 480, 75);
    return { display, thumbnail };
  } catch (cause) {
    throw new RemoteMediaRejectedError(
      "Remote media could not be safely decoded",
      {},
      { cause },
    );
  }
}

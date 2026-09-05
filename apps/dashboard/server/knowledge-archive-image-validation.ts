import path from "node:path";
import sharp from "sharp";

const MAX_RASTER_DECODE_PIXELS = 40_000_000;

export const imageMimeByExtension: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
};

export function isSupportedImageBytes(extension: string, bytes: Buffer) {
  if (extension === ".png") {
    return (
      bytes.length >= 24 &&
      bytes
        .subarray(0, 8)
        .equals(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        ) &&
      bytes.subarray(12, 16).toString("ascii") === "IHDR" &&
      bytes.readUInt32BE(16) > 0 &&
      bytes.readUInt32BE(20) > 0
    );
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return (
      bytes.length >= 4 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff &&
      bytes[bytes.length - 2] === 0xff &&
      bytes[bytes.length - 1] === 0xd9
    );
  }
  if (extension === ".gif") {
    return (
      bytes.length >= 10 &&
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) &&
      bytes.readUInt16LE(6) > 0 &&
      bytes.readUInt16LE(8) > 0
    );
  }
  if (extension === ".webp") {
    return (
      bytes.length >= 16 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP" &&
      bytes.readUInt32LE(4) + 8 <= bytes.length
    );
  }
  if (extension === ".avif") {
    return (
      bytes.length >= 16 &&
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      /^(?:avif|avis)$/.test(bytes.subarray(8, 12).toString("ascii"))
    );
  }
  return false;
}

export function basicRasterImageDimensions(extension: string, bytes: Buffer) {
  if (extension === ".png" && bytes.length >= 24) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (extension === ".gif" && bytes.length >= 10) {
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes[offset + 1] || 0;
      if (marker === 0xd8 || marker === 0xd9) {
        offset += 2;
        continue;
      }
      const segmentLength = bytes.readUInt16BE(offset + 2);
      if (segmentLength < 2 || offset + 2 + segmentLength > bytes.length) {
        break;
      }
      if (
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)
      ) {
        return {
          width: bytes.readUInt16BE(offset + 7),
          height: bytes.readUInt16BE(offset + 5),
        };
      }
      offset += 2 + segmentLength;
    }
  }
  if (extension === ".webp" && bytes.length >= 30) {
    const chunk = bytes.subarray(12, 16).toString("ascii");
    if (chunk === "VP8X") {
      return {
        width: bytes.readUIntLE(24, 3) + 1,
        height: bytes.readUIntLE(27, 3) + 1,
      };
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f && bytes.length >= 25) {
      const packed = bytes.readUInt32LE(21);
      return {
        width: (packed & 0x3fff) + 1,
        height: ((packed >>> 14) & 0x3fff) + 1,
      };
    }
    if (
      chunk === "VP8 " &&
      bytes.subarray(23, 26).equals(Buffer.from([0x9d, 0x01, 0x2a]))
    ) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  if (extension === ".avif") {
    const typeOffset = bytes.indexOf(Buffer.from("ispe"));
    if (typeOffset >= 4 && typeOffset + 16 <= bytes.length) {
      const boxSize = bytes.readUInt32BE(typeOffset - 4);
      if (boxSize >= 20 && typeOffset - 4 + boxSize <= bytes.length) {
        return {
          width: bytes.readUInt32BE(typeOffset + 8),
          height: bytes.readUInt32BE(typeOffset + 12),
        };
      }
    }
  }
  return undefined;
}

export async function decodedRasterImageDimensions(
  extension: string,
  bytes: Buffer,
) {
  if (!isSupportedImageBytes(extension, bytes)) return undefined;
  try {
    const options = {
      failOn: "warning" as const,
      limitInputPixels: MAX_RASTER_DECODE_PIXELS,
      pages: 1,
      sequentialRead: true,
    };
    const metadata = await sharp(bytes, options).metadata();
    const expectedMime = imageMimeByExtension[extension];
    const height = metadata.pageHeight || metadata.height;
    if (
      !expectedMime ||
      metadata.mediaType !== expectedMime ||
      !metadata.width ||
      !height ||
      metadata.width * height > MAX_RASTER_DECODE_PIXELS
    ) {
      return undefined;
    }
    await sharp(bytes, options).stats();
    return { width: metadata.width, height };
  } catch {
    return undefined;
  }
}

export function hasSupportedImageSignature(extension: string, bytes: Buffer) {
  if (extension === ".png") {
    return (
      bytes.length >= 8 &&
      bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return (
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }
  if (extension === ".webp") {
    return (
      bytes.length >= 12 &&
      bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
      bytes.subarray(8, 12).toString("ascii") === "WEBP"
    );
  }
  if (extension === ".gif") {
    return (
      bytes.length >= 6 &&
      ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"))
    );
  }
  if (extension === ".avif") {
    return (
      bytes.length >= 16 &&
      bytes.subarray(4, 8).toString("ascii") === "ftyp" &&
      bytes.subarray(8, 32).includes(Buffer.from("avif"))
    );
  }
  return false;
}

export function validateProgressReportScreenshot(input: {
  filename: string;
  bytes: Buffer;
}) {
  const extension = path.extname(input.filename).toLowerCase();
  const mimeType = imageMimeByExtension[extension];
  if (!mimeType || ![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
    throw new Error("答案截图仅支持 PNG、JPG 或 WEBP");
  }
  if (!hasSupportedImageSignature(extension, input.bytes)) {
    throw new Error("答案截图内容与文件扩展名不一致");
  }
  return { extension, mimeType };
}

export const LARGE_IMAGE_LONG_EDGE = 8192;
export const LARGE_IMAGE_PIXELS = 24_000_000;

export interface ImageInspection {
  width: number;
  height: number;
  pixels: number;
  size: number;
  isLarge: boolean;
  reasons: string[];
}

export function evaluateImageSize(
  width: number,
  height: number,
  size: number,
): Omit<ImageInspection, "size"> {
  const pixels = width * height;
  const reasons: string[] = [];

  if (Math.max(width, height) > LARGE_IMAGE_LONG_EDGE) {
    reasons.push(`最长边 ${Math.max(width, height)}px`);
  }

  if (pixels > LARGE_IMAGE_PIXELS) {
    reasons.push(`总像素 ${formatMegapixels(pixels)}`);
  }

  return {
    width,
    height,
    pixels,
    isLarge: reasons.length > 0,
    reasons,
  };
}

export function formatMegapixels(pixels: number): string {
  return `${(pixels / 1_000_000).toFixed(1)}MP`;
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  return `${bytes}B`;
}

export function formatImageInspectionSummary(info: ImageInspection): string {
  return `${info.width}x${info.height} · ${formatMegapixels(info.pixels)} · ${formatFileSize(info.size)}`;
}

export async function inspectImageFile(file: File): Promise<ImageInspection> {
  const url = URL.createObjectURL(file);

  try {
    const dimensions = await readImageDimensions(url);
    return {
      ...evaluateImageSize(dimensions.width, dimensions.height, file.size),
      size: file.size,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

function readImageDimensions(
  url: string,
): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      resolve({
        width: image.naturalWidth || image.width,
        height: image.naturalHeight || image.height,
      });
    };
    image.onerror = () => reject(new Error("图片读取失败"));
    image.src = url;
  });
}

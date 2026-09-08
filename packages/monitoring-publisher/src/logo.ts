import sanitizeHtml from "sanitize-html";
import sharp from "sharp";
import { normalizePublisherImage, PublisherImageError } from "./image.js";

/** Only the private Logo archiver opts into SVG; article uploads stay raster. */
export const PUBLISHER_LOGO_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "application/octet-stream", "image/png", "image/jpeg", "image/jpg", "image/gif",
  "image/webp", "image/avif", "image/vnd.microsoft.icon", "image/x-icon", "image/svg+xml",
]);

export async function normalizePublisherLogo(input: { bytes: Uint8Array; sourceMimeType: string }) {
  if (input.sourceMimeType.split(";", 1)[0]?.trim().toLowerCase() !== "image/svg+xml") {
    return normalizePublisherImage(input);
  }
  if (!input.bytes.length || input.bytes.length > 2 * 1024 * 1024) {
    throw new PublisherImageError("logo_too_large", "Logo SVG exceeds 2 MiB", 413);
  }
  // Older static supplier icons include this standard declaration. Remove it
  // before parsing so no DTD is fetched; all other declarations remain denied.
  const source = Buffer.from(input.bytes).toString("utf8").replace(
    /<!DOCTYPE\s+svg\s+PUBLIC\s+(["'])-\/\/W3C\/\/DTD SVG 1\.1\/\/EN\1\s+(["'])https?:\/\/www\.w3\.org\/Graphics\/SVG\/1\.1\/DTD\/svg11\.dtd\2\s*>/iu,
    "",
  );
  if (/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/iu.test(source)) {
    throw new PublisherImageError("unsafe_logo_svg", "Logo SVG contains external declarations");
  }
  // No scripts, HTML, embedded images, CSS, animation, filters or remote fonts.
  // Parsed attribute checks also cover entity-encoded references.
  const svg = sanitizeHtml(source, {
    allowedTags: ["svg", "g", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "defs", "linearGradient", "radialGradient", "stop", "clipPath", "mask", "use", "title", "desc"],
    allowedAttributes: { "*": ["xmlns", "width", "height", "viewBox", "preserveAspectRatio", "id", "d", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "points", "fill", "fill-rule", "fill-opacity", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-miterlimit", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "opacity", "transform", "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod", "clip-path", "clip-rule", "mask", "maskUnits", "maskContentUnits", "href", "xlink:href", "xmlns:xlink"] },
    parser: { lowerCaseTags: false, lowerCaseAttributeNames: false },
    nonTextTags: ["script", "style", "textarea", "option", "foreignObject"],
    transformTags: { "*": (tagName, attribs) => {
      for (const [key, value] of Object.entries(attribs)) {
        if (["fill", "stroke", "clip-path", "mask"].includes(key) &&
            !/^(?:none|currentColor|transparent|[a-z]+|#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%+-]+\)|url\(\s*["']?#[A-Za-z_][\w:.-]*["']?\s*\))$/iu.test(value.trim())) {
          throw new PublisherImageError("unsafe_logo_svg", "Logo SVG contains unsupported paint");
        }
        if ((key === "href" || key === "xlink:href") && !/^#[A-Za-z_][\w:.-]*$/u.test(value)) {
          throw new PublisherImageError("unsafe_logo_svg", "Logo SVG contains an external reference");
        }
        for (const match of value.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/giu)) {
          if (!/^#[A-Za-z_][\w:.-]*$/u.test(match[1] ?? "")) {
            throw new PublisherImageError("unsafe_logo_svg", "Logo SVG contains an external paint reference");
          }
        }
      }
      return { tagName, attribs };
    } },
  });
  if (!/<svg\b/u.test(svg) || !/<(?:path|rect|circle|ellipse|line|polyline|polygon|use)\b/u.test(svg)) {
    throw new PublisherImageError("unsafe_logo_svg", "Logo SVG contains no supported drawing");
  }
  const bytes = await sharp(Buffer.from(svg), { limitInputPixels: 4_000_000, failOn: "error" })
    .resize(256, 256, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  return normalizePublisherImage({ bytes, sourceMimeType: "image/png" });
}

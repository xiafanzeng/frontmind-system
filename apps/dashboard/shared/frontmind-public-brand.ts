const SOURCE_BRANDS = [
  ["ma", "nus"].join(""),
  ["jeno", "va"].join(""),
] as const;

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Last-resort customer-boundary sanitizer. Server projections must still use
 * curated customer copy; this function guarantees that historical text,
 * underscored codes, hyphenated identifiers, paths and domains cannot reveal
 * an implementation-provider brand.
 */
export function sanitizeFrontMindPublicText(value: unknown): string {
  if (typeof value !== "string") {
    if (value === null || value === undefined) return "";
    try {
      value = String(value);
    } catch {
      return "";
    }
  }

  return SOURCE_BRANDS.reduce((text, source) => {
    const escaped = escapeRegExp(source);
    return text
      .replace(
        new RegExp(`https?:\\/\\/api\\.${escaped}\\.`, "giu"),
        "https://api.frontmind.",
      )
      .replace(
        new RegExp(`https?:\\/\\/www\\.${escaped}\\.`, "giu"),
        "https://www.frontmind.",
      )
      .replace(
        new RegExp(
          `https?:\\/\\/(?:[a-z0-9-]+\\.)*${escaped}\\.[a-z0-9.-]+(?:\\/[^\\s]*)?`,
          "giu",
        ),
        "https://frontmind.net",
      )
      .replace(
        new RegExp(`${escaped}(?:[_-][a-z0-9]+)+`, "giu"),
        "FrontMind",
      )
      .replace(new RegExp(escaped, "giu"), "FrontMind");
  }, value as string);
}

export function containsPrivateProviderBrand(value: unknown): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return SOURCE_BRANDS.some((source) =>
    new RegExp(escapeRegExp(source), "iu").test(text || ""),
  );
}

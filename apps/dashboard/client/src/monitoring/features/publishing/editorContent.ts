import type { ArticleImage } from "./types";

const forbiddenElements = [
  "script",
  "style",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "video",
  "audio",
  "source",
].join(",");

/**
 * Produces the editor's browser-side safety boundary. The API canonicalizer is
 * still authoritative, but an external or data URL never becomes an accepted
 * TipTap image while a customer is editing.
 */
export function sanitizePublisherEditorHtml(
  html: string,
  images: readonly ArticleImage[],
): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const imagesById = new Map(images.map((image) => [image.id, image]));

  document
    .querySelectorAll(forbiddenElements)
    .forEach((element) => element.remove());
  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of [...element.attributes]) {
      if (/^on/iu.test(attribute.name) || attribute.name === "style") {
        element.removeAttribute(attribute.name);
      }
    }
  });

  document.querySelectorAll("img").forEach((element) => {
    const assetId = element.getAttribute("data-asset-id") ?? "";
    const image = imagesById.get(assetId);
    const source = element.getAttribute("src");
    if (
      !image?.sourceUrl ||
      (source !== image.sourceUrl && source !== image.previewUrl)
    ) {
      element.remove();
      return;
    }
    element.setAttribute("src", image.sourceUrl);
    element.setAttribute("alt", image.altText);
    element.setAttribute("data-asset-id", image.id);
    element.removeAttribute("srcset");
    element.removeAttribute("sizes");
    element.removeAttribute("crossorigin");
    element.removeAttribute("referrerpolicy");
  });

  return document.body.innerHTML;
}

/** Replaces frozen/public capability URLs with owner-authenticated Blob URLs. */
export function publisherCanonicalHtmlToEditorHtml(
  html: string,
  images: readonly ArticleImage[],
): string {
  const canonicalHtml = sanitizePublisherEditorHtml(html, images);
  const document = new DOMParser().parseFromString(canonicalHtml, "text/html");
  const imagesById = new Map(images.map((image) => [image.id, image]));
  document.querySelectorAll("img").forEach((element) => {
    const image = imagesById.get(element.getAttribute("data-asset-id") ?? "");
    if (!image?.previewUrl) {
      element.remove();
      return;
    }
    element.setAttribute("src", image.previewUrl);
  });
  return document.body.innerHTML;
}

export function publisherPlainTextToHtml(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .split(/\n{2,}/gu)
    .map(
      (paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/gu, "<br>")}</p>`,
    )
    .join("\n");
}

export function publisherHtmlToPlainText(html: string): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  document
    .querySelectorAll("br")
    .forEach((element) => element.replaceWith("\n"));
  document
    .querySelectorAll("p,h1,h2,h3,h4,h5,h6,blockquote,li")
    .forEach((element) => element.append("\n\n"));
  return (document.body.textContent ?? "")
    .replace(/\u00a0/gu, " ")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

function escapeHtml(value: string) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

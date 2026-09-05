/** Browser media must stay on the authenticated, tenant-checked module API. */
const archivedMediaPathPattern =
  /^\/api\/monitoring\/media\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?:\?variant=(?:display|thumbnail))?$/iu;
const publisherLogoPathPattern =
  /^\/api\/monitoring\/publisher\/media-logos\/[0-9a-f-]{36}\/[a-f0-9]{64}$/iu;

function safePath(value: string | undefined, pattern: RegExp) {
  // `$` also matches before a final newline. Require the entire input to match.
  return value && pattern.exec(value)?.[0] === value ? value : undefined;
}

export function safeArchivedMediaUrl(value?: string) {
  return safePath(value, archivedMediaPathPattern);
}

export function safePublisherLogoUrl(value?: string) {
  return safePath(value, publisherLogoPathPattern);
}

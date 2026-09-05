/** Authentication requests must never wait behind large workspace batches. */
export function shouldIsolateAuthOperation(path: string) {
  return path === "auth" || path.startsWith("auth.");
}

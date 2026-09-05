import path from "node:path";

export function siblingWebsiteRepositoryRoot(cwd = process.cwd()) {
  const configured = process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT?.trim();
  return configured
    ? path.resolve(configured)
    : path.resolve(cwd, "../frontmind-website");
}

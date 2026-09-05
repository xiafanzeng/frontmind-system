import fs from "node:fs";
import path from "node:path";

const WEBSITE_REPOSITORY_DIRECTORY = "frontmind-website";
const DEVELOPMENT_WORKSPACE_SUFFIX = "-dev";

export function siblingWebsiteRepositoryRoot(cwd = process.cwd()) {
  const configured = process.env.FRONTMIND_WEBSITE_REPOSITORY_ROOT?.trim();
  if (configured) return path.resolve(configured);

  const parent = path.resolve(cwd, "..");
  const developmentWorkspace = path
    .basename(path.resolve(cwd))
    .endsWith(DEVELOPMENT_WORKSPACE_SUFFIX);
  const developmentRepositoryDirectory = `${WEBSITE_REPOSITORY_DIRECTORY}${DEVELOPMENT_WORKSPACE_SUFFIX}`;
  const candidates = (
    developmentWorkspace
      ? [developmentRepositoryDirectory, WEBSITE_REPOSITORY_DIRECTORY]
      : [WEBSITE_REPOSITORY_DIRECTORY, developmentRepositoryDirectory]
  ).map((name) => path.join(parent, name));
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  );
}

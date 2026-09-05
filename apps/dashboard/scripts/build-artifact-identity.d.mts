export interface BuildArtifactFileIdentity {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildArtifactManifest {
  schemaVersion: 1;
  buildSourceSha: string;
  excludedPaths: ["artifact-manifest.json"];
  files: BuildArtifactFileIdentity[];
  rootSha256: string;
}

export function writeBuildArtifactIdentity(
  buildRoot: string,
  buildSourceSha: string,
): Promise<{ schemaVersion: 1; buildSourceSha: string }>;

export function readBuildArtifactIdentity(
  buildRoot: string,
): Promise<{ schemaVersion: 1; buildSourceSha: string }>;

export function createBuildArtifactManifest(
  buildRoot: string,
  buildSourceSha: string,
): Promise<BuildArtifactManifest>;

export function writeBuildArtifactManifest(
  buildRoot: string,
  buildSourceSha: string,
): Promise<BuildArtifactManifest>;

export function readBuildArtifactManifest(
  buildRoot: string,
): Promise<BuildArtifactManifest>;

export function verifyBuildArtifactManifest(
  buildRoot: string,
  options?: { expectedBuildSourceSha?: string },
): Promise<BuildArtifactManifest>;

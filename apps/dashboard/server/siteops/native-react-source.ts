import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import JSZip, { type JSZipObject } from "jszip";
import { z } from "zod";

import { canonicalJson } from "../../shared/siteops-workflow";
import { fetchPinnedPublicHttps } from "./remote-preview";

export const FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME =
  "frontmind-site-source-v1.zip";
export const FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME =
  "frontmind-site-source-receipt-v1.json";
export const FRONTMIND_SITE_SOURCE_ARCHIVE_MIME = "application/zip";
export const NATIVE_SOURCE_PREFLIGHT_V1_VERSION =
  "frontmind-native-preflight-v1" as const;
/** Historical alias retained for workflow 2.5-2.8 operation replay. */
export const NATIVE_SOURCE_PREFLIGHT_VERSION =
  NATIVE_SOURCE_PREFLIGHT_V1_VERSION;
export const NATIVE_SOURCE_PREFLIGHT_FILENAME =
  `${NATIVE_SOURCE_PREFLIGHT_VERSION}.mjs` as const;
export const NATIVE_RUNTIME_CONTRACT_VERSION =
  "frontmind-native-runtime-contract-v1" as const;
export const NATIVE_RUNTIME_CONTRACT_FILENAME =
  `${NATIVE_RUNTIME_CONTRACT_VERSION}.json` as const;
export const NATIVE_RUNTIME_EXECUTION_SHELL_VERSION =
  "frontmind-native-execution-shell-v1" as const;
export const NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME =
  `${NATIVE_RUNTIME_EXECUTION_SHELL_VERSION}.json` as const;
export const NATIVE_SOURCE_PREFLIGHT_V2_VERSION =
  "frontmind-native-preflight-v2" as const;
export const NATIVE_SOURCE_PREFLIGHT_V2_FILENAME =
  `${NATIVE_SOURCE_PREFLIGHT_V2_VERSION}.mjs` as const;
export const NATIVE_RUNTIME_HTML_ENTRYPOINT = "index.html" as const;
export const NATIVE_RUNTIME_APP_ENTRYPOINT = "src/main.tsx" as const;
export const NATIVE_RUNTIME_ROUTE_MODULE = "src/frontmind-routes.tsx" as const;
export const NATIVE_RUNTIME_ROOT_ELEMENT_ID = "root" as const;
export const NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT =
  "FRONTMIND_ROUTE_PATHS" as const;
export const NATIVE_RUNTIME_REQUIRED_DEPENDENCIES = Object.freeze([
  "react",
  "react-dom",
  "vite",
] as const);
export const NATIVE_RUNTIME_FORBIDDEN_FRAMEWORK_DEPENDENCIES = Object.freeze([
  "next",
  "gatsby",
  "wasp",
  "@wasp/core",
] as const);

export const NATIVE_SOURCE_ALLOWED_DEPENDENCIES = Object.freeze([
  "@base-ui/react",
  "@devnomic/marquee",
  "@dnd-kit/core",
  "@dnd-kit/modifiers",
  "@dnd-kit/sortable",
  "@dnd-kit/utilities",
  "@hookform/resolvers",
  "@number-flow/react",
  "@radix-ui/react-accordion",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-aspect-ratio",
  "@radix-ui/react-avatar",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-collapsible",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-icons",
  "@radix-ui/react-label",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-progress",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-toast",
  "@radix-ui/react-toggle",
  "@radix-ui/react-toggle-group",
  "@radix-ui/react-tooltip",
  "@tailwindcss/vite",
  "@tanstack/react-table",
  "@vitejs/plugin-react",
  "class-variance-authority",
  "clsx",
  "cmdk",
  "date-fns",
  "embla-carousel-react",
  "framer-motion",
  "gsap",
  "hls.js",
  "input-otp",
  "lucide-react",
  "motion",
  "next-themes",
  "react",
  "react-day-picker",
  "react-dom",
  "react-hook-form",
  "react-markdown",
  "react-resizable-panels",
  "react-router-dom",
  "recharts",
  "shaders",
  "sonner",
  "tailwind-merge",
  "tailwindcss",
  "tailwindcss-animate",
  "tw-animate-css",
  "vaul",
  "vite",
  "wouter",
  "zod",
  "zustand",
] as const);

/**
 * Immutable dependency coordinates for NativeRuntimeContractV1. Never derive
 * these bytes from the current node_modules tree: changing any value requires
 * a new runtime-contract version and hash.
 */
export const NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS = Object.freeze({
  "@base-ui/react": "1.7.0",
  "@devnomic/marquee": "1.0.2",
  "@dnd-kit/core": "6.3.1",
  "@dnd-kit/modifiers": "9.0.0",
  "@dnd-kit/sortable": "10.0.0",
  "@dnd-kit/utilities": "3.2.2",
  "@hookform/resolvers": "5.2.2",
  "@number-flow/react": "0.6.0",
  "@radix-ui/react-accordion": "1.2.12",
  "@radix-ui/react-alert-dialog": "1.1.15",
  "@radix-ui/react-aspect-ratio": "1.1.7",
  "@radix-ui/react-avatar": "1.1.10",
  "@radix-ui/react-checkbox": "1.3.3",
  "@radix-ui/react-collapsible": "1.1.12",
  "@radix-ui/react-context-menu": "2.2.16",
  "@radix-ui/react-dialog": "1.1.15",
  "@radix-ui/react-dropdown-menu": "2.1.16",
  "@radix-ui/react-hover-card": "1.1.15",
  "@radix-ui/react-icons": "1.3.2",
  "@radix-ui/react-label": "2.1.7",
  "@radix-ui/react-menubar": "1.1.16",
  "@radix-ui/react-navigation-menu": "1.2.14",
  "@radix-ui/react-popover": "1.1.15",
  "@radix-ui/react-progress": "1.1.7",
  "@radix-ui/react-radio-group": "1.3.8",
  "@radix-ui/react-scroll-area": "1.2.10",
  "@radix-ui/react-select": "2.2.6",
  "@radix-ui/react-separator": "1.1.7",
  "@radix-ui/react-slider": "1.3.6",
  "@radix-ui/react-slot": "1.2.3",
  "@radix-ui/react-switch": "1.2.6",
  "@radix-ui/react-tabs": "1.1.13",
  "@radix-ui/react-toast": "1.2.4",
  "@radix-ui/react-toggle": "1.1.10",
  "@radix-ui/react-toggle-group": "1.1.11",
  "@radix-ui/react-tooltip": "1.2.8",
  "@tailwindcss/vite": "4.1.14",
  "@tanstack/react-table": "8.21.3",
  "@vitejs/plugin-react": "5.0.4",
  "class-variance-authority": "0.7.1",
  clsx: "2.1.1",
  cmdk: "1.1.1",
  "date-fns": "4.1.0",
  "embla-carousel-react": "8.6.0",
  "framer-motion": "12.23.22",
  gsap: "3.15.0",
  "hls.js": "1.7.1",
  "input-otp": "1.4.2",
  "lucide-react": "0.453.0",
  motion: "13.1.1",
  "next-themes": "0.4.6",
  react: "19.2.1",
  "react-day-picker": "9.11.1",
  "react-dom": "19.2.1",
  "react-hook-form": "7.64.0",
  "react-markdown": "9.1.0",
  "react-resizable-panels": "3.0.6",
  "react-router-dom": "7.11.0",
  recharts: "2.15.4",
  shaders: "3.1.457",
  sonner: "2.0.7",
  "tailwind-merge": "3.3.1",
  tailwindcss: "4.1.14",
  "tailwindcss-animate": "1.0.7",
  "tw-animate-css": "1.4.0",
  vaul: "1.1.2",
  vite: "7.1.9",
  wouter: "3.7.1",
  zod: "4.1.12",
  zustand: "5.0.9",
} satisfies Readonly<
  Record<(typeof NATIVE_SOURCE_ALLOWED_DEPENDENCIES)[number], string>
>);

export const NATIVE_SOURCE_TEXT_FILE_EXTENSIONS = Object.freeze([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".jsx",
  ".json",
  ".less",
  ".md",
  ".mdx",
  ".mjs",
  ".sass",
  ".scss",
  ".svg",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
] as const);
export const NATIVE_SOURCE_BINARY_FILE_EXTENSIONS = Object.freeze([
  ".avif",
  ".eot",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".mp3",
  ".mp4",
  ".ogg",
  ".otf",
  ".png",
  ".ttf",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
] as const);
export const NATIVE_SOURCE_TEXT_BASENAMES = Object.freeze([
  "dockerfile",
  "license",
  "makefile",
  "notice",
] as const);
export const NATIVE_SOURCE_LOCK_FILENAMES = Object.freeze([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
] as const);
export const NATIVE_SOURCE_MAX_FILES = 512;
export const NATIVE_SOURCE_MAX_SINGLE_FILE_BYTES = 8 * 1024 * 1024;
export const NATIVE_SOURCE_MAX_EXPANDED_BYTES = 48 * 1024 * 1024;
export const NATIVE_SOURCE_MAX_PATH_BYTES = 240;
export const NATIVE_SOURCE_MAX_PATH_DEPTH = 16;
export const NATIVE_SOURCE_MAX_PATH_SEGMENT_BYTES = 100;

export const NATIVE_RUNTIME_HTML_SHELL_V1_TEXT =
  '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n</head>\n<body>\n<div id="root"></div>\n<script type="module" src="/src/main.tsx"></script>\n</body>\n</html>\n' as const;
export const NATIVE_RUNTIME_APP_SHELL_V1_TEXT =
  'import { StrictMode } from "react";\nimport { createRoot } from "react-dom/client";\nimport FrontMindRoutes from "./frontmind-routes";\n\nconst root = document.getElementById("root");\nif (!root) throw new Error("FRONTMIND_ROOT_ELEMENT_MISSING");\ncreateRoot(root).render(<StrictMode><FrontMindRoutes /></StrictMode>);\n' as const;

export const NATIVE_SOURCE_PREFLIGHT_SCRIPT = Buffer.from(
  `import { readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
const root = path.resolve(process.argv[2] || ".");
const allowed = new Set([".css", ".gif", ".html", ".ico", ".jpeg", ".jpg", ".json", ".jsx", ".md", ".mjs", ".png", ".svg", ".ts", ".tsx", ".txt", ".webp", ".woff", ".woff2"]);
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  if (["node_modules", "dist", ".git"].includes(entry.name)) return [];
  const absolute = path.join(dir, entry.name);
  if (entry.isDirectory()) return walk(absolute);
  if (!entry.isFile() || !allowed.has(path.extname(entry.name).toLowerCase())) throw new Error("PREFLIGHT_FILE_TYPE_FORBIDDEN:" + path.relative(root, absolute));
  if (statSync(absolute).size > 8 * 1024 * 1024) throw new Error("PREFLIGHT_FILE_TOO_LARGE:" + path.relative(root, absolute));
  return [absolute];
});
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
if (!pkg || typeof pkg !== "object" || Array.isArray(pkg) || typeof pkg.scripts?.build !== "string") throw new Error("PREFLIGHT_PACKAGE_INVALID");
walk(root);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const built = spawnSync(npm, ["run", "build", "--ignore-scripts"], { cwd: root, encoding: "utf8", shell: false, timeout: 120000 });
if (built.error || built.status !== 0) throw new Error("PREFLIGHT_BUILD_FAILED");
process.stdout.write(JSON.stringify({ version: "${NATIVE_SOURCE_PREFLIGHT_VERSION}", status: "passed" }) + "\\n");
`,
  "utf8",
);
export const NATIVE_SOURCE_PREFLIGHT_SHA256 = createHash("sha256")
  .update(NATIVE_SOURCE_PREFLIGHT_SCRIPT)
  .digest("hex");

/**
 * Provider-side mirror of the host audit. This attachment is intentionally
 * dependency-free: it proves the submitted tree matches the attached runtime
 * contract before the provider reports a successful receipt. The host repeats
 * every check and remains authoritative.
 */
export const NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT = Buffer.from(
  String.raw`import { createHash } from "node:crypto";
	import { readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
	import { spawnSync } from "node:child_process";
	import path from "node:path";

	const root = realpathSync(path.resolve(process.argv[2] || "."));
	const contractPath = path.join(root, "${NATIVE_RUNTIME_CONTRACT_FILENAME}");
	const configFilename = ".frontmind-native-preflight-v2-vite.config.mjs";
	const configPath = path.join(root, configFilename);
	const textExtensions = new Set(${JSON.stringify(NATIVE_SOURCE_TEXT_FILE_EXTENSIONS)});
	const binaryExtensions = new Set(${JSON.stringify(NATIVE_SOURCE_BINARY_FILE_EXTENSIONS)});
	const textBasenames = new Set(${JSON.stringify(NATIVE_SOURCE_TEXT_BASENAMES)});
	const lockFilenames = new Set(${JSON.stringify(NATIVE_SOURCE_LOCK_FILENAMES)});
	const ignoredFiles = new Set(["${NATIVE_SOURCE_PREFLIGHT_FILENAME}", "${NATIVE_SOURCE_PREFLIGHT_V2_FILENAME}", "${NATIVE_RUNTIME_CONTRACT_FILENAME}", "${NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME}", configFilename]);
	const safeUrls = new Set(["http://www.w3.org/1999/xlink", "http://www.w3.org/1998/Math/MathML", "http://www.w3.org/1999/xhtml", "http://www.w3.org/2000/svg", "http://www.w3.org/2000/xmlns/", "http://www.w3.org/2001/XMLSchema-instance", "http://www.w3.org/XML/1998/namespace"]);
	const issues = [];
	const add = (code, file, detail) => issues.push({ code, file, detail });
	const textFiles = new Map();
	const presentFiles = new Set();
	let fileCount = 0;
	let expandedBytes = 0;
	const fileKind = (relative) => {
	  const basename = path.posix.basename(relative);
	  const extension = path.posix.extname(relative).toLowerCase();
	  if (lockFilenames.has(basename)) return "lock";
	  if (textExtensions.has(extension) || textBasenames.has(basename.toLowerCase())) return "text";
	  if (binaryExtensions.has(extension)) return "binary";
	  return null;
	};
	const walk = (directory) => {
	  for (const entry of readdirSync(directory, { withFileTypes: true })) {
	    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
	    const absolute = path.join(directory, entry.name);
	    const relative = path.relative(root, absolute).split(path.sep).join("/");
	    if (entry.isDirectory()) { walk(absolute); continue; }
	    if (!entry.isFile()) { add("FILE_TYPE_FORBIDDEN", relative, "non-file entry"); continue; }
	    const metadata = statSync(absolute);
	    fileCount += 1;
	    expandedBytes += metadata.size;
	    if (fileCount > ${NATIVE_SOURCE_MAX_FILES}) add("FILE_COUNT_LIMIT", relative, "over ${NATIVE_SOURCE_MAX_FILES} files");
	    if (expandedBytes > ${NATIVE_SOURCE_MAX_EXPANDED_BYTES}) add("EXPANDED_BYTES_LIMIT", relative, "over ${NATIVE_SOURCE_MAX_EXPANDED_BYTES} bytes");
	    if (metadata.size > ${NATIVE_SOURCE_MAX_SINGLE_FILE_BYTES}) { add("FILE_TOO_LARGE", relative, "over ${NATIVE_SOURCE_MAX_SINGLE_FILE_BYTES} bytes"); continue; }
	    if (Buffer.byteLength(relative, "utf8") > ${NATIVE_SOURCE_MAX_PATH_BYTES} || relative.split("/").length > ${NATIVE_SOURCE_MAX_PATH_DEPTH} || relative.split("/").some((part) => Buffer.byteLength(part, "utf8") > ${NATIVE_SOURCE_MAX_PATH_SEGMENT_BYTES})) { add("PATH_LIMIT", relative, "path outside host limits"); continue; }
	    const kind = fileKind(relative);
	    if (!kind) { add("FILE_TYPE_FORBIDDEN", relative, "extension"); continue; }
	    presentFiles.add(relative);
	    if (!ignoredFiles.has(relative) && kind !== "binary") textFiles.set(relative, readFileSync(absolute, "utf8"));
	  }
	};
	const withoutSourceComments = (text) => {
	  let output = "";
	  let quote = null;
	  let escaped = false;
	  for (let index = 0; index < text.length; index += 1) {
	    const current = text[index];
	    const next = text[index + 1] || "";
	    if (quote) {
	      output += current;
	      if (escaped) escaped = false;
	      else if (current === "\\") escaped = true;
	      else if (current === quote) quote = null;
	      continue;
	    }
	    if (current === "\"" || current === "'" || current === "\x60") { quote = current; output += current; continue; }
	    if (current === "/" && next === "/") {
	      output += "  "; index += 2;
	      while (index < text.length && !/[\r\n]/u.test(text[index])) { output += " "; index += 1; }
	      if (index < text.length) output += text[index];
	      continue;
	    }
	    if (current === "/" && next === "*") {
	      output += "  "; index += 2;
	      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) { output += /[\r\n]/u.test(text[index]) ? text[index] : " "; index += 1; }
	      if (index < text.length) output += "  ";
	      continue;
	    }
	    output += current;
	  }
	  return output;
	};
	const canonicalRoutePath = (value) => {
	  if (typeof value !== "string" || value.trim() !== value || value.length < 1 || value.length > 191) return null;
	  const withSlash = value === "/" ? "/" : "/" + value.replace(/^\/+|\/+$/gu, "") + "/";
	  const parts = withSlash.split("/").filter(Boolean);
	  if (withSlash.includes("\\") || withSlash.includes("%") || withSlash.includes("?") || withSlash.includes("#") || withSlash.includes("\0") || withSlash.normalize("NFKC") !== withSlash || parts.some((part) => part === "." || part === ".." || !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u.test(part))) return null;
	  return parts.length === 0 ? "/" : "/" + parts.join("/") + "/";
	};

	let contract = null;
	let contractBytes = null;
	try {
	  contractBytes = readFileSync(contractPath);
	  contract = JSON.parse(contractBytes.toString("utf8"));
	  if (contract?.schemaVersion !== 1 || contract?.contractVersion !== "${NATIVE_RUNTIME_CONTRACT_VERSION}" || contract?.runtime !== "frontmind-controlled-vite-spa-v1" || contract?.routing?.manifestExport !== "${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT}") add("CONTRACT_INVALID", "${NATIVE_RUNTIME_CONTRACT_FILENAME}", "coordinates");
	} catch { add("CONTRACT_INVALID", "${NATIVE_RUNTIME_CONTRACT_FILENAME}", "missing or invalid JSON"); }
	rmSync(configPath, { force: true });
	walk(root);

	for (const required of ["${NATIVE_RUNTIME_HTML_ENTRYPOINT}", "${NATIVE_RUNTIME_APP_ENTRYPOINT}", "${NATIVE_RUNTIME_ROUTE_MODULE}", "package.json"]) {
	  if (!presentFiles.has(required)) add("ENTRYPOINT_MISSING", required, "required by runtime contract");
	}
	let pkg = null;
	try { pkg = JSON.parse(textFiles.get("package.json") || ""); } catch { add("PACKAGE_INVALID", "package.json", "invalid JSON"); }
	if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) add("PACKAGE_INVALID", "package.json", "object required");
	if (pkg && contract) {
	  if (pkg.scripts?.build !== "vite build") add("BUILD_COMMAND_INVALID", "package.json", "host-managed Vite required");
  for (const lifecycle of ["preinstall", "install", "postinstall", "prepare", "prepublish", "prepublishOnly", "publish", "postpublish"]) {
    if (Object.prototype.hasOwnProperty.call(pkg.scripts || {}, lifecycle)) add("LIFECYCLE_SCRIPT_FORBIDDEN", "package.json", lifecycle);
  }
	  const dependencies = Object.assign({}, pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies);
	  for (const required of contract.dependencies?.required || []) if (!Object.prototype.hasOwnProperty.call(dependencies, required)) add("DEPENDENCY_REQUIRED", "package.json", required);
	  for (const [name, version] of Object.entries(dependencies)) {
	    if (["next", "gatsby", "wasp", "@wasp/core"].includes(name)) add("FRAMEWORK_FORBIDDEN", "package.json", name);
	    const expected = contract.dependencies?.allowedExactVersions?.[name];
    if (!expected) add("DEPENDENCY_FORBIDDEN", "package.json", name);
    else if (version !== expected) add("DEPENDENCY_VERSION_MISMATCH", "package.json", name + ":" + String(version));
	  }
	}

	const html = textFiles.get("${NATIVE_RUNTIME_HTML_ENTRYPOINT}") || "";
	if (html !== ${JSON.stringify(NATIVE_RUNTIME_HTML_SHELL_V1_TEXT)}) add("HTML_SHELL_INVALID", "${NATIVE_RUNTIME_HTML_ENTRYPOINT}", "service-owned shell bytes");
	const main = textFiles.get("${NATIVE_RUNTIME_APP_ENTRYPOINT}") || "";
	if (main !== ${JSON.stringify(NATIVE_RUNTIME_APP_SHELL_V1_TEXT)}) add("APP_SHELL_INVALID", "${NATIVE_RUNTIME_APP_ENTRYPOINT}", "service-owned shell bytes");
	const routes = textFiles.get("${NATIVE_RUNTIME_ROUTE_MODULE}") || "";
	if (/\bimport\s*\(/u.test(routes)) add("DYNAMIC_IMPORT_FORBIDDEN", "${NATIVE_RUNTIME_ROUTE_MODULE}", "eager routes required");
	if (!/\bimport\s+(?:[^"']+\s+from\s+)?["']/u.test(routes)) add("EAGER_ROUTES_REQUIRED", "${NATIVE_RUNTIME_ROUTE_MODULE}", "static imports required");
	const routeManifestMatch = /export\s+const\s+${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT}\s*=\s*(\[[\s\S]*?\])\s+as\s+const\s*;/u.exec(routes);
	let routeManifest = null;
	try { routeManifest = routeManifestMatch ? JSON.parse(routeManifestMatch[1]) : null; } catch { routeManifest = null; }
	if (!Array.isArray(routeManifest) || routeManifest.length < 1 || routeManifest.length > 30 || routeManifest.some((value) => canonicalRoutePath(value) !== value) || new Set(routeManifest).size !== routeManifest.length) add("ROUTE_MANIFEST_INVALID", "${NATIVE_RUNTIME_ROUTE_MODULE}", "literal canonical unique paths required");

	for (const [filename, rawText] of textFiles) {
	  if (/^(?:vite|next|gatsby|wasp)(?:\.[^/]*)?\.config\.[cm]?[jt]s$/iu.test(filename) || /^(?:gatsby-(?:browser|node|ssr)|waspfile)\.[cm]?[jt]sx?$/iu.test(filename)) add("HOST_CONFIG_FORBIDDEN", filename, "host owns Vite configuration");
	  if (!/\.(?:css|html|js|jsx|less|mjs|sass|scss|svg|ts|tsx)$/iu.test(filename)) continue;
	  const text = withoutSourceComments(rawText);
	  const remoteUrls = text.match(/https?:\/\/[^\s"'\x60<>{}\\\\]+/giu) || [];
	  if (remoteUrls.some((url) => !safeUrls.has(url)) || /["'\x60]\/\/[A-Za-z0-9\[]/u.test(text) || /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u.test(text) || /\bnavigator\s*\.\s*sendBeacon\s*\(/u.test(text) || /\baxios\s*\./u.test(text)) add("REMOTE_RESOURCE_FORBIDDEN", filename, "network or remote URL");
  if (/\beval\s*\(/u.test(text) || /\bnew\s+Function\s*\(/u.test(text) || /\b(?:setTimeout|setInterval)\s*\(\s*["'\x60]/u.test(text)) add("DYNAMIC_EXECUTION_FORBIDDEN", filename, "dynamic execution");
  if (/\bimport\s*\(/u.test(text)) add("DYNAMIC_IMPORT_FORBIDDEN", filename, "dynamic import");
	  if (/(?:from\s*|require\s*\(\s*)["'](?:next(?:\/[^"']*)?|gatsby(?:\/[^"']*)?|wasp(?:\/[^"']*)?|@wasp\/core(?:\/[^"']*)?)["']/u.test(text)) add("FRAMEWORK_FORBIDDEN", filename, "Next/Gatsby/Wasp import");
	}

	if (!issues.length) {
	  const sourcePaths = [...presentFiles];
	  const hasRootAliasTargets = sourcePaths.some((value) => /^(?:app|components|hooks|lib|pages)\//u.test(value));
	  const hasSrcAliasTargets = sourcePaths.some((value) => /^src\/(?:app|components|hooks|lib|pages)\//u.test(value));
	  const aliasRoot = hasRootAliasTargets && !hasSrcAliasTargets ? "." : "src";
	  const useTailwind = [...textFiles].some(([filename, text]) => /\.(?:css|less|sass|scss)$/iu.test(filename) && /@tailwind\s+|@import\s+["']tailwindcss(?:\/[^"']*)?["']/iu.test(text));
	  const vitePackageName = ["vi", "te"].join("");
	  const configSource = [
	    'import path from "node:path";',
	    'import { defineConfig } from "' + vitePackageName + '";',
	    useTailwind ? 'import tailwindcss from "@tailwindcss/vite";' : '',
	    "const root = " + JSON.stringify(root) + ";",
	    "export default defineConfig({ root, base: \"/\", configFile: false, publicDir: \"public\", appType: \"spa\", plugins: " + (useTailwind ? "[tailwindcss()]" : "[]") + ", resolve: { alias: [{ find: \"@/frontmind-next\", replacement: path.join(root, \"src/frontmind-next\") }, { find: \"@\", replacement: path.join(root, " + JSON.stringify(aliasRoot) + ") }], dedupe: [\"react\", \"react-dom\"] }, define: { \"process.env.NODE_ENV\": JSON.stringify(\"production\"), \"process.env\": JSON.stringify({}), global: \"globalThis\" }, esbuild: { jsx: \"automatic\", jsxDev: false }, build: { outDir: path.join(root, \"dist\"), emptyOutDir: true, copyPublicDir: true, assetsInlineLimit: 4096, cssCodeSplit: false, sourcemap: false, minify: \"esbuild\", target: \"es2020\", reportCompressedSize: false, rollupOptions: { input: path.join(root, \"index.html\"), output: { inlineDynamicImports: true, entryFileNames: \"assets/app-[hash].js\", chunkFileNames: \"assets/chunk-[hash].js\", assetFileNames: \"assets/[name]-[hash][extname]\" } } } });",
	    "",
	  ].filter(Boolean).join("\n");
	  try {
	    writeFileSync(configPath, configSource, { encoding: "utf8", mode: 0o600 });
	    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
	    const built = spawnSync(npm, ["--ignore-scripts", "run", "build", "--", "--config", configPath], { cwd: root, encoding: "utf8", shell: false, timeout: 120000 });
	    if (built.error || built.status !== 0) add("BUILD_FAILED", "package.json", String(built.stderr || built.stdout || built.error?.message || "host-owned Vite config").slice(-4000));
	    else { try { statSync(path.join(root, "dist", "index.html")); } catch { add("DIST_ENTRYPOINT_MISSING", "dist/index.html", "Vite output"); } }
	  } finally {
	    rmSync(configPath, { force: true });
	  }
	}
	if (issues.length) {
	  issues.sort((left, right) => (left.code + ":" + left.file + ":" + left.detail).localeCompare(right.code + ":" + right.file + ":" + right.detail));
	  throw new Error("PREFLIGHT_V2_FAILED:" + JSON.stringify(issues));
	}
	process.stdout.write(JSON.stringify({ version: "${NATIVE_SOURCE_PREFLIGHT_V2_VERSION}", status: "passed", runtimeContractVersion: "${NATIVE_RUNTIME_CONTRACT_VERSION}", runtimeContractSha256: createHash("sha256").update(contractBytes).digest("hex") }) + "\n");
	`,
  "utf8",
);
export const NATIVE_SOURCE_PREFLIGHT_V2_SHA256 = createHash("sha256")
  .update(NATIVE_SOURCE_PREFLIGHT_V2_SCRIPT)
  .digest("hex");

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const nativeRuntimeContractV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    contractVersion: z.literal(NATIVE_RUNTIME_CONTRACT_VERSION),
    runtime: z.literal("frontmind-controlled-vite-spa-v1"),
    entrypoints: z
      .object({
        html: z.literal(NATIVE_RUNTIME_HTML_ENTRYPOINT),
        app: z.literal(NATIVE_RUNTIME_APP_ENTRYPOINT),
        routes: z.literal(NATIVE_RUNTIME_ROUTE_MODULE),
        rootElementId: z.literal(NATIVE_RUNTIME_ROOT_ELEMENT_ID),
      })
      .strict(),
    routing: z
      .object({
        mode: z.literal("eager-client-routes"),
        source: z.literal("sitebrief"),
        dynamicImports: z.literal("forbidden"),
        manifestModule: z.literal(NATIVE_RUNTIME_ROUTE_MODULE),
        manifestExport: z.literal(NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT),
        pathFormat: z.literal("canonical-trailing-slash"),
      })
      .strict(),
    vite: z
      .object({
        owner: z.literal("frontmind-host"),
        providerConfig: z.literal("forbidden"),
        buildCommand: z.literal("vite build"),
      })
      .strict(),
    dependencies: z
      .object({
        required: z.tuple([
          z.literal("react"),
          z.literal("react-dom"),
          z.literal("vite"),
        ]),
        allowedExactVersions: z.record(
          z.string().min(1).max(191),
          z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u),
        ),
      })
      .strict(),
    security: z
      .object({
        forbiddenFrameworkDependencies: z.tuple([
          z.literal("next"),
          z.literal("gatsby"),
          z.literal("wasp"),
          z.literal("@wasp/core"),
        ]),
        lifecycleScripts: z.literal("forbidden"),
        remoteResources: z.literal("forbidden"),
        dynamicExecution: z.literal("forbidden"),
        dynamicImports: z.literal("forbidden"),
      })
      .strict(),
  })
  .strict()
  .superRefine((contract, context) => {
    const expectedDependencies = [...NATIVE_SOURCE_ALLOWED_DEPENDENCIES].sort();
    const actualDependencies = Object.keys(
      contract.dependencies.allowedExactVersions,
    ).sort();
    if (
      expectedDependencies.length !== actualDependencies.length ||
      expectedDependencies.some(
        (dependency, index) => dependency !== actualDependencies[index],
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["dependencies", "allowedExactVersions"],
        message: "Runtime dependency map must match the host allowlist",
      });
    }
    for (const dependency of NATIVE_SOURCE_ALLOWED_DEPENDENCIES) {
      if (
        contract.dependencies.allowedExactVersions[dependency] !==
        NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS[dependency]
      ) {
        context.addIssue({
          code: "custom",
          path: ["dependencies", "allowedExactVersions", dependency],
          message: "Runtime dependency version must match the frozen contract",
        });
      }
    }
  });

export type NativeRuntimeContractV1 = z.infer<
  typeof nativeRuntimeContractV1Schema
>;

export const siteSourceReceiptV1Schema = z
  .object({
    operationToken: z.string().min(1).max(256),
    baseSourceSha256: z.string().regex(SHA256_PATTERN),
    archiveSha256: z.string().regex(SHA256_PATTERN),
    fileCount: z.number().int().min(1).max(512),
    preflightVersion: z.literal(NATIVE_SOURCE_PREFLIGHT_VERSION).optional(),
    preflightStatus: z.literal("passed").optional(),
    preflightSha256: z.literal(NATIVE_SOURCE_PREFLIGHT_SHA256).optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const fields = [
      receipt.preflightVersion,
      receipt.preflightStatus,
      receipt.preflightSha256,
    ];
    if (
      fields.some((value) => value !== undefined) &&
      fields.some((value) => value === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["preflightVersion"],
        message: "Preflight receipt coordinates must be complete",
      });
    }
  });

export type SiteSourceReceiptV1 = z.infer<typeof siteSourceReceiptV1Schema>;

export const siteSourceReceiptV2Schema = z
  .object({
    operationToken: z.string().min(1).max(256),
    baseSourceSha256: z.string().regex(SHA256_PATTERN),
    archiveSha256: z.string().regex(SHA256_PATTERN),
    fileCount: z.number().int().min(1).max(512),
    preflightVersion: z.literal(NATIVE_SOURCE_PREFLIGHT_V2_VERSION),
    preflightStatus: z.literal("passed"),
    preflightSha256: z.literal(NATIVE_SOURCE_PREFLIGHT_V2_SHA256),
    runtimeContractVersion: z.literal(NATIVE_RUNTIME_CONTRACT_VERSION),
    runtimeContractSha256: z.string().regex(SHA256_PATTERN),
    executionShellSha256: z.string().regex(SHA256_PATTERN),
    executionBaselineSha256: z.string().regex(SHA256_PATTERN),
    /** Present and mandatory at the 2.9 provider boundary; optional here for 2.8 replay. */
    contentPlanSha256: z.string().regex(SHA256_PATTERN).optional(),
  })
  .strict();

export const siteSourceReceiptSchema = z.union([
  siteSourceReceiptV2Schema,
  siteSourceReceiptV1Schema,
]);

export type SiteSourceReceiptV2 = z.infer<typeof siteSourceReceiptV2Schema>;
export type SiteSourceReceipt = z.infer<typeof siteSourceReceiptSchema>;

/**
 * This is an instruction boundary, not a byte/pixel comparison gate. The
 * returned archive still has to pass the local archive, dependency, execution
 * and network safety checks below before it can be compiled.
 */
export const TWENTY_FIRST_NATIVE_SOURCE_SYSTEM_PROMPT = `你是企业官网内容替换与信息架构执行者，不是视觉设计师。

附件中的 21st React 项目是唯一视觉与内容结构基线；随附的 ${NATIVE_RUNTIME_CONTRACT_FILENAME} 与 ${NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME} 是唯一执行基线。你必须返回一份完整、可独立构建的源码 ZIP，不得返回 diff、代码围栏、解释或摘要。

绝对禁止重新设计。不得主动修改：
- CSS、SCSS、Tailwind 配置和设计 Token
- className、style 属性、颜色、字体、间距、圆角、阴影和边框
- SVG 几何结构、图形构图和装饰
- 动画、transition、响应式断点
- 已保留区块的组件层级、排列和视觉结构
- 与执行适配无关的 import、依赖、构建配置和文件组织

只允许：
- 使用知识库事实替换用户可见文案
- 替换为已提供且经过验证的企业媒体
- 调整路由、导航和页面数据
- 删除知识库没有依据的可选页面或完整可选区块
- 复用原有页面外壳和组件创建知识库确实需要的子页面
- 将原项目的 Next、Gatsby 或 Wasp 运行时静态适配为 FrontMind 管理的 Vite SPA；这项适配不得改变视觉
- 精确合并随附的无样式 execution shell，并在 ${NATIVE_RUNTIME_ROUTE_MODULE} 中使用静态 import 建立 SiteBrief 要求的全部路由；必须声明稳定字面量 \`export const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = ["/", "/about/"] as const;\`（以实际 SiteBrief 路由替换示例，使用规范尾斜杠、不得缺失、重复或额外增加）

保留页面中所有原生样式、组件与交互。删除页面或区块时必须同步删除对应导航入口，不得破坏其余页面。

任何企业事实都必须来自给定 sourceId。禁止编造价格、客户、案例、评价、新闻、资质、联系人或产品能力。

没有公开价格时：
- 若价格页属于可选页面，删除该页面和导航入口；
- 若原模板必须保留该区块，保持原卡片和布局，只将内容改为“联系咨询”或“获取方案”。

没有新闻或案例时：
- 可选页面直接移除；
- SiteBrief 明确要求保留时，使用原有组件展示可信空状态。

文案长度必须适配原有内容空间；优先摘要，不得通过修改字号、间距或布局容纳长文。

不得添加外部脚本、远程请求、HTML 注入、动态执行、动态 import、未知依赖或未提供的媒体。不得返回 Next、Gatsby、Wasp 或 provider 自有 Vite 配置。
package.json 只能使用 ${NATIVE_RUNTIME_CONTRACT_FILENAME} allowlist 中的依赖和精确版本，不得使用范围、标签或其他版本；build 必须精确为 vite build，Vite 配置由 FrontMind 宿主管理。

最终必须先运行随附的 ${NATIVE_SOURCE_PREFLIGHT_V2_FILENAME}，一次性修复其聚合报告中的全部问题，并确认 package、文件类型、依赖、入口、路由、源码安全和 production build 全部通过。然后只返回 ${FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME} 和 ${FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME}，立即结束；不得继续解释、复盘、浏览或更新计划。`;

/**
 * Workflow 2.7 deliberately keeps template fidelity and content quality as a
 * versioned instruction boundary. FrontMind still enforces the existing
 * archive, safety, build and browser-runtime checks, but this prompt does not
 * introduce a visual-similarity or editorial-quality acceptance contract.
 */
export const TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT = `你是负责交付生产级企业官网的高级前端工程师、内容设计师和构建负责人。

目标：
基于附件中的原始 21st Template 源码和企业知识 dossier，
生成一份完整、可独立安装、可执行 production build、
可由 FrontMind Dashboard 展示的网站源码 ZIP。
这是适配用户选中的模板，不是从零重新设计。

输入边界：
1. Template ZIP 是唯一源码和视觉基线。
2. 企业 dossier、SiteBrief 和已验证媒体是唯一企业事实来源。
3. 不得通过网络补造客户、案例、价格、资质、新闻、数字或联系方式。
4. 缺少事实时删除可选页面或区块，不使用模板示例内容填充。

执行顺序：
1. 先理解模板现有入口、路由、组件、布局、动画和响应式方式。
2. 在内部建立“页面目的 × 用户问题 × 企业事实 × CTA”的内容映射。
3. 再将企业内容适配进现有模板组件。
4. 最后执行完整 build 和 preflight；不要输出思考过程。

内容与信息架构：
- 每个一级导航必须有唯一用途。
- 禁止同时生成“产品与服务 / 产品 / 服务”等语义重复入口。
- 产品和服务资料无法明确拆分时，只保留一个“产品与服务”入口。
- 每个页面必须有独立 title、H1、价值主张、证据组合和 CTA。
- 同一完整段落不得在多个页面或卡片中重复。
- 首页只做总览；关于、产品、服务、方案、案例等页面分别展开自己的主题。
- 没有真实案例、新闻、价格或资质时，删除对应页面或使用可信空状态。
- 不得残留模板示例品牌、示例文案、占位图片、演示数据或外部演示链接。

模板风格：
- 保留选中模板的整体视觉语言、布局体系、组件、字体层级、颜色、间距、动效、媒体处理和响应式行为。
- 优先只修改文案、媒体、链接、路由数据和页面组合。
- 可以复用模板已有组件构造企业确实需要的页面。
- 仅为真实内容溢出或移动端响应式问题做小幅 CSS/结构调整。
- 不得把模板改造成通用卡片站、默认紫色渐变站或另一套设计。

构建：
- 选中模板是视觉基线；${NATIVE_RUNTIME_CONTRACT_FILENAME} 与 ${NATIVE_RUNTIME_EXECUTION_SHELL_FILENAME} 是执行基线。
- 即使原模板是 Next、Gatsby 或 Wasp，也必须在不改变视觉的前提下静态适配为 FrontMind 宿主管理的 Vite SPA。
- 精确保留无样式 execution shell，并在 ${NATIVE_RUNTIME_ROUTE_MODULE} 中对 SiteBrief 全部路由使用 eager static import；同时声明与 SiteBrief 精确一致、规范尾斜杠且唯一的 \`export const ${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} = [...] as const;\`；禁止动态 import。
- package.json 只能使用 runtime contract allowlist 中的精确依赖版本，build 必须精确为 vite build；不得提供 Vite/Next/Gatsby/Wasp 配置。
- 不添加未经允许的依赖、远程脚本、运行时网络请求、远程资源或动态执行代码。
- 依次完成类型检查（如适用）、production build、所有路由访问和 ${NATIVE_SOURCE_PREFLIGHT_V2_FILENAME}；preflight 的聚合问题必须一次修完。
- 任一步失败必须先修复并重新执行，不得交付无法编译的 ZIP。

交付：
只返回一个 ${FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME} 和一个 ${FRONTMIND_SITE_SOURCE_RECEIPT_FILENAME}。
上传完成后立即结束，不继续解释、复盘、浏览或更新计划。`;

const STATIC_TEMPLATE_REDUNDANT_TARGET_PREAMBLE = `目标：
基于附件中的原始 21st Template 源码和企业知识 dossier，
生成一份完整、可独立安装、可执行 production build、
可由 FrontMind Dashboard 展示的网站源码 ZIP。
`;

/** Workflow 2.8 keeps the complete 2.7 Template adaptation semantics and adds
 * one explicit static-site capability boundary. The redundant target preamble
 * is already enforced by the input/build/delivery sections and is omitted to
 * keep the outbound Manus prompt within its fixed budget. Historical 2.7
 * operations continue to replay with their original prompt bytes. */
export const TWENTY_FIRST_STATIC_TEMPLATE_V2_8_SYSTEM_PROMPT = `${TWENTY_FIRST_NATIVE_TEMPLATE_V2_7_SYSTEM_PROMPT.replace(
  STATIC_TEMPLATE_REDUNDANT_TARGET_PREAMBLE,
  "",
)}

应用能力边界：
不得保留或新增认证、支付、订阅、数据库、管理后台、聊天机器人、外部统计、第三方 webhook、服务端 API 或知识库未要求的其他运行时能力；模板原有此类能力时，必须移除对应入口、表单和误导性 CTA。`;

export type NativeSourceLimits = {
  maxArchiveBytes: number;
  maxFiles: number;
  maxSingleFileBytes: number;
  maxExpandedBytes: number;
  maxPathBytes: number;
  maxPathDepth: number;
};

export const NATIVE_SOURCE_DEFAULT_LIMITS: Readonly<NativeSourceLimits> =
  Object.freeze({
    maxArchiveBytes: 24 * 1024 * 1024,
    maxFiles: NATIVE_SOURCE_MAX_FILES,
    maxSingleFileBytes: NATIVE_SOURCE_MAX_SINGLE_FILE_BYTES,
    maxExpandedBytes: NATIVE_SOURCE_MAX_EXPANDED_BYTES,
    maxPathBytes: NATIVE_SOURCE_MAX_PATH_BYTES,
    maxPathDepth: NATIVE_SOURCE_MAX_PATH_DEPTH,
  });

/** Host-owned, data-only Tailwind v3 coordinates. Templates cannot import or
 * declare this as a package; the controlled compiler consumes the JSON. */
export const NATIVE_SOURCE_TAILWIND_V3_CONFIG_PATH =
  "frontmind-tailwind-v3.json" as const;

export type NativeReactSourceErrorCode =
  | "NATIVE_SOURCE_ARCHIVE_INVALID"
  | "NATIVE_SOURCE_ZIP_INVALID"
  | "NATIVE_SOURCE_PACKAGE_JSON_INVALID"
  | "NATIVE_SOURCE_PACKAGE_SHAPE_INVALID"
  | "NATIVE_SOURCE_FILE_TYPE_FORBIDDEN"
  | "NATIVE_SOURCE_ARCHIVE_HASH_MISMATCH"
  | "NATIVE_SOURCE_TOKEN_MISMATCH"
  | "NATIVE_SOURCE_BASE_HASH_MISMATCH"
  | "NATIVE_SOURCE_PATH_INVALID"
  | "NATIVE_SOURCE_PATH_COLLISION"
  | "NATIVE_SOURCE_SYMLINK_FORBIDDEN"
  | "NATIVE_SOURCE_LIMIT_EXCEEDED"
  | "NATIVE_SOURCE_TEXT_INVALID"
  | "NATIVE_SOURCE_SECRET_FORBIDDEN"
  | "NATIVE_SOURCE_DYNAMIC_EXECUTION_FORBIDDEN"
  | "NATIVE_SOURCE_SERVER_API_FORBIDDEN"
  | "NATIVE_SOURCE_NETWORK_FORBIDDEN"
  | "NATIVE_SOURCE_HTML_INJECTION_FORBIDDEN"
  | "NATIVE_SOURCE_STYLE_EXECUTION_FORBIDDEN"
  | "NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN"
  | "NATIVE_SOURCE_DEPENDENCY_FORBIDDEN"
  | "NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH"
  | "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN"
  | "NATIVE_SOURCE_RUNTIME_CONTRACT_INVALID"
  | "NATIVE_SOURCE_ENTRYPOINT_INVALID"
  | "NATIVE_SOURCE_RECEIPT_INVALID"
  | "NATIVE_SOURCE_ATTACHMENT_INVALID"
  | "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE";

export class NativeReactSourceError extends Error {
  constructor(
    readonly code: NativeReactSourceErrorCode,
    readonly retryable = false,
    readonly status: number | null = null,
  ) {
    super(code);
    this.name = "NativeReactSourceError";
  }
}

export const nativeRuntimeAuditIssueCodeSchema = z.enum([
  "CONTRACT_INVALID",
  "REQUIRED_FILE_MISSING",
  "PACKAGE_JSON_INVALID",
  "BUILD_COMMAND_INVALID",
  "LIFECYCLE_SCRIPT_FORBIDDEN",
  "DEPENDENCY_REQUIRED",
  "DEPENDENCY_FORBIDDEN",
  "DEPENDENCY_VERSION_MISMATCH",
  "ROOT_ELEMENT_MISSING",
  "HTML_SHELL_INVALID",
  "APP_ENTRYPOINT_MISMATCH",
  "APP_SHELL_INVALID",
  "EAGER_ROUTES_REQUIRED",
  "ROUTE_MANIFEST_INVALID",
  "ROUTE_MANIFEST_MISMATCH",
  "CANONICAL_PATHNAME_REQUIRED",
  "HOST_CONFIG_FORBIDDEN",
  "FRAMEWORK_FORBIDDEN",
  "REMOTE_RESOURCE_FORBIDDEN",
  "DYNAMIC_EXECUTION_FORBIDDEN",
  "DYNAMIC_IMPORT_FORBIDDEN",
]);

export type NativeRuntimeAuditIssueCode = z.infer<
  typeof nativeRuntimeAuditIssueCodeSchema
>;

export type NativeRuntimeAuditIssue = Readonly<{
  code: NativeRuntimeAuditIssueCode;
  path: string;
  detail: string;
}>;

export type NativeRuntimeAudit = Readonly<{
  ok: boolean;
  issues: readonly NativeRuntimeAuditIssue[];
}>;

export class NativeRuntimeContractAuditError extends NativeReactSourceError {
  constructor(readonly audit: NativeRuntimeAudit) {
    super("NATIVE_SOURCE_RUNTIME_CONTRACT_INVALID");
    this.name = "NativeRuntimeContractAuditError";
  }
}

export type ValidatedNativeReactSource = {
  receipt: SiteSourceReceipt;
  archiveSha256: string;
  sourceSha256: string;
  sourceZip: Buffer;
  fileCount: number;
  htmlEntrypoint: "index.html";
  entrypoint: string;
  packageJson: Readonly<Record<string, unknown>>;
  files: ReadonlyMap<string, Buffer>;
};

type ZipMetadata = {
  uncompressedSize?: number;
};

type UnsafeZipObject = JSZipObject & {
  unsafeOriginalName?: string;
  _data?: ZipMetadata;
};

const NATIVE_SOURCE_TEXT_EXTENSION_SET = new Set<string>(
  NATIVE_SOURCE_TEXT_FILE_EXTENSIONS,
);
const NATIVE_SOURCE_BINARY_EXTENSION_SET = new Set<string>(
  NATIVE_SOURCE_BINARY_FILE_EXTENSIONS,
);
const NATIVE_SOURCE_TEXT_BASENAME_SET = new Set<string>(
  NATIVE_SOURCE_TEXT_BASENAMES,
);
const NATIVE_SOURCE_LOCK_FILENAME_SET = new Set<string>(
  NATIVE_SOURCE_LOCK_FILENAMES,
);

function nativeSourcePathKind(pathname: string) {
  const basename = path.posix.basename(pathname);
  const extension = path.posix.extname(pathname).toLowerCase();
  if (NATIVE_SOURCE_LOCK_FILENAME_SET.has(basename)) return "lock" as const;
  if (
    NATIVE_SOURCE_TEXT_EXTENSION_SET.has(extension) ||
    NATIVE_SOURCE_TEXT_BASENAME_SET.has(basename.toLowerCase())
  ) {
    return "text" as const;
  }
  if (NATIVE_SOURCE_BINARY_EXTENSION_SET.has(extension)) {
    return "binary" as const;
  }
  return null;
}
const SOURCE_CODE_PATTERN = /\.(?:cjs|js|jsx|mjs|ts|tsx)$/iu;
const BUILD_CONFIG_PATTERN =
  /(?:^|\/)(?:vite|tailwind|postcss)\.config\.(?:cjs|js|mjs|ts)$/u;

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

function secureStringEqual(left: string, right: string) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.length === rightBytes.length &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function effectiveLimits(
  requested: Partial<NativeSourceLimits> | undefined,
): NativeSourceLimits {
  const bounded = (key: keyof NativeSourceLimits) => {
    const requestedValue = requested?.[key];
    if (!Number.isSafeInteger(requestedValue) || Number(requestedValue) < 1) {
      return NATIVE_SOURCE_DEFAULT_LIMITS[key];
    }
    return Math.min(Number(requestedValue), NATIVE_SOURCE_DEFAULT_LIMITS[key]);
  };
  return {
    maxArchiveBytes: bounded("maxArchiveBytes"),
    maxFiles: bounded("maxFiles"),
    maxSingleFileBytes: bounded("maxSingleFileBytes"),
    maxExpandedBytes: bounded("maxExpandedBytes"),
    maxPathBytes: bounded("maxPathBytes"),
    maxPathDepth: bounded("maxPathDepth"),
  };
}

function zipMode(entry: JSZipObject) {
  const value = entry.unixPermissions;
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^[0-7]+$/u.test(value)) {
    return Number.parseInt(value, 8);
  }
  return 0;
}

function assertSafeArchivePath(
  entry: UnsafeZipObject,
  limits: NativeSourceLimits,
) {
  const rawName = entry.unsafeOriginalName ?? entry.name;
  const normalized = rawName.normalize("NFKC");
  const withoutTrailingSlash = normalized.endsWith("/")
    ? normalized.slice(0, -1)
    : normalized;
  const parts = withoutTrailingSlash.split("/");
  if (
    rawName !== normalized ||
    withoutTrailingSlash.length < 1 ||
    normalized.startsWith("/") ||
    /^[a-z]:\//iu.test(normalized) ||
    normalized.includes("\\") ||
    normalized.includes("\0") ||
    normalized.includes("//") ||
    parts.some((part) => part === "." || part === ".." || part.length < 1) ||
    Buffer.byteLength(normalized, "utf8") > limits.maxPathBytes ||
    parts.length > limits.maxPathDepth ||
    parts.some(
      (part) =>
        Buffer.byteLength(part, "utf8") > NATIVE_SOURCE_MAX_PATH_SEGMENT_BYTES,
    )
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_PATH_INVALID");
  }
  const mode = zipMode(entry);
  if (mode && (mode & 0o170000) === 0o120000) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SYMLINK_FORBIDDEN");
  }
  return withoutTrailingSlash;
}

function commonArchiveRoot(paths: readonly string[]) {
  if (paths.length < 1) return null;
  const first = paths[0]!.split("/");
  if (first.length < 2) return null;
  const root = first[0]!;
  return paths.every((path) => path.startsWith(`${root}/`)) ? root : null;
}

function decodeUtf8(buffer: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw new NativeReactSourceError("NATIVE_SOURCE_TEXT_INVALID");
  }
}

function dependencyAllowed(name: string, allowed: ReadonlySet<string>) {
  return allowed.has(name);
}

const installedDependencyVersions = new Map<string, string>();

export function installedNativeSourceDependencyVersion(name: string) {
  const cached = installedDependencyVersions.get(name);
  if (cached) return cached;
  const require = createRequire(import.meta.url);
  try {
    let directory = path.dirname(require.resolve(name));
    for (let depth = 0; depth < 16; depth += 1) {
      const manifestPath = path.join(directory, "package.json");
      try {
        const manifest = JSON.parse(
          readFileSync(manifestPath, "utf8"),
        ) as Record<string, unknown>;
        if (
          manifest.name === name &&
          typeof manifest.version === "string" &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
        ) {
          installedDependencyVersions.set(name, manifest.version);
          return manifest.version;
        }
      } catch {
        // Continue to the package root that owns the resolved entry.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  } catch {
    // CSS-only packages may intentionally expose only the `style` condition,
    // so CommonJS resolution has no entrypoint. Resolve their package root
    // from Node's deterministic module search paths without bypassing the
    // closed dependency allowlist.
    for (const searchRoot of require.resolve.paths(name) ?? []) {
      try {
        const manifest = JSON.parse(
          readFileSync(path.join(searchRoot, name, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        if (
          manifest.name === name &&
          typeof manifest.version === "string" &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(manifest.version)
        ) {
          installedDependencyVersions.set(name, manifest.version);
          return manifest.version;
        }
      } catch {
        // Continue through the fixed Node module resolution roots.
      }
    }
  }
  throw new NativeReactSourceError("NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH");
}

export const nativeRuntimeExecutionShellV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    shellVersion: z.literal(NATIVE_RUNTIME_EXECUTION_SHELL_VERSION),
    contractVersion: z.literal(NATIVE_RUNTIME_CONTRACT_VERSION),
    files: z
      .array(
        z
          .object({
            path: z.enum([
              "package.json",
              NATIVE_RUNTIME_HTML_ENTRYPOINT,
              NATIVE_RUNTIME_APP_ENTRYPOINT,
            ]),
            text: z.string().min(1).max(128_000),
          })
          .strict(),
      )
      .length(3),
  })
  .strict()
  .superRefine((shell, context) => {
    const actual = shell.files.map((file) => file.path).sort();
    const expected = [
      "package.json",
      NATIVE_RUNTIME_HTML_ENTRYPOINT,
      NATIVE_RUNTIME_APP_ENTRYPOINT,
    ].sort();
    if (actual.some((value, index) => value !== expected[index])) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Execution shell must contain each host-owned file once",
      });
    }
  });

export type NativeRuntimeExecutionShellV1 = z.infer<
  typeof nativeRuntimeExecutionShellV1Schema
>;

function canonicalJsonBytes(value: unknown) {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function deepFreezeRuntimeValue<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreezeRuntimeValue(child);
    }
    Object.freeze(value);
  }
  return value;
}

function createNativeRuntimeContractV1(): NativeRuntimeContractV1 {
  return nativeRuntimeContractV1Schema.parse({
    schemaVersion: 1,
    contractVersion: NATIVE_RUNTIME_CONTRACT_VERSION,
    runtime: "frontmind-controlled-vite-spa-v1",
    entrypoints: {
      html: NATIVE_RUNTIME_HTML_ENTRYPOINT,
      app: NATIVE_RUNTIME_APP_ENTRYPOINT,
      routes: NATIVE_RUNTIME_ROUTE_MODULE,
      rootElementId: NATIVE_RUNTIME_ROOT_ELEMENT_ID,
    },
    routing: {
      mode: "eager-client-routes",
      source: "sitebrief",
      dynamicImports: "forbidden",
      manifestModule: NATIVE_RUNTIME_ROUTE_MODULE,
      manifestExport: NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT,
      pathFormat: "canonical-trailing-slash",
    },
    vite: {
      owner: "frontmind-host",
      providerConfig: "forbidden",
      buildCommand: "vite build",
    },
    dependencies: {
      required: [...NATIVE_RUNTIME_REQUIRED_DEPENDENCIES],
      allowedExactVersions: { ...NATIVE_RUNTIME_ALLOWED_EXACT_VERSIONS },
    },
    security: {
      forbiddenFrameworkDependencies: [
        ...NATIVE_RUNTIME_FORBIDDEN_FRAMEWORK_DEPENDENCIES,
      ],
      lifecycleScripts: "forbidden",
      remoteResources: "forbidden",
      dynamicExecution: "forbidden",
      dynamicImports: "forbidden",
    },
  });
}

function createNativeRuntimeExecutionShellV1(
  contract: NativeRuntimeContractV1,
): NativeRuntimeExecutionShellV1 {
  const packageJson = {
    name: "frontmind-native-site",
    private: true,
    version: "1.0.0",
    scripts: { build: contract.vite.buildCommand },
    dependencies: Object.fromEntries(
      contract.dependencies.required.map((dependency) => [
        dependency,
        contract.dependencies.allowedExactVersions[dependency],
      ]),
    ),
  };
  return nativeRuntimeExecutionShellV1Schema.parse({
    schemaVersion: 1,
    shellVersion: NATIVE_RUNTIME_EXECUTION_SHELL_VERSION,
    contractVersion: contract.contractVersion,
    files: [
      {
        path: "package.json",
        text: `${canonicalJson(packageJson)}\n`,
      },
      {
        path: NATIVE_RUNTIME_HTML_ENTRYPOINT,
        text: NATIVE_RUNTIME_HTML_SHELL_V1_TEXT,
      },
      {
        path: NATIVE_RUNTIME_APP_ENTRYPOINT,
        text: NATIVE_RUNTIME_APP_SHELL_V1_TEXT,
      },
    ],
  });
}

/** Frozen service-owned attachment coordinates for every new native build. */
export const NATIVE_RUNTIME_CONTRACT_V1 = Object.freeze(
  deepFreezeRuntimeValue(createNativeRuntimeContractV1()),
);
export const NATIVE_RUNTIME_CONTRACT_V1_BYTES = canonicalJsonBytes(
  NATIVE_RUNTIME_CONTRACT_V1,
);
export const NATIVE_RUNTIME_CONTRACT_V1_SHA256 = sha256(
  NATIVE_RUNTIME_CONTRACT_V1_BYTES,
);
export const NATIVE_RUNTIME_EXECUTION_SHELL_V1 = Object.freeze(
  deepFreezeRuntimeValue(
    createNativeRuntimeExecutionShellV1(NATIVE_RUNTIME_CONTRACT_V1),
  ),
);
export const NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES = canonicalJsonBytes(
  NATIVE_RUNTIME_EXECUTION_SHELL_V1,
);
export const NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256 = sha256(
  NATIVE_RUNTIME_EXECUTION_SHELL_V1_BYTES,
);

function assertPackageSafe(
  files: ReadonlyMap<string, Buffer>,
  allowedDependencies: ReadonlySet<string>,
) {
  const bytes = files.get("package.json");
  if (!bytes) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ENTRYPOINT_INVALID");
  }
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof NativeReactSourceError) throw error;
    throw new NativeReactSourceError("NATIVE_SOURCE_PACKAGE_JSON_INVALID");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_PACKAGE_SHAPE_INVALID");
  }
  const manifest = value as Record<string, unknown>;
  const scripts = manifest.scripts;
  if (scripts !== undefined) {
    if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) {
      throw new NativeReactSourceError("NATIVE_SOURCE_PACKAGE_SHAPE_INVALID");
    }
    const lifecycle = new Set([
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepublish",
      "prepublishOnly",
      "publish",
      "postpublish",
    ]);
    for (const [name, command] of Object.entries(
      scripts as Record<string, unknown>,
    )) {
      if (lifecycle.has(name)) {
        throw new NativeReactSourceError(
          "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN",
        );
      }
      if (
        typeof command !== "string" ||
        /(?:^|[\s;&|])(?:bash|curl|node\s+-e|npm|npx|pnpm|powershell|rm|sh|wget)(?:[\s;&|]|$)/iu.test(
          command,
        )
      ) {
        throw new NativeReactSourceError(
          "NATIVE_SOURCE_LIFECYCLE_SCRIPT_FORBIDDEN",
        );
      }
    }
  }
  for (const key of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ] as const) {
    const dependencies = manifest[key];
    if (dependencies === undefined) continue;
    if (
      !dependencies ||
      typeof dependencies !== "object" ||
      Array.isArray(dependencies)
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_DEPENDENCY_FORBIDDEN");
    }
    for (const [name, version] of Object.entries(
      dependencies as Record<string, unknown>,
    )) {
      if (
        !dependencyAllowed(name, allowedDependencies) ||
        typeof version !== "string" ||
        version.length > 96 ||
        /^(?:file|git(?:\+[^:]*)?|github|https?|link|workspace):/iu.test(
          version,
        )
      ) {
        throw new NativeReactSourceError("NATIVE_SOURCE_DEPENDENCY_FORBIDDEN");
      }
      if (version !== installedNativeSourceDependencyVersion(name)) {
        throw new NativeReactSourceError(
          "NATIVE_SOURCE_DEPENDENCY_VERSION_MISMATCH",
        );
      }
    }
  }
  return Object.freeze(manifest);
}

function assertNoSecrets(text: string, operationToken: string) {
  const patterns = [
    /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
    /\bAKIA[A-Z0-9]{16}\b/u,
    /\bLTAI[A-Za-z0-9]{12,}\b/u,
    /\bsk-(?:live|proj)?-?[A-Za-z0-9_-]{20,}\b/u,
    /(?:access[_-]?key[_-]?secret|api[_-]?key|app[_-]?secret|client[_-]?secret|private[_-]?key)\s*["']?\s*[:=]\s*["'][^"'\r\n]{12,}["']/iu,
  ];
  if (
    text.includes(operationToken) ||
    patterns.some((pattern) => pattern.test(text))
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SECRET_FORBIDDEN");
  }
}

function assertNoOperationTokenBytes(bytes: Buffer, operationToken: string) {
  if (bytes.indexOf(Buffer.from(operationToken, "utf8")) >= 0) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SECRET_FORBIDDEN");
  }
}

const SAFE_SOURCE_ABSOLUTE_URLS = new Set([
  "http://www.w3.org/1999/xlink",
  "http://www.w3.org/1998/Math/MathML",
  "http://www.w3.org/1999/xhtml",
  "http://www.w3.org/2000/svg",
  "http://www.w3.org/2000/xmlns/",
  "http://www.w3.org/2001/XMLSchema-instance",
  "http://www.w3.org/XML/1998/namespace",
]);

function withoutSourceComments(text: string) {
  let output = "";
  let quote: '"' | "'" | "`" | null = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const current = text[index]!;
    const next = text[index + 1] ?? "";
    if (quote) {
      output += current;
      if (escaped) escaped = false;
      else if (current === "\\") escaped = true;
      else if (current === quote) quote = null;
      continue;
    }
    if (current === '"' || current === "'" || current === "`") {
      quote = current;
      output += current;
      continue;
    }
    if (current === "/" && next === "/") {
      output += "  ";
      index += 2;
      while (index < text.length && !/[\r\n]/u.test(text[index]!)) {
        output += " ";
        index += 1;
      }
      if (index < text.length) output += text[index];
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      while (
        index < text.length &&
        !(text[index] === "*" && text[index + 1] === "/")
      ) {
        output += /[\r\n]/u.test(text[index]!) ? text[index] : " ";
        index += 1;
      }
      if (index < text.length) {
        output += "  ";
        index += 1;
      }
      continue;
    }
    output += current;
  }
  return output;
}

function assertNoExternalUrlLiterals(text: string) {
  const inspected = withoutSourceComments(text);
  const absoluteUrls = inspected.match(/https?:\/\/[^\s"'`<>{}\\]+/giu) ?? [];
  if (
    absoluteUrls.some((url) => !SAFE_SOURCE_ABSOLUTE_URLS.has(url)) ||
    /["'`]\/\/[A-Za-z0-9\[]/u.test(inspected)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
}

function assertSourceCodeSafe(path: string, text: string) {
  if (
    /\beval\s*\(/u.test(text) ||
    /\bnew\s+Function\s*\(/u.test(text) ||
    /\bimport\s*\(/u.test(text) ||
    /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/u.test(text)
  ) {
    throw new NativeReactSourceError(
      "NATIVE_SOURCE_DYNAMIC_EXECUTION_FORBIDDEN",
    );
  }
  const allowsBuildPath = BUILD_CONFIG_PATTERN.test(path);
  if (
    /(?:from\s*|require\s*\(\s*)["'](?:node:)?(?:child_process|cluster|dgram|dns|fs|http|https|module|net|os|tls|vm|worker_threads)(?:\/[^"']*)?["']/u.test(
      text,
    ) ||
    (!allowsBuildPath &&
      /(?:from\s*|require\s*\(\s*)["'](?:node:)?(?:buffer|crypto|path|process|stream|url|util)(?:\/[^"']*)?["']/u.test(
        text,
      )) ||
    /\bprocess\s*\.\s*(?:env|binding|dlopen)\b/u.test(text)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_SERVER_API_FORBIDDEN");
  }
  if (
    /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u.test(text) ||
    /\bnavigator\s*\.\s*sendBeacon\s*\(/u.test(text) ||
    /\baxios\s*\./u.test(text) ||
    /(?:from\s*|require\s*\(\s*)["']https?:\/\//iu.test(text) ||
    /\b(?:src|poster)\s*=\s*[{"'`]*\s*["'`]https?:\/\//iu.test(text) ||
    /<iframe\b/iu.test(text)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
  if (
    /\bdangerouslySetInnerHTML\b/u.test(text) ||
    /\.\s*(?:innerHTML|outerHTML)\s*=/u.test(text) ||
    /\binsertAdjacentHTML\s*\(/u.test(text) ||
    /\bdocument\s*\.\s*write(?:ln)?\s*\(/u.test(text)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_HTML_INJECTION_FORBIDDEN");
  }
  if (/\b(?:javascript|vbscript):|data:text\/html/iu.test(text)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
}

function importedStylePath(rawClause: string) {
  const clause = rawClause.trim();
  const quoted = /^(?:"([^"]+)"|'([^']+)')$/u.exec(clause);
  if (quoted) return quoted[1] ?? quoted[2] ?? null;
  const url = /^url\(\s*(?:"([^"]+)"|'([^']+)'|([^\s"')]+))\s*\)$/iu.exec(
    clause,
  );
  return url?.[1] ?? url?.[2] ?? url?.[3] ?? null;
}

function assertStyleImportsSafe(
  sourcePath: string,
  text: string,
  files: ReadonlyMap<string, Buffer>,
) {
  if (/@(?:plugin|config)\b/iu.test(text)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_EXECUTION_FORBIDDEN");
  }
  const importTokens = [...text.matchAll(/@import\b/giu)];
  const imports = [...text.matchAll(/@import\b([^;]*);/giu)];
  if (imports.length !== importTokens.length) {
    throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
  }
  for (const match of imports) {
    const specifier = importedStylePath(match[1] ?? "");
    if (!specifier) {
      throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
    }
    if (specifier === "tailwindcss" || specifier === "tw-animate-css") continue;
    if (
      !specifier.startsWith("./") ||
      specifier.includes("\\") ||
      specifier.includes("\0") ||
      specifier.includes("?") ||
      specifier.includes("#") ||
      specifier.split("/").some((part) => part === "..") ||
      !specifier.endsWith(".css")
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
    }
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(sourcePath), specifier),
    );
    if (
      resolved.startsWith("../") ||
      path.posix.isAbsolute(resolved) ||
      !files.has(resolved)
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_STYLE_IMPORT_FORBIDDEN");
    }
  }
}

function assertMarkupAndStyleSafe(
  sourcePath: string,
  text: string,
  files: ReadonlyMap<string, Buffer>,
) {
  if (/\b(?:javascript|vbscript):|data:text\/html/iu.test(text)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
  }
  if (/\.(?:html?|svg)$/iu.test(sourcePath)) {
    if (
      /<iframe\b/iu.test(text) ||
      /<(?:image|script|use)\b[^>]*(?:href|src|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(
        text,
      ) ||
      /<(?:audio|img|source|video)\b[^>]*\bsrc\s*=\s*["']?\s*(?:https?:)?\/\//iu.test(
        text,
      )
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
    }
  }
  if (/\.(?:css|less|sass|scss)$/iu.test(sourcePath)) {
    assertStyleImportsSafe(sourcePath, text, files);
    if (/url\s*\(\s*["']?\s*(?:file:|(?:https?:)?\/\/)/iu.test(text)) {
      throw new NativeReactSourceError("NATIVE_SOURCE_NETWORK_FORBIDDEN");
    }
  }
}

const NATIVE_RUNTIME_LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
  "postpublish",
]);

function nativeRuntimeShellFile(pathname: string) {
  return NATIVE_RUNTIME_EXECUTION_SHELL_V1.files.find(
    (file) => file.path === pathname,
  )?.text;
}

function canonicalNativeRuntimeRoutePath(raw: string) {
  const trimmed = raw.trim();
  const withSlash =
    trimmed === "/" ? "/" : `/${trimmed.replace(/^\/+|\/+$/gu, "")}/`;
  const parts = withSlash.split("/").filter(Boolean);
  if (
    raw !== trimmed ||
    raw.length < 1 ||
    raw.length > 191 ||
    withSlash.includes("\\") ||
    withSlash.includes("%") ||
    withSlash.includes("?") ||
    withSlash.includes("#") ||
    withSlash.includes("\0") ||
    withSlash.normalize("NFKC") !== withSlash ||
    parts.some(
      (part) =>
        part === "." ||
        part === ".." ||
        !/^[a-z0-9](?:[a-z0-9_-]{0,62})$/u.test(part),
    )
  ) {
    return null;
  }
  return parts.length === 0 ? "/" : `/${parts.join("/")}/`;
}

function literalNativeRuntimeRouteManifest(text: string) {
  const match = new RegExp(
    `export\\s+const\\s+${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT}\\s*=\\s*(\\[[\\s\\S]*?\\])\\s+as\\s+const\\s*;`,
    "u",
  ).exec(text);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]!) as unknown;
    if (
      !Array.isArray(parsed) ||
      parsed.length < 1 ||
      parsed.length > 30 ||
      parsed.some(
        (value) =>
          typeof value !== "string" ||
          canonicalNativeRuntimeRoutePath(value) !== value,
      ) ||
      new Set(parsed).size !== parsed.length
    ) {
      return null;
    }
    return parsed as string[];
  } catch {
    return null;
  }
}

/**
 * Returns every runtime-contract violation in deterministic order. This audit
 * is intentionally non-short-circuiting so one repair message can address the
 * complete Next/Gatsby/Wasp -> host-Vite conversion instead of burning one
 * provider turn per failure.
 */
export function auditNativeRuntimeContractV1(input: {
  files: ReadonlyMap<string, Buffer>;
  contract?: unknown;
  /** Raw SiteBrief slugs or canonical paths, in SiteBrief order. */
  expectedRoutePaths?: readonly string[];
  /** Workflow 2.9 multi-page sources must resolve their initial and popstate
   * route through the host preview bridge instead of reading the private
   * preview prefix as a public site pathname. */
  requireCanonicalSitePathname?: boolean;
}): NativeRuntimeAudit {
  const issues: NativeRuntimeAuditIssue[] = [];
  const seen = new Set<string>();
  const add = (
    code: NativeRuntimeAuditIssueCode,
    path: string,
    detail: string,
  ) => {
    const key = `${code}\0${path}\0${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    issues.push(Object.freeze({ code, path, detail }));
  };
  const parsedContract = nativeRuntimeContractV1Schema.safeParse(
    input.contract ?? NATIVE_RUNTIME_CONTRACT_V1,
  );
  if (!parsedContract.success) {
    add(
      "CONTRACT_INVALID",
      NATIVE_RUNTIME_CONTRACT_FILENAME,
      "schema or host dependency allowlist mismatch",
    );
  }
  const contract = parsedContract.success
    ? parsedContract.data
    : NATIVE_RUNTIME_CONTRACT_V1;
  const textFile = (pathname: string) => {
    const bytes = input.files.get(pathname);
    if (!bytes) return null;
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      add("PACKAGE_JSON_INVALID", pathname, "invalid UTF-8");
      return null;
    }
  };

  for (const pathname of [
    "package.json",
    contract.entrypoints.html,
    contract.entrypoints.app,
    contract.entrypoints.routes,
  ]) {
    if (!input.files.has(pathname)) {
      add("REQUIRED_FILE_MISSING", pathname, "required by runtime contract");
    }
  }

  let manifest: Record<string, unknown> | null = null;
  const packageText = textFile("package.json");
  if (packageText !== null) {
    try {
      const candidate = JSON.parse(packageText) as unknown;
      if (
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate)
      ) {
        add("PACKAGE_JSON_INVALID", "package.json", "object required");
      } else {
        manifest = candidate as Record<string, unknown>;
      }
    } catch {
      add("PACKAGE_JSON_INVALID", "package.json", "invalid JSON");
    }
  }
  if (manifest) {
    const scripts =
      manifest.scripts &&
      typeof manifest.scripts === "object" &&
      !Array.isArray(manifest.scripts)
        ? (manifest.scripts as Record<string, unknown>)
        : {};
    if (scripts.build !== contract.vite.buildCommand) {
      add(
        "BUILD_COMMAND_INVALID",
        "package.json",
        `expected ${contract.vite.buildCommand}`,
      );
    }
    for (const lifecycle of NATIVE_RUNTIME_LIFECYCLE_SCRIPTS) {
      if (Object.prototype.hasOwnProperty.call(scripts, lifecycle)) {
        add("LIFECYCLE_SCRIPT_FORBIDDEN", "package.json", lifecycle);
      }
    }
    const declared = new Map<string, unknown>();
    for (const section of [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const) {
      const value = manifest[section];
      if (value === undefined) continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        add("DEPENDENCY_FORBIDDEN", "package.json", `${section} shape`);
        continue;
      }
      for (const [dependency, version] of Object.entries(value)) {
        declared.set(dependency, version);
        if (
          contract.security.forbiddenFrameworkDependencies.includes(
            dependency as never,
          )
        ) {
          add("FRAMEWORK_FORBIDDEN", "package.json", dependency);
        }
        const expected = contract.dependencies.allowedExactVersions[dependency];
        if (!expected) {
          add("DEPENDENCY_FORBIDDEN", "package.json", dependency);
        } else if (version !== expected) {
          add(
            "DEPENDENCY_VERSION_MISMATCH",
            "package.json",
            `${dependency}: expected ${expected}`,
          );
        }
      }
    }
    for (const dependency of contract.dependencies.required) {
      if (!declared.has(dependency)) {
        add("DEPENDENCY_REQUIRED", "package.json", dependency);
      }
    }
  }

  const html = textFile(contract.entrypoints.html);
  if (html !== null) {
    if (
      !new RegExp(
        `<[^>]+id=["']${contract.entrypoints.rootElementId}["']`,
        "iu",
      ).test(html)
    ) {
      add(
        "ROOT_ELEMENT_MISSING",
        contract.entrypoints.html,
        `#${contract.entrypoints.rootElementId}`,
      );
    }
    const moduleTags = html.match(/<script\b[^>]*>/giu) ?? [];
    if (
      !moduleTags.some(
        (tag) =>
          /\btype\s*=\s*["']module["']/iu.test(tag) &&
          new RegExp(
            `\\bsrc\\s*=\\s*["']/?${contract.entrypoints.app.replace(
              /[.*+?^${}()|[\]\\]/gu,
              "\\$&",
            )}["']`,
            "iu",
          ).test(tag),
      )
    ) {
      add(
        "APP_ENTRYPOINT_MISMATCH",
        contract.entrypoints.html,
        contract.entrypoints.app,
      );
    }
    if (html !== nativeRuntimeShellFile(contract.entrypoints.html)) {
      add(
        "HTML_SHELL_INVALID",
        contract.entrypoints.html,
        "service-owned styleless shell must be preserved byte-for-byte",
      );
    }
  }
  const app = textFile(contract.entrypoints.app);
  if (
    app !== null &&
    app !== nativeRuntimeShellFile(contract.entrypoints.app)
  ) {
    add(
      "APP_SHELL_INVALID",
      contract.entrypoints.app,
      "service-owned entry shell must be preserved byte-for-byte",
    );
  }
  const routes = textFile(contract.entrypoints.routes);
  if (routes !== null) {
    if (
      !/\bimport\s+(?:[\s\S]*?\s+from\s+)?["'][^"']+["']/u.test(routes) ||
      /\b(?:import\s*\(|lazy\s*\()/u.test(routes)
    ) {
      add(
        "EAGER_ROUTES_REQUIRED",
        contract.entrypoints.routes,
        "route components must use static imports",
      );
    }
    const routeManifest = literalNativeRuntimeRouteManifest(routes);
    if (!routeManifest) {
      add(
        "ROUTE_MANIFEST_INVALID",
        contract.entrypoints.routes,
        `${NATIVE_RUNTIME_ROUTE_MANIFEST_EXPORT} must be a literal, canonical, unique non-empty array`,
      );
    } else if (input.expectedRoutePaths) {
      const expected = input.expectedRoutePaths.map(
        canonicalNativeRuntimeRoutePath,
      );
      if (
        expected.some((value) => value === null) ||
        new Set(expected).size !== expected.length ||
        expected.length !== routeManifest.length ||
        expected.some((value, index) => value !== routeManifest[index])
      ) {
        add(
          "ROUTE_MANIFEST_MISMATCH",
          contract.entrypoints.routes,
          "literal paths must exactly match SiteBrief order and slugs",
        );
      }
    }
    if (
      input.requireCanonicalSitePathname &&
      routeManifest?.some((route) => route !== "/") &&
      !/\bcanonicalSitePathname\s*(?:\?\.)?\s*\(/u.test(routes)
    ) {
      add(
        "CANONICAL_PATHNAME_REQUIRED",
        contract.entrypoints.routes,
        "workflow 2.9 multi-page routing must call the host canonicalSitePathname bridge",
      );
    }
  }

  for (const [pathname, bytes] of input.files) {
    if (
      /(?:^|\/)(?:(?:vite|next|gatsby|wasp)(?:\.[^/]*)?\.config\.[cm]?[jt]s|gatsby-(?:browser|node|ssr)\.[cm]?[jt]sx?|waspfile\.[cm]?[jt]sx?)$/iu.test(
        pathname,
      )
    ) {
      add(
        "HOST_CONFIG_FORBIDDEN",
        pathname,
        "FrontMind owns Vite configuration",
      );
    }
    if (
      !/\.(?:css|html|js|jsx|less|mjs|sass|scss|svg|ts|tsx)$/iu.test(pathname)
    ) {
      continue;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      continue;
    }
    const inspected = withoutSourceComments(text);
    if (
      /(?:from\s*|require\s*\(\s*)["'](?:next(?:\/[^"']*)?|gatsby(?:\/[^"']*)?|wasp(?:\/[^"']*)?|@wasp\/core(?:\/[^"']*)?)["']/u.test(
        inspected,
      )
    ) {
      add(
        "FRAMEWORK_FORBIDDEN",
        pathname,
        "Next/Gatsby/Wasp imports require static Vite adaptation",
      );
    }
    if (/\bimport\s*\(/u.test(inspected)) {
      add("DYNAMIC_IMPORT_FORBIDDEN", pathname, "dynamic import");
    }
    if (
      /\beval\s*\(/u.test(inspected) ||
      /\bnew\s+Function\s*\(/u.test(inspected) ||
      /\b(?:setTimeout|setInterval)\s*\(\s*["'`]/u.test(inspected)
    ) {
      add("DYNAMIC_EXECUTION_FORBIDDEN", pathname, "dynamic execution");
    }
    const absoluteUrls = inspected.match(/https?:\/\/[^\s"'`<>{}\\]+/giu) ?? [];
    if (
      absoluteUrls.some((url) => !SAFE_SOURCE_ABSOLUTE_URLS.has(url)) ||
      /["'`]\/\/[A-Za-z0-9\[]/u.test(inspected) ||
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(/u.test(
        inspected,
      ) ||
      /\bnavigator\s*\.\s*sendBeacon\s*\(/u.test(inspected) ||
      /\baxios\s*\./u.test(inspected)
    ) {
      add("REMOTE_RESOURCE_FORBIDDEN", pathname, "remote resource or request");
    }
  }

  issues.sort((left, right) => {
    const leftKey = `${left.code}\0${left.path}\0${left.detail}`;
    const rightKey = `${right.code}\0${right.path}\0${right.detail}`;
    return leftKey.localeCompare(rightKey);
  });
  return Object.freeze({
    ok: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function findEntrypoint(files: ReadonlyMap<string, Buffer>) {
  const indexBytes = files.get("index.html");
  if (!indexBytes) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ENTRYPOINT_INVALID");
  }
  const html = decodeUtf8(indexBytes);
  const moduleSource =
    /<script\b(?=[^>]*\btype\s*=\s*["']module["'])[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/iu.exec(
      html,
    )?.[1] ?? null;
  const candidates = moduleSource
    ? [moduleSource]
    : ["/src/main.tsx", "/src/main.jsx", "/src/main.ts", "/src/main.js"];
  for (const candidate of candidates) {
    if (/^[a-z][a-z0-9+.-]*:/iu.test(candidate) || candidate.includes("\\")) {
      continue;
    }
    const path = candidate
      .split(/[?#]/u, 1)[0]!
      .replace(/^\.\//u, "")
      .replace(/^\//u, "");
    if (
      path.length > 0 &&
      !path.split("/").some((part) => part === "." || part === "..") &&
      files.has(path)
    ) {
      return path;
    }
  }
  throw new NativeReactSourceError("NATIVE_SOURCE_ENTRYPOINT_INVALID");
}

export async function validateNativeReactSourceArchive(input: {
  archive: Buffer;
  receipt: unknown;
  expectedOperationToken: string;
  expectedBaseSourceSha256: string;
  /** Omit for replay-compatible v1|v2 discrimination; new calls force 2. */
  requiredReceiptVersion?: 1 | 2;
  /** The admitted/normalized template hash bound before provider execution. */
  expectedExecutionBaselineSha256?: string;
  /** Freeze a dynamic-IA source archive to the exact accepted content plan. */
  expectedContentPlanSha256?: string;
  /** Injectable only for deterministic tests; production uses the frozen V1. */
  runtimeContract?: unknown;
  limits?: Partial<NativeSourceLimits>;
  allowedDependencies?: readonly string[];
}): Promise<ValidatedNativeReactSource> {
  const limits = effectiveLimits(input.limits);
  if (
    input.archive.length < 1 ||
    input.archive.length > limits.maxArchiveBytes
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
  }
  const receiptSchema =
    input.requiredReceiptVersion === 1
      ? siteSourceReceiptV1Schema
      : input.requiredReceiptVersion === 2
        ? siteSourceReceiptV2Schema
        : siteSourceReceiptSchema;
  const parsedReceipt = receiptSchema.safeParse(input.receipt);
  if (!parsedReceipt.success) {
    throw new NativeReactSourceError("NATIVE_SOURCE_RECEIPT_INVALID");
  }
  const receipt: SiteSourceReceipt = parsedReceipt.data;
  const v2Receipt =
    receipt.preflightVersion === NATIVE_SOURCE_PREFLIGHT_V2_VERSION
      ? (receipt as SiteSourceReceiptV2)
      : null;
  let runtimeContract: NativeRuntimeContractV1 | null = null;
  if (v2Receipt) {
    const parsedRuntimeContract = nativeRuntimeContractV1Schema.safeParse(
      input.runtimeContract ?? NATIVE_RUNTIME_CONTRACT_V1,
    );
    if (!parsedRuntimeContract.success) {
      throw new NativeReactSourceError("NATIVE_SOURCE_RECEIPT_INVALID");
    }
    runtimeContract = parsedRuntimeContract.data;
    const runtimeContractSha256 = sha256(canonicalJsonBytes(runtimeContract));
    if (
      !secureStringEqual(
        v2Receipt.runtimeContractSha256,
        runtimeContractSha256,
      ) ||
      !secureStringEqual(
        v2Receipt.executionShellSha256,
        NATIVE_RUNTIME_EXECUTION_SHELL_V1_SHA256,
      ) ||
      !input.expectedExecutionBaselineSha256 ||
      !SHA256_PATTERN.test(input.expectedExecutionBaselineSha256) ||
      !secureStringEqual(
        v2Receipt.executionBaselineSha256,
        input.expectedExecutionBaselineSha256,
      )
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_RECEIPT_INVALID");
    }
  }
  if (
    input.expectedContentPlanSha256 !== undefined &&
    (!v2Receipt ||
      !SHA256_PATTERN.test(input.expectedContentPlanSha256) ||
      !v2Receipt.contentPlanSha256 ||
      !secureStringEqual(
        v2Receipt.contentPlanSha256,
        input.expectedContentPlanSha256,
      ))
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_RECEIPT_INVALID");
  }
  if (
    !secureStringEqual(receipt.operationToken, input.expectedOperationToken)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_TOKEN_MISMATCH");
  }
  if (
    !SHA256_PATTERN.test(input.expectedBaseSourceSha256) ||
    !secureStringEqual(receipt.baseSourceSha256, input.expectedBaseSourceSha256)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_BASE_HASH_MISMATCH");
  }
  const archiveSha256 = sha256(input.archive);
  if (!secureStringEqual(receipt.archiveSha256, archiveSha256)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ARCHIVE_HASH_MISMATCH");
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(input.archive, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch {
    throw new NativeReactSourceError("NATIVE_SOURCE_ZIP_INVALID");
  }
  const entries = Object.values(archive.files) as UnsafeZipObject[];
  const filesOnly = entries.filter((entry) => !entry.dir);
  if (filesOnly.length < 1 || filesOnly.length > limits.maxFiles) {
    throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
  }
  // V1 receipts have always counted regular files only. V2 keeps that as the
  // canonical form, while accepting the other common ZIP-tool convention:
  // counting explicit directory records in the central directory. The exact
  // archive hash still binds every record and all real safety limits continue
  // to use the authoritative non-directory file set below.
  const receiptFileCountMatches =
    receipt.fileCount === filesOnly.length ||
    (v2Receipt !== null && receipt.fileCount === entries.length);
  if (!receiptFileCountMatches) {
    throw new NativeReactSourceError("NATIVE_SOURCE_RECEIPT_INVALID");
  }
  const rawFilePaths: string[] = [];
  const entryByRawPath = new Map<string, UnsafeZipObject>();
  const collisionKeys = new Set<string>();
  for (const entry of entries) {
    const safePath = assertSafeArchivePath(entry, limits);
    const collisionKey = safePath.toLocaleLowerCase("en-US");
    if (collisionKeys.has(collisionKey)) {
      throw new NativeReactSourceError("NATIVE_SOURCE_PATH_COLLISION");
    }
    collisionKeys.add(collisionKey);
    if (entry.dir) continue;
    const declaredSize = Number(entry._data?.uncompressedSize ?? 0);
    if (
      Number.isFinite(declaredSize) &&
      declaredSize > limits.maxSingleFileBytes
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
    }
    rawFilePaths.push(safePath);
    entryByRawPath.set(safePath, entry);
  }
  const wrapper = commonArchiveRoot(rawFilePaths);
  const files = new Map<string, Buffer>();
  let expandedBytes = 0;
  for (const rawPath of rawFilePaths.sort()) {
    const normalizedPath = wrapper
      ? rawPath.slice(wrapper.length + 1)
      : rawPath;
    if (
      !normalizedPath ||
      files.has(normalizedPath.toLocaleLowerCase("en-US"))
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_PATH_COLLISION");
    }
    if (nativeSourcePathKind(normalizedPath) === null) {
      throw new NativeReactSourceError("NATIVE_SOURCE_FILE_TYPE_FORBIDDEN");
    }
    const bytes = await entryByRawPath.get(rawPath)!.async("nodebuffer");
    expandedBytes += bytes.length;
    if (
      bytes.length > limits.maxSingleFileBytes ||
      expandedBytes > limits.maxExpandedBytes
    ) {
      throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
    }
    files.set(normalizedPath, bytes);
  }
  const allowedDependencies = new Set(
    input.allowedDependencies ?? NATIVE_SOURCE_ALLOWED_DEPENDENCIES,
  );
  if (v2Receipt && runtimeContract) {
    const audit = auditNativeRuntimeContractV1({
      files,
      contract: runtimeContract,
    });
    if (!audit.ok) {
      throw new NativeRuntimeContractAuditError(audit);
    }
  }
  const packageJson = assertPackageSafe(files, allowedDependencies);
  for (const [path, bytes] of files) {
    assertNoOperationTokenBytes(bytes, input.expectedOperationToken);
    const kind = nativeSourcePathKind(path);
    if (kind !== "text" && kind !== "lock") continue;
    const text = decodeUtf8(bytes);
    assertNoSecrets(text, input.expectedOperationToken);
    if (kind !== "lock") {
      assertMarkupAndStyleSafe(path, text, files);
      assertNoExternalUrlLiterals(text);
    }
    if (SOURCE_CODE_PATTERN.test(path)) {
      assertSourceCodeSafe(path, text);
    }
  }
  const entrypoint = findEntrypoint(files);
  return {
    receipt,
    archiveSha256,
    sourceSha256: archiveSha256,
    sourceZip: Buffer.from(input.archive),
    fileCount: files.size,
    htmlEntrypoint: "index.html",
    entrypoint,
    packageJson,
    files,
  };
}

type FetchPinned = typeof fetchPinnedPublicHttps;

function boundedDataUrl(url: string, maxBytes: number) {
  const prefix = `data:${FRONTMIND_SITE_SOURCE_ARCHIVE_MIME};base64,`;
  if (!url.startsWith(prefix)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const encoded = url.slice(prefix.length);
  if (
    encoded.length < 4 ||
    encoded.length > Math.ceil((maxBytes * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const body = Buffer.from(encoded, "base64");
  if (
    body.length < 1 ||
    body.length > maxBytes ||
    body.toString("base64").replace(/=+$/u, "") !== encoded.replace(/=+$/u, "")
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  return body;
}

async function readBoundedResponseBody(response: Response, maxBytes: number) {
  if (!response.ok || !response.body) {
    const retryable =
      response.status === 408 ||
      response.status === 425 ||
      response.status === 429 ||
      response.status >= 500;
    throw new NativeReactSourceError(
      "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE",
      retryable,
      response.status,
    );
  }
  const contentType = response.headers.get("content-type");
  const responseMediaType = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    ![
      FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
      "application/x-zip-compressed",
      "application/octet-stream",
    ].includes(responseMediaType ?? "")
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const declaredHeader = response.headers.get("content-length");
  const declared =
    declaredHeader === null ? Number.NaN : Number(declaredHeader);
  if (Number.isFinite(declared) && (declared < 1 || declared > maxBytes)) {
    throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
  }
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let byteCount = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      byteCount += next.value.byteLength;
      if (byteCount > maxBytes) {
        throw new NativeReactSourceError("NATIVE_SOURCE_LIMIT_EXCEEDED");
      }
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  if (byteCount < 1) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  return Buffer.concat(chunks, byteCount);
}

export async function readNativeSourceAttachment(input: {
  attachment: {
    filename: string;
    contentType: string;
    url: string;
  };
  signal?: AbortSignal;
  fetchPinned?: FetchPinned;
  maxBytes?: number;
}) {
  const mediaType = input.attachment.contentType
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (
    input.attachment.filename !== FRONTMIND_SITE_SOURCE_ARCHIVE_FILENAME ||
    ![
      FRONTMIND_SITE_SOURCE_ARCHIVE_MIME,
      "application/x-zip-compressed",
      "application/octet-stream",
    ].includes(mediaType ?? "")
  ) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const requestedMaxBytes = input.maxBytes;
  const maxBytes =
    requestedMaxBytes === undefined
      ? NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes
      : Number.isSafeInteger(requestedMaxBytes) && requestedMaxBytes > 0
        ? Math.min(
            requestedMaxBytes,
            NATIVE_SOURCE_DEFAULT_LIMITS.maxArchiveBytes,
          )
        : 0;
  if (maxBytes < 1) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  if (input.attachment.url.startsWith("data:")) {
    return boundedDataUrl(input.attachment.url, maxBytes);
  }
  let parsed: URL;
  try {
    parsed = new URL(input.attachment.url);
  } catch {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
    throw new NativeReactSourceError("NATIVE_SOURCE_ATTACHMENT_INVALID");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const onAbort = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  input.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const fetched = await (input.fetchPinned ?? fetchPinnedPublicHttps)({
      url: parsed,
      signal: controller.signal,
      maxRedirects: 2,
      allowedOrigin: parsed.origin,
      headers: { Accept: FRONTMIND_SITE_SOURCE_ARCHIVE_MIME },
    });
    return await readBoundedResponseBody(fetched.response, maxBytes);
  } catch (error) {
    if (error instanceof NativeReactSourceError) throw error;
    throw new NativeReactSourceError(
      "NATIVE_SOURCE_ATTACHMENT_UNAVAILABLE",
      true,
    );
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener("abort", onAbort);
  }
}

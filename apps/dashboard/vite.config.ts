import { jsxLocPlugin } from "@builder.io/vite-plugin-jsx-loc";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

// =============================================================================
// FrontMind Debug Collector - Vite Plugin
// Writes browser logs directly to files, trimmed when exceeding size limit
// =============================================================================

const PROJECT_ROOT = import.meta.dirname;
const LOG_DIR = path.join(PROJECT_ROOT, ".frontmind-logs");
const MAX_LOG_SIZE_BYTES = 1 * 1024 * 1024; // 1MB per log file
const TRIM_TARGET_BYTES = Math.floor(MAX_LOG_SIZE_BYTES * 0.6); // Trim to 60% to avoid constant re-trimming

type LogSource = "browserConsole" | "networkRequests" | "sessionReplay";

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function trimLogFile(logPath: string, maxSize: number) {
  try {
    if (!fs.existsSync(logPath) || fs.statSync(logPath).size <= maxSize) {
      return;
    }

    const lines = fs.readFileSync(logPath, "utf-8").split("\n");
    const keptLines: string[] = [];
    let keptBytes = 0;

    // Keep newest lines (from end) that fit within 60% of maxSize
    const targetSize = TRIM_TARGET_BYTES;
    for (let i = lines.length - 1; i >= 0; i--) {
      const lineBytes = Buffer.byteLength(`${lines[i]}\n`, "utf-8");
      if (keptBytes + lineBytes > targetSize) break;
      keptLines.unshift(lines[i]);
      keptBytes += lineBytes;
    }

    fs.writeFileSync(logPath, keptLines.join("\n"), "utf-8");
  } catch {
    /* ignore trim errors */
  }
}

function writeToLogFile(source: LogSource, entries: unknown[]) {
  if (entries.length === 0) return;

  ensureLogDir();
  const logPath = path.join(LOG_DIR, `${source}.log`);

  // Format entries with timestamps
  const lines = entries.map((entry) => {
    const ts = new Date().toISOString();
    return `[${ts}] ${JSON.stringify(entry)}`;
  });

  // Append to log file
  fs.appendFileSync(logPath, `${lines.join("\n")}\n`, "utf-8");

  // Trim if exceeds max size
  trimLogFile(logPath, MAX_LOG_SIZE_BYTES);
}

/**
 * Vite plugin to collect browser debug logs
 * - POST /__frontmind__/logs: Browser sends logs, written directly to files
 * - Files: browserConsole.log, networkRequests.log, sessionReplay.log
 * - Auto-trimmed when exceeding 1MB (keeps newest entries)
 */
function vitePluginFrontMindDebugCollector(): Plugin {
  return {
    name: "frontmind-debug-collector",

    transformIndexHtml(html) {
      if (process.env.NODE_ENV === "production") {
        return html;
      }
      return {
        html,
        tags: [
          {
            tag: "script",
            attrs: {
              src: "/__frontmind__/debug-collector.js",
              defer: true,
            },
            injectTo: "head",
          },
        ],
      };
    },

    configureServer(server: ViteDevServer) {
      // POST /__frontmind__/logs: Browser sends logs (written directly to files)
      server.middlewares.use("/__frontmind__/logs", (req, res, next) => {
        if (req.method !== "POST") {
          return next();
        }

        const handlePayload = (payload: any) => {
          // Write logs directly to files
          if (payload.consoleLogs?.length > 0) {
            writeToLogFile("browserConsole", payload.consoleLogs);
          }
          if (payload.networkRequests?.length > 0) {
            writeToLogFile("networkRequests", payload.networkRequests);
          }
          if (payload.sessionEvents?.length > 0) {
            writeToLogFile("sessionReplay", payload.sessionEvents);
          }

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        };

        const reqBody = (req as { body?: unknown }).body;
        if (reqBody && typeof reqBody === "object") {
          try {
            handlePayload(reqBody);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", () => {
          try {
            const payload = JSON.parse(body);
            handlePayload(payload);
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: false, error: String(e) }));
          }
        });
      });
    },
  };
}

function vitePluginFrontMindBuildVersion(
  buildVersion: string,
  gitSha: string,
  builtAt: string,
): Plugin {
  return {
    name: "frontmind-build-version",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "__frontmind__/version.json",
        source: `${JSON.stringify({
          version: buildVersion,
          gitSha,
          builtAt,
          copyRevision: "knowledge-collection-copy-v2",
        })}\n`,
      });
    },
  };
}

function vitePluginProductionPublicAssets(): Plugin {
  const allowedAssets = [
    {
      source: "frontmind-contract-logo-white.svg",
      output: "frontmind-contract-logo-white.svg",
    },
    {
      source: "frontmind-sales-wechat.png",
      output: "frontmind-sales-wechat.png",
    },
    {
      source: "assets/frontmind-login-background.webp",
      output: "assets/frontmind-login-background.webp",
    },
    {
      source: "assets/frontmind-wordmark.svg",
      output: "assets/frontmind-wordmark.svg",
    },
    {
      source: "assets/cuhksz-emblem.png",
      output: "assets/cuhksz-emblem.png",
    },
    ...[
      "01-domain-search.webp",
      "02-filing-entry.webp",
      "03-enterprise-sponsor.webp",
      "04-owner-contact-empty.webp",
      "05-owner-contact-filled.webp",
      "06-mobile-enterprise-main.webp",
      "07-mobile-owner-upload.webp",
      "08-sms-review-stage.webp",
      "09-sms-message.webp",
      "10-sms-verification.webp",
      "11-sms-resend.webp",
      "12-icp-filing-process.webp",
      "13-existing-sponsor-prefilled.webp",
      "14-existing-sponsor-mobile.webp",
    ].map((filename) => ({
      source: `assets/aliyun-icp-guide/${filename}`,
      output: `assets/aliyun-icp-guide/${filename}`,
    })),
  ];
  const publicDirectory = path.resolve(import.meta.dirname, "client/public");
  return {
    name: "frontmind-production-public-assets",
    generateBundle() {
      for (const asset of allowedAssets) {
        const assetPath = path.join(publicDirectory, asset.source);
        if (!fs.existsSync(assetPath)) {
          this.error(
            `Required production public asset is missing: ${asset.source}`,
          );
        }
        this.emitFile({
          type: "asset",
          fileName: asset.output,
          source: fs.readFileSync(assetPath),
        });
      }
    },
  };
}

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";
  const repositorySha = (() => {
    try {
      return execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: PROJECT_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  })();
  const gitSha =
    process.env.FRONTMIND_BUILD_SHA?.trim() ||
    process.env.COMMIT_SHA?.trim() ||
    process.env.RENDER_GIT_COMMIT?.trim() ||
    repositorySha ||
    "local";
  const builtAt = new Date().toISOString();
  const buildVersion =
    process.env.FRONTMIND_BUILD_VERSION?.trim() ||
    (gitSha !== "local" ? gitSha : `${Date.now()}`);
  const plugins = [
    react(),
    tailwindcss(),
    vitePluginFrontMindBuildVersion(buildVersion, gitSha, builtAt),
    isProduction && vitePluginProductionPublicAssets(),
    !isProduction && jsxLocPlugin(),
    !isProduction && vitePluginFrontMindDebugCollector(),
  ].filter(Boolean) as Plugin[];

  return {
    plugins,
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "client", "src"),
        "@shared": path.resolve(import.meta.dirname, "shared"),
        "@assets": path.resolve(import.meta.dirname, "attached_assets"),
      },
    },
    define: {
      __FRONTMIND_BUILD_VERSION__: JSON.stringify(buildVersion),
    },
    envDir: path.resolve(import.meta.dirname),
    root: path.resolve(import.meta.dirname, "client"),
    publicDir: isProduction
      ? false
      : path.resolve(import.meta.dirname, "client", "public"),
    build: {
      outDir: path.resolve(import.meta.dirname, "dist/public"),
      emptyOutDir: true,
    },
    server: {
      host: true,
      allowedHosts: ["localhost", "127.0.0.1"],
      fs: {
        strict: true,
        deny: ["**/.*"],
      },
    },
  };
});

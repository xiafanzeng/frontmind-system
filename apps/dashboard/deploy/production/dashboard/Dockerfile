# syntax=docker/dockerfile:1.7

ARG BUILDER_IMAGE=1panel/node:22.22.2@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28
ARG FRONTMIND_PDF_RUNTIME_IMAGE

FROM ${BUILDER_IMAGE} AS build

ARG SOURCE_SHA
ENV COREPACK_HOME=/usr/local/share/corepack \
    CI=1 \
    NODE_ENV=development \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FRONTMIND_ARCHIVE_BUILD=1 \
    FRONTMIND_BUILD_SHA=${SOURCE_SHA} \
    BUILD_SHA=${SOURCE_SHA}

WORKDIR /app

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.4.1 --activate \
    && test "$(pnpm --version)" = "10.4.1"

COPY . .

RUN test "${#SOURCE_SHA}" -eq 40 \
    && ! printf '%s' "${SOURCE_SHA}" | grep -q '[^0-9a-f]' \
    && pnpm install --frozen-lockfile \
    && pnpm exec playwright install chromium \
    && NODE_ENV=production pnpm build \
    && test -f dist/index.js \
    && if test -e server/knowledge-base-incident-repair-cli.ts; then \
         test -f server/knowledge-base-incident-repair-cli.ts \
           && test -s dist/knowledge-base-incident-repair-cli.js; \
       else \
         test ! -e dist/knowledge-base-incident-repair-cli.js; \
       fi \
    && test -s dist/reconcile-siteops-build.js \
    && test -s dist/seed-static-template-catalog.js \
    && test -f dist/release-db.js \
    && test -f dist/migration-manifest.json \
    && test -f dist/drizzle/meta/_journal.json \
    && pnpm prune --prod

FROM ${FRONTMIND_PDF_RUNTIME_IMAGE} AS runtime

ARG SOURCE_SHA
ARG IMAGE_VERSION

ENV NODE_ENV=production \
    PORT=3001 \
    HOME=/home/frontmind \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    FRONTMIND_BUILD_SHA=${SOURCE_SHA} \
    FRONTMIND_MIGRATIONS_DIR=/app/dist/drizzle \
    FRONTMIND_MIGRATION_MANIFEST_PATH=/app/dist/migration-manifest.json

LABEL org.opencontainers.image.source="https://github.com/xiafanzeng/frontmind-dashboard" \
      org.opencontainers.image.revision="${SOURCE_SHA}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      net.frontmind.runtime.roles="web,siteops-worker"

WORKDIR /app

RUN set -eux; \
    command -v pdfinfo; \
    command -v pdftotext; \
    command -v pdfseparate; \
    command -v pdfunite; \
    command -v gs; \
    groupadd --gid 10001 frontmind; \
    useradd --uid 10001 --gid 10001 --create-home --home-dir /home/frontmind --shell /usr/sbin/nologin frontmind; \
    install -d -o 10001 -g 10001 -m 0700 \
      /var/lib/frontmind/prepared-files \
      /var/lib/frontmind/dashboard-assets

COPY --from=build --chown=10001:10001 /app/package.json /app/pnpm-lock.yaml ./
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /ms-playwright /ms-playwright
COPY --from=build --chown=10001:10001 /app/dist ./dist
COPY --from=build --chown=10001:10001 /app/drizzle ./drizzle
COPY --from=build --chown=10001:10001 /app/scripts/validate-production-runtime.mjs ./scripts/validate-production-runtime.mjs
COPY --from=build --chown=10001:10001 /app/scripts/production-runtime-validator.mjs ./scripts/production-runtime-validator.mjs
COPY --chown=0:0 deploy/production/dashboard/entrypoint.sh /usr/local/bin/frontmind-dashboard-entrypoint

RUN node /app/node_modules/playwright/cli.js install-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod 0755 /usr/local/bin/frontmind-dashboard-entrypoint \
    && node -e 'const fs=require("node:fs");const p="/app/dist/knowledge-base-incident-repair-cli.js";const m=JSON.parse(fs.readFileSync("/app/dist/artifact-manifest.json","utf8"));const expected=m.files.some((f)=>f.path==="knowledge-base-incident-repair-cli.js");const present=fs.existsSync(p);if(expected!==present||(present&&(!fs.statSync(p).isFile()||fs.statSync(p).size===0)))process.exit(1)' \
    && test -s /app/dist/reconcile-siteops-build.js \
    && test -s /app/dist/seed-static-template-catalog.js \
    && test -f /app/dist/release-db.js \
    && test -f /app/dist/migration-manifest.json \
    && test -f /app/dist/drizzle/meta/_journal.json

USER 10001:10001

EXPOSE 3001

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/local/bin/frontmind-dashboard-entrypoint"]
CMD ["node", "dist/index.js"]

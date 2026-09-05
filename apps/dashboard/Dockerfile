# syntax=docker/dockerfile:1.7
FROM 1panel/node:22.22.2@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28 AS build
ARG SOURCE_SHA
ENV COREPACK_HOME=/usr/local/share/corepack CI=1 NODE_ENV=development \
    FRONTMIND_ARCHIVE_BUILD=1 FRONTMIND_BUILD_SHA=${SOURCE_SHA} BUILD_SHA=${SOURCE_SHA}
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
COPY . .
RUN test "${#SOURCE_SHA}" -eq 40 && pnpm install --frozen-lockfile \
    && pnpm --filter frontmind-client build

FROM 1panel/node:22.22.2@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28
ARG SOURCE_SHA
ENV NODE_ENV=production PORT=3001 FRONTMIND_BUILD_SHA=${SOURCE_SHA} \
    FRONTMIND_MIGRATIONS_DIR=/app/drizzle FRONTMIND_MIGRATION_MANIFEST_PATH=/app/migration-manifest.json
WORKDIR /app
RUN groupadd --gid 10001 frontmind && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/frontmind --shell /usr/sbin/nologin frontmind \
    && install -d -o 10001 -g 10001 -m 0700 /var/lib/frontmind/prepared-files /var/lib/frontmind/dashboard-assets
COPY --from=build --chown=10001:10001 /app/apps/dashboard/package.json /app/apps/dashboard/pnpm-lock.yaml ./
# The workspace installs dependencies in the repository-level .pnpm store;
# copying the root node_modules preserves its symlink graph in the runtime.
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
COPY --from=build --chown=10001:10001 /app/apps/dashboard/dist ./dist
COPY --from=build --chown=10001:10001 /app/apps/dashboard/drizzle ./drizzle
COPY --from=build --chown=10001:10001 /app/apps/dashboard/scripts/validate-production-runtime.mjs ./scripts/validate-production-runtime.mjs
USER 10001:10001
EXPOSE 3001
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=6 CMD ["node", "-e", "fetch('http://127.0.0.1:3001/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/index.js"]

# syntax=docker/dockerfile:1.7
FROM 1panel/node:22.22.2@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28 AS build
WORKDIR /app
ENV COREPACK_HOME=/usr/local/share/corepack CI=1
RUN corepack enable && corepack prepare pnpm@10.4.1 --activate
COPY . .
RUN pnpm install --frozen-lockfile \
    && pnpm --filter @frontmind/monitoring-worker build

FROM 1panel/node:22.22.2@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28
WORKDIR /app
ENV NODE_ENV=production
RUN groupadd --gid 10001 frontmind && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/frontmind --shell /usr/sbin/nologin frontmind
COPY --from=build --chown=10001:10001 /app/apps/monitoring-worker/dist ./apps/monitoring-worker/dist
COPY --from=build --chown=10001:10001 /app/packages ./packages
COPY --from=build --chown=10001:10001 /app/node_modules ./node_modules
USER 10001:10001
CMD ["node", "apps/monitoring-worker/dist/entrypoint.js"]

# FrontMind System deployment

The production boundary is one Dashboard/API container, one monitoring Worker,
one private MySQL container, and a local OpenResty reverse proxy. The Worker has
no public port. MySQL is reachable only on the internal Compose network.

## First IPv4 deployment

On `149.88.85.240`, prepare the data-disk directories:

```sh
install -d -m 0750 /srv/frontmind-system/{mysql,backups,runtime/prepared-files,runtime/dashboard-assets}
install -d -m 0700 /etc/frontmind-system
```

Copy the example values from [`env.example`](./env.example) into separate
`mysql.env`, `dashboard.env`, `worker.env`, and `backup.env` files under
`/etc/frontmind-system`. Keep those files root-only and do not commit them.

Publish immutable Dashboard and Worker image digests, set the two image
variables in a local Compose env file, then run:

```sh
docker compose --env-file /etc/frontmind-system/compose.env \
  -f /srv/frontmind-system/compose/docker-compose.yml up -d mysql
docker compose --env-file /etc/frontmind-system/compose.env \
  --profile migration -f /srv/frontmind-system/compose/docker-compose.yml \
  run --rm release-db-migrate
docker compose --env-file /etc/frontmind-system/compose.env \
  -f /srv/frontmind-system/compose/docker-compose.yml up -d dashboard monitoring-worker backup
curl --fail http://127.0.0.1:3001/healthz
```

Then install [`openresty/frontmind-system-ipv4.conf`](./openresty/frontmind-system-ipv4.conf)
through 1Panel and reload OpenResty. Verify `http://149.88.85.240/healthz`, login,
the `/monitoring` customer routes, and `/admin/monitoring` as a system admin.

Do not run `pnpm db:push` against production. Migrations must be built into the
immutable Dashboard image and executed by the one-shot release command.

## Domain cutover

Create `dashboard.frontmind.cn` in 1Panel, proxy it to port 3001, and request
the certificate through 1Panel. Change `FRONTMIND_PUBLIC_URL` and
`PUBLIC_ORIGIN` to the HTTPS origin, set `COOKIE_SECURE=true`, reload the
Dashboard, and only then enable HSTS. Website remains an independent service at
`www.frontmind.cn`.

## Rollback

Keep the previous image digests and a database backup before every migration.
To roll back an application release, restore the previous digests and restart
Dashboard/Worker. If a migration is incompatible, stop the application, restore
the MySQL backup, and start the previous release. The old server
`149.88.85.148` is outside this deployment and must not be changed.

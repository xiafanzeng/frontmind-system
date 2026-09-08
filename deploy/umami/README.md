# CN Website analytics

Umami 3.3.1 and PostgreSQL 17 run as an isolated Compose project. Pin both images
by digest in `/etc/frontmind-system/umami-compose.env`. Secrets belong in mode-600
`umami.env` (DATABASE_URL, APP_SECRET, TWO_FACTOR_ENCRYPTION_KEY, DISABLE_TELEMETRY=1)
and `umami-postgres.env` (POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD).

Use `docker compose --env-file /etc/frontmind-system/umami-compose.env -f
/srv/frontmind-system/compose/umami/docker-compose.yml up -d`. Only port 3010 on
loopback is exposed. OpenResty publishes exactly the script and event endpoint,
never the management API. Access the management UI through an SSH tunnel:
`ssh -L 3010:127.0.0.1:3010 frontmind-system-qjy`, then open localhost:3010.
The generated admin login is in `/etc/frontmind-system/umami-admin.json` on the
host. Website uses a distinct team-view-only user, not the administrator.

The Website runtime freezes only verified CN visitor records before cutover.
The historical file is independent of Umami events: it is added once by the
Website summary adapter and does not manufacture dated events or countries.

Backups run every six hours and retain 14 days of PostgreSQL custom-format dumps.
The immutable CN historical summary is also copied to the private backup directory;
it must be restored alongside Umami to reconstruct the public total.
For recovery, stop Umami and its backup service, preserve the damaged volume,
restore the selected dump with `pg_restore --clean --if-exists --no-owner` into
an isolated PostgreSQL database, check it, and point Umami to the recovered DB.
Never restore this database over Dashboard MySQL or copy another domain's data.

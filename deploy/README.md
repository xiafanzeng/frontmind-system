# FrontMind System deployment

The production host `149.88.85.240` runs Dashboard/API, siteops-worker,
monitoring-worker, Website, private MySQL, backup, and host OpenResty.
Dashboard is the sole login authority. The old server `149.88.85.148` is
retired and outside this deployment.

Use the checked-in Compose file at
`/srv/frontmind-system/compose/docker-compose.yml` and root-only environment
files in `/etc/frontmind-system`. Images are pinned by immutable digest in
`compose.env`. Never commit environment files, credentials, private keys,
database dumps or media.

## Release

Publish one coherent main SHA and obtain its Dashboard and Worker image digests.
Website has an independent image built with its explicit `cn` profile. Update
the server's image references, build SHA and runtime paths, retaining the
previous values for recovery. Validate Compose and the production environment.

If migrations are pending, stop the selected applications and take a verified,
root-only database backup. Inspect the built image's migration plan:

```sh
docker compose --env-file /etc/frontmind-system/compose.env \
  -f /srv/frontmind-system/compose/docker-compose.yml \
  --profile migration run --rm release-db-migrate plan --json
```

Pass the observed `applied.count` and `applied.journalHash` to the one-shot
migration command together with the selected release identifier:

```sh
docker compose --env-file /etc/frontmind-system/compose.env \
  -f /srv/frontmind-system/compose/docker-compose.yml \
  --profile migration run --rm release-db-migrate migrate --json \
  --release-id "$release_id" \
  --expected-applied-count "$applied_count" \
  --expected-applied-journal-hash "$applied_journal_hash"
```

These are values from the plan, not the expected final journal. Do not replay
historical migrations, reset data, or run `db:push` in production.

Start Dashboard and both workers, wait for Dashboard readiness, then start
Website. Check both `/healthz` and `/readyz`, the exact build SHA, login across
refresh/navigation, customer `/monitoring-system` and `/publishing`, and system
administration `/admin/monitoring`.

## Persistent configuration and assets

Reconcile both effective production container variables and 1Panel runtime
definitions. Encrypted service-wide credential versions and quota policies live
in the database and must be moved with their encryption configuration. Do not
overwrite target accounts, passwords, sessions or customer histories.

Dashboard and siteops-worker share prepared files and Dashboard assets.
The active static template catalog is in
`dashboard-assets/siteops/static-template-catalog`; it is not bundled in Git.
After copying the original active catalog to the new asset volume, run
`node dist/seed-static-template-catalog.js` in Dashboard. It verifies existing
asset hashes and recreates the new filesystem's integrity metadata. Then run
the same command with `--check-active` and confirm required admission is ready.

Monitoring API and Worker share their own private persistent asset directory.
Website uses its persistent data directory. Backup runs every six hours with
14-day retention, creates mode-600 files and publishes a backup only after
dumping and compression both succeed.

## HTTPS and rollback

Use [the canonical HTTPS configuration](openresty/HTTPS.md). HTTP and the IP
redirect to canonical HTTPS; production session cookies require HTTPS.
OpenResty and certificate renewal are host-managed, so 1Panel's site list is
not the authoritative runtime inventory.

Keep previous image digests and the pre-migration backup. Roll back compatible
application images directly; restore the database only with applications
stopped when an incompatible migration requires it. Preserve the original
server throughout recovery.

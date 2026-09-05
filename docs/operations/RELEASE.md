# IPv4 release checklist

The repository publishes two immutable GHCR images from `main`:

- `ghcr.io/xiafanzeng/frontmind-system-dashboard`
- `ghcr.io/xiafanzeng/frontmind-system-worker`

After the GitHub Actions run succeeds, copy the image digests into
`/etc/frontmind-system/compose.env`. Keep application secrets in the four
separate root-owned env files; never put them in Compose or GitHub variables.

On the new server, prepare `/srv/frontmind-system` and `/etc/frontmind-system`,
copy `deploy/docker-compose.yml` and `deploy/backup/backup.sh`, then follow the
commands in [`deploy/README.md`](../../deploy/README.md). Run the migration
profile once against the new MySQL volume before starting Dashboard and Worker.

The first acceptance URL is `http://149.88.85.240`. OpenResty proxies only to
`127.0.0.1:3001`; MySQL and Worker have no public ports. The old host
`149.88.85.148` is deliberately excluded.

For the later domain cutover, create `dashboard.frontmind.cn` in 1Panel, proxy
it to port 3001, use 1Panel to request/renew the certificate, then switch the
public origin and secure cookie settings. Website remains at
`www.frontmind.cn`.

# Canonical HTTPS

DNS A records for `www.frontmind.cn` and `dashboard.frontmind.cn` point to `149.88.85.240`. The host runs OpenResty directly. Deploy `nginx-https.conf` as `/usr/local/openresty/nginx/conf/nginx.conf`, validate with `openresty -t`, then reload its systemd service.

Certificates are issued by Let's Encrypt using acme.sh and HTTP-01. Both HTTP virtual hosts serve `/.well-known/acme-challenge/` from `/var/www/acme` before redirecting other paths to HTTPS. For Website:

```sh
/root/.acme.sh/acme.sh --issue --server letsencrypt -d www.frontmind.cn -w /var/www/acme --keylength ec-256
/root/.acme.sh/acme.sh --install-cert -d www.frontmind.cn --ecc \
  --key-file /etc/ssl/frontmind/website.key \
  --fullchain-file /etc/ssl/frontmind/website.fullchain.pem \
  --reloadcmd 'openresty -t && systemctl reload openresty'
```

Dashboard uses the corresponding `dashboard.key` and `dashboard.fullchain.pem`. Both renew through the webroot. The existing acme.sh cron checks renewals four times per day; installed paths and reload commands persist for automatic renewal. Keep port 80 available for challenges and port 443 for service. Never commit certificates' private keys or account material.

Verification: resolve both domains using public and authoritative DNS; inspect issuer, SAN and expiry; request each HTTPS root without bypassing TLS verification; verify HTTP/IP redirects and application readiness.

1Panel's site list does not automatically represent host-managed OpenResty and Compose services. Certificate issuance and renewal do not depend on a manually created 1Panel website entry.

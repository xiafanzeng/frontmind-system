# OpenResty

The IPv4 configuration is intentionally HTTP-only. Install
`frontmind-system-ipv4.conf` as the default 1Panel/OpenResty site and reload
OpenResty after `127.0.0.1:3001` passes its health check.

When `dashboard.frontmind.cn` is ready, create a separate 1Panel site, request
the certificate there, and update `FRONTMIND_PUBLIC_URL`, `PUBLIC_ORIGIN`, and
`COOKIE_SECURE` before enabling HSTS. Do not enable HSTS for the IPv4 stage.

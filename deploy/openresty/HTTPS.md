# Canonical HTTPS

## 证书为什么正规，以及和阿里云的关系

当前 `www.frontmind.cn` 使用 Let's Encrypt 签发的公开受信任证书。
Let's Encrypt 是证书签发机构（CA）；ACME 是自动申请、验证和续期的协议；
acme.sh 是这台服务器上执行这些操作的客户端。免费不影响证书的 HTTPS
加密能力和浏览器信任。

阿里云管理域名解析，与使用哪家 CA 签发证书是两件事。域名继续在阿里云
解析，可以使用 Let's Encrypt 证书。之前若从阿里云下载证书后上传，属于
另一种部署流程；现有记录不足以确定当时具体的签发机构和客户端。

当前流程是：

1. 阿里云 DNS 将域名指向 `149.88.85.240`。
2. acme.sh 在服务器的 HTTP 验证目录放置临时验证内容。
3. Let's Encrypt 通过域名访问验证地址，确认申请方能控制该域名对应的服务。
4. 验证通过后签发证书；acme.sh 将证书安装到 OpenResty 使用的路径。
5. 浏览器连接 HTTPS 时，检查证书签发链、域名和有效期。
6. 定时任务检查续期，需要时重新签发、安装并重新加载 OpenResty。

HTTP-01 中的 HTTP 仅用于域名控制权验证，网站访问使用 HTTPS。
证书证明域名控制权并支持加密连接，不是企业资质认证。
续期每天检查四次，不代表每天重新签发四张证书。需要持续保持 DNS 正确、
80 端口的验证路径可访问，以及续期定时任务和 OpenResty 服务可用。

Website 与 Dashboard 各使用覆盖自身域名的独立证书。2026-09-06 核验时，
Website 证书的签发者为 Let's Encrypt YE2，域名为 `www.frontmind.cn`，
有效期至北京时间 2026-12-04 21:37:45；系统信任库正常验证通过。

## Server configuration

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

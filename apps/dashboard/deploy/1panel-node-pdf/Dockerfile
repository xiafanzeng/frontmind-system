# Pin the exact Debian 12 / Node 22 image verified on the production host.
# A base change must update both this FROM line and the OCI audit labels below.
FROM 1panel/node:22.22.2@sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28

ARG VCS_REF=""
ARG IMAGE_VERSION="dashboard-20260728-r1-pdf2"

# Keep the package manager cache in the immutable image rather than in a
# disposable container home directory.
ENV COREPACK_HOME=/usr/local/share/corepack

LABEL org.opencontainers.image.source="https://github.com/xiafanzeng/frontmind-dashboard" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.version="${IMAGE_VERSION}" \
      net.frontmind.runtime.pnpm.version="10.4.1" \
      org.opencontainers.image.base.name="1panel/node:22.22.2" \
      org.opencontainers.image.base.digest="sha256:4cb7297e1c72cac9ee17659f28807f4756cefd4a13cf7bc2c0ba7254c616bb28"

# The verified 1Panel base runs as root. Fail closed if that invariant or the
# Debian/apt base changes, rather than silently building a different runtime.
RUN set -eux; \
    test "$(id -u)" = "0"; \
    test -f /etc/debian_version; \
    command -v apt-get; \
    apt-get update; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ghostscript \
      poppler-utils; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*; \
    command -v pdfinfo; \
    command -v pdftotext; \
    command -v pdfseparate; \
    command -v pdfunite; \
    command -v gs; \
    command -v corepack; \
    corepack enable; \
    corepack prepare pnpm@10.4.1 --activate; \
    command -v pnpm; \
    test "$(pnpm --version)" = "10.4.1"

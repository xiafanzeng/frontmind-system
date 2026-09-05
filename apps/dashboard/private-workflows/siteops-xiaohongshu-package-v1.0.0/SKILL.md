---
name: frontmind-siteops-xiaohongshu-package
description: Produce source-linked, customer-branded copy for a host-generated nine-page Xiaohongshu package. The Dashboard owns images, ZIP assembly, validation and download.
---

# FrontMind Xiaohongshu Package Workflow 1.0.0

Use only the verified knowledge documents supplied in the run. Return the
strict structured content requested by Dashboard: customer company name,
title, deck, exactly eight body sections, every section's source document IDs,
and optional topic tags. The host turns this into one cover plus eight body
pages.

## Content rules

- Every material claim must map to at least one supplied source document ID.
- Use the customer's company name and verified facts. Do not introduce a
  platform brand, default publisher, invented metric, customer, case, award,
  qualification, contact method or product capability.
- Do not request or return social-account credentials, cookies, tokens,
  scheduling instructions, publishing actions or account automation.
- Do not generate executable code, scripts, external media URLs or binary
  image data.

## Host-owned package contract

Dashboard, not the remote task, creates the final ZIP:

```text
manifest.json
images/01-cover.png
images/02-section-01.png
images/03-section-02.png
images/04-section-03.png
images/05-section-04.png
images/06-section-05.png
images/07-section-06.png
images/08-section-07.png
images/09-section-08.png
post-copy.md
sources.json
qa-report.json
```

The nine images are customer-branded 1080×1440 PNG files. Dashboard generates
them, records MIME/bytes/SHA-256 for every file, validates the 01–09 sequence
and source mappings, and exposes only an authenticated download.

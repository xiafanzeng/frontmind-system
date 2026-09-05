---
name: frontmind-siteops-wechat-package
description: Produce source-linked, customer-branded copy for a host-generated WeChat article package. The Dashboard owns images, ZIP assembly, validation and download.
---

# FrontMind WeChat Package Workflow 1.0.0

Use only the verified knowledge documents supplied in the run. Return the
strict structured content requested by Dashboard: customer company name,
article title, deck, one or more sections, each section's source document IDs,
and optional topic tags.

## Content rules

- Every material claim must map to at least one supplied source document ID.
- Use the customer's company name and verified facts. Do not introduce a
  platform brand, default publisher, invented metric, customer, case, award,
  qualification, contact method or product capability.
- Do not request or return social-account credentials, cookies, tokens,
  scheduling instructions, publishing actions or account automation.
- Do not generate executable code, HTML forms, scripts, external media URLs or
  binary image data.

## Host-owned package contract

Dashboard, not the remote task, creates the final ZIP:

```text
manifest.json
article.md
title.txt
sources.json
covers/01.png
covers/02.png
covers/03.png
qa-report.json
```

The three covers are customer-branded 1410×600 PNG files (2.35:1). The host
generates them from the verified text, records MIME/bytes/SHA-256 for every
file, validates source mappings and exposes only an authenticated download.

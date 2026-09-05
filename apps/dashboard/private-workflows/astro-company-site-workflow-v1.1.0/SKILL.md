---
name: frontmind-astro-company-site-workflow
description: FrontMind Dashboard runtime adapter for the verified Astro Company Site Workflow 1.0.0. It continues one SiteOps task from an immutable knowledge snapshot through one real 21st visual choice, an original native Astro build, bounded QA, and a private preview.
---

# FrontMind Astro Company Site Workflow 1.1.0

This package adapts the read-only upstream Workflow to FrontMind's server-owned
SiteOps run. The upstream archive and SHA are immutable provenance. This adapter
does not grant permission to publish, buy a domain, change DNS, or copy provider
code.

## Host boundary

- Dashboard owns credentials, the 21st MCP connection, immutable knowledge
  snapshot reads, candidate previews, user selection, canonical contract,
  artifacts, and QA.
- 21st is a Prompt-bearing visual catalog only. Call `search` and
  `get_component`; never call generation, iteration, installation, or publish
  tools.
- The remote build agent receives the verified brief, fixed safe taxonomy,
  same-origin preview, and later the canonical build contract. It never receives
  the 21st key, raw provider Prompt/code, customer secrets, or evidence files.
- The build agent first returns `design-system.json` and `seo-manifest.json`.
  Dashboard validates them, recomputes the selected Prompt proof transiently,
  composes the canonical contract locally, then continues the same remote task.
- All provider output and generated source is untrusted until the Dashboard
  allowlist, native-Astro, static-output, SEO, accessibility, and visual checks
  pass.

## Required input

Read `schemas/frontmind-run-envelope.schema.json`. A run is pinned to one
project revision, one knowledge snapshot/archive SHA, one workflow package SHA,
one selected Foundation candidate/Prompt SHA, and one build ID. Missing or
mismatched values block the build.

## Visual selection

Apply the upstream 18/12/9 funnel exactly: collect up to 18 unique search
results, retrieve in rank order until 12 explicit Prompt-bearing details are
valid or the pool ends, and present one board of up to nine real Foundation
previews. Zero blocks. One to eight are an honest degraded board. Never create a
filler. The customer chooses A-I or explicitly delegates to the highest-scored
candidate. Zero to two already retrieved Section/Motion sources may support the
chosen Foundation without overriding its global tokens.

Persist only provider identity, safe URL identity, response/Prompt hashes, the
fixed allowlist taxonomy, evaluation, and same-origin preview asset identity.
Raw Prompt and code remain only in the current Dashboard process memory.

## Native Astro output

- Start from `assets/astro-static-starter`; the host owns package/config files.
- Generate static `.astro` pages and native CSS only. Do not add React, Vue,
  Tailwind, shadcn, 21st packages, runtime fetches, client directives, external
  scripts, server endpoints, or mutable dependencies.
- Use verified facts and assets from the contract only. Omit missing content;
  never substitute demo companies, claims, metrics, testimonials, logos, stock
  media, or a form that pretends to submit.
- Preview output is authenticated and `noindex,nofollow`, with no production
  canonical, sitemap, or `llms.txt`. A launch build requires an exact HTTPS
  canonical and produces canonical metadata, JSON-LD, robots, sitemap, and
  `llms.txt` from verified content.
- Return source as a bounded archive containing only allowed `src/pages`,
  `src/components`, `src/layouts`, `src/styles`, and `public` paths. Do not
  return package manifests, lockfiles, executable scripts, symlinks, or absolute
  paths.

## Completion

Dashboard runs the trusted Astro toolchain and QA locally. At most three repair
messages may continue the same remote task. After that, report a visible QA
failure. A failed child build never mutates the prior preview, approved build,
or live deployment.

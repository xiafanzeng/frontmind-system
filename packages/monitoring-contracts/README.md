# Monitoring contracts

This package is a source-preserving copy of `packages/contracts` from
`frontmind-monitoring-system`. It contains the Zod contracts for monitoring,
results, billing, administration, and publishing. The package has no provider
credentials and does not implement authentication.

The `@frontmind/monitoring-*` namespace is intentional: the copied package is
kept separate from the Dashboard's existing application packages until the
server adapter maps its IDs and auth context.

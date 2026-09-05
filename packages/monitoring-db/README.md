# Monitoring database module

This package is a source-preserving copy of `packages/db` from
`frontmind-monitoring-system`, including the Drizzle schema, repositories,
worker adapter, and additive migration history.

The copied schema still describes the monitoring system's UUID domain model,
including its historical `users`/`sessions` tables. The unified Dashboard must
map its canonical user IDs through an account-link adapter before running these
migrations in the new database; this package deliberately does not create a
second browser login or session flow.

No database dump or credential is included. `DATABASE_URL` is read only at
runtime.

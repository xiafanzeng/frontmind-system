# Monitoring worker

This worker is a source-preserving copy of `apps/worker` from
`frontmind-monitoring-system` with tests and environment files omitted. It is
intended to run as a private process beside the Dashboard API and must not be
exposed as a public HTTP service.

The worker imports the unified `@frontmind/monitoring-*` packages. Set
`WORKER_REPOSITORY_MODULE=@frontmind/monitoring-db/worker-adapter` in its
runtime environment after the Dashboard adapter and account mapping are
implemented. Provider, object-store, and publishing secrets are runtime-only.

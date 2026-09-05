# Production parity and fusion

The Dashboard product baseline is the exact code running on the original production host: `xiafanzeng/frontmind-dashboard` commit `74ad2397bb8d701a9cdd58c51b5070359295cf8a`. The earlier fusion used an older local checkout and omitted later authentication, knowledge-base and site-building changes. Its client, server, shared contracts, build tools and private runtime workflows have now been restored from that production commit.

Monitoring remains a module of the Dashboard: `/api/monitoring` uses the canonical Dashboard session on every request. Tenant UUIDs are deterministic projections of canonical accounts, with transactional account links and zero-balance wallet initialization. The customer module lives at `/monitoring-system` and `/publishing`; its administration lives under `/admin/monitoring`. There is no second login or direct browser access to a provider.

The first 58 applied SQL migrations are unchanged. `0058_dashboard_production_parity` projects the missing production schema directly, adding tables/columns/indexes/constraints and relaxing two nullable references. It does not replay historical data clearing. The duplicated identity in the previous 0057 snapshot metadata was repaired so future schema generation works; this does not change applied SQL.

The new host has its own database and accounts. Runtime business configuration was reconciled against both the actual original production containers and the 1Panel runtime definitions. Business secrets and encrypted service-wide credential settings are transferred only over SSH into root-only server configuration. Source databases, user accounts, sessions and historical customer data are not bulk restored over the new product database.

Use `https://dashboard.frontmind.cn` and `https://www.frontmind.cn`. The IP and HTTP domains redirect to their canonical HTTPS destinations. Website uses its explicit `cn` deployment profile; the original `.net` profile remains unchanged in its repository.

The Dashboard and site-operations worker share the original application asset volumes. Monitoring API and worker share a private persistent directory on the data disk, explicitly enabled through `ALLOW_LOCAL_OBJECT_STORE_IN_PRODUCTION=true`. Object keys are validated, files remain private, reads require ownership or a signed capability, and no static directory is published.

KOL authentication and logo-search configuration were not present in the source environment or prior task. Real publishing must remain disabled until those are configured and verified. The worker may process DOCX imports and private asset cleanup with `PUBLISHER_PROVIDER_ENABLED=false`; that mode creates neither a KOL client nor a mock catalog. Do not describe an empty real catalog as a completed supplier synchronization.

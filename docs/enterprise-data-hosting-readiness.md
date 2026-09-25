# Enterprise data hosting / BYOD readiness audit

Status: **not production-ready**. `CUSTOMER_MANAGED` is not an implemented hosting mode. Do not sell, enable, or configure it for a tenant. No customer credentials should be collected yet.

## Existing implementation map

| Concern | Current path | Finding |
| --- | --- | --- |
| Authentication and tenant selection | `lib/auth.ts#getSession` → verified session → `lib/tenant-context.ts` | Tenant identity comes from the signed session, with live membership check on organization switching. Background jobs must establish their own tenant context. |
| Control plane | `lib/tenant-service.ts`, `lib/tenant-db/store.ts` | Tenants, plans and the routing registry are in the Muenot database. Platform DB APIs require super-admin authorization. |
| Business data | `lib/db.ts#query` and `withTransaction` | One global MySQL pool. Hundreds of application modules import it directly. The tenant SQL guard defaults to report-only. Transactions also use the global pool. |
| Isolated DB probe | `lib/tenant-db/router.ts` and `provisioning.ts` | Separate pools exist for separate-schema/dedicated profiles, but ordinary ERP repositories do **not** use this router. A successful health probe does not prove business-data isolation. |
| Secret reference | `lib/tenant-db/secret-ref.ts` | Dedicated DSN is read from a server environment variable by reference. This is not a customer-secret lifecycle, rotation service, or vault integration. |
| Provisioning/migration | `lib/tenant-db/provisioning.ts` | Isolated migration creates only a marker table. Business tables are not fully migrated. The current “backup” operation records a row-count manifest, **not** a recoverable backup. |
| Admin UI | `components/platform/tenant-database-console.tsx` | Platform-only configuration UI existed; it cannot be used to activate new isolated hosting until routing is complete. |

## Critical/high unresolved security and correctness gates

1. Business queries, transactions, schema self-healing, cron/background jobs, WhatsApp, finance, HR, CRM, reports, search, AI tools and notifications still need audited control/data-plane classification and tenant-routed adapters. Global-pool access to an isolated tenant would read/write the wrong data plane. This is a **critical isolation blocker**.
2. A full, versioned and independently verified business schema migration is absent. Marker-table migration is insufficient.
3. Customer network access needs enforced TLS certificate/hostname verification, DNS-resolution and private-address policy, DNS-rebinding defense, approved egress, bounded timeouts/pools, credential rotation and secret revocation. The existing DSN parser/pool does not provide these guarantees.
4. Existing isolated pools have no bounded cache/eviction and no verified drain-on-rotation. One tenant could consume process resources.
5. Backup manifest is not a restorable backup; neither restore drills nor customer-owned backup verification exist.
6. Residency cannot be promised until file storage, logs, email, search indexes, caches, analytics, AI and backups are inventoried and tested. Region metadata alone is not residency enforcement.
7. Tenant SQL guard defaults to `report`; it is heuristic, not a MySQL row-security mechanism. It does not protect every direct pool/transaction call.
8. Hosting-mode cutover needs dual-write or consistent snapshot/delta reconciliation, write freeze, checksums, rollback, audit, and explicit operator approval. Merely editing `deployment_model` would be unsafe.

## Safeguard in this change

New tenants can only be created in `shared_database`. Changing an existing tenant's hosting mode is rejected with `HOSTING_MODE_NOT_READY` (HTTP 409). The platform DB console also rejects attempts to configure/activate a non-shared target before it writes any region or routing settings. Existing isolated-mode records are not rewritten, deleted or silently switched. Shared mode and ordinary tenant edits remain supported. This is an activation gate, **not** a BYOD implementation.

## Required delivery sequence before pilot

1. Inventory and classify every SQL call and side store as control-plane or tenant business data. Replace direct global-pool business access with an explicit server-side tenant router; add routing-aware transactions and background job context.
2. Create a MySQL-only customer connection profile with server-side secret storage, staged rotation, mandatory verified TLS, DNS/IP policy, bounded pools and safe eviction. Do not accept arbitrary endpoints from tenant users.
3. Add full tenant schema migrations, drift checks, least-privilege runtime/migration users, migration locks and safe failed-migration recovery.
4. Build test-connection diagnostics with sanitized codes; implement health/circuit-breaker and no fallback to the shared data plane.
5. Implement a separately approved data migration/cutover state machine with reconciliation and rollback. Only then permit a selected pilot tenant to activate customer-managed mode.
6. Audit cross-tenant isolation, side stores, background jobs, all business modules, data residency and offboarding; run realistic customer-DB integration and restore tests, followed by security review.

Until all gates are met, the current supported production mode remains Muenot shared hosting. No database migration is required for this safeguard. No customer secrets, new hosting endpoint, or connector were added.

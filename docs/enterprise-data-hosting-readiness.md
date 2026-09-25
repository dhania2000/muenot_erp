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
| Provisioning/migration | `lib/tenant-db/provisioning.ts` | Schema creation is possible but leaves the tenant in `provisioning`. Marker-only migration and row-count “backup” were disabled because they cannot make the ERP usable or restorable. |
| Admin UI | `components/platform/tenant-database-console.tsx` | Platform-only configuration UI existed; it cannot be used to activate new isolated hosting until routing is complete. |

## Critical/high unresolved security and correctness gates

1. Business queries, transactions, schema self-healing, cron/background jobs, WhatsApp, finance, HR, CRM, reports, search, AI tools and notifications still need audited control/data-plane classification and tenant-routed adapters. Global-pool access to an isolated tenant would read/write the wrong data plane. This is a **critical isolation blocker**.
   A repository scan found roughly 632 files importing the global DB helper, 47 files calling the global pool directly, and more than 500 `CREATE TABLE` statements across schema/migrations. A one-line pool switch would not safely migrate this surface.
2. A full, versioned and independently verified business schema migration is absent. Marker-table migration is insufficient.
3. Customer network access needs enforced TLS certificate/hostname verification, DNS-resolution and private-address policy, DNS-rebinding defense, approved egress, bounded timeouts/pools, credential rotation and secret revocation. The existing DSN parser/pool does not provide these guarantees.
4. Existing isolated pools have no bounded cache/eviction and no verified drain-on-rotation. One tenant could consume process resources.
5. Backup manifest is not a restorable backup; neither restore drills nor customer-owned backup verification exist.
6. Residency cannot be promised until file storage, logs, email, search indexes, caches, analytics, AI and backups are inventoried and tested. Region metadata alone is not residency enforcement.
7. Tenant SQL guard defaults to `report`; it is heuristic, not a MySQL row-security mechanism. It does not protect every direct pool/transaction call.
8. Hosting-mode cutover needs dual-write or consistent snapshot/delta reconciliation, write freeze, checksums, rollback, audit, and explicit operator approval. Merely editing `deployment_model` would be unsafe.
9. No non-production customer MySQL instance or secure network path is currently available for end-to-end TLS, schema, migration, performance, failure, or restore verification. This is an external production-readiness blocker.

## Safeguard in this change

New tenants can only be created in `shared_database`. Changing an existing tenant's hosting mode is rejected with `HOSTING_MODE_NOT_READY` (HTTP 409). The platform DB console also rejects attempts to configure/activate a non-shared target before it writes any region or routing settings. Existing isolated-mode records are not rewritten, deleted or silently switched. Shared mode and ordinary tenant edits remain supported. This is an activation gate, **not** a BYOD implementation.

The isolated pool has a process-wide cap (`TENANT_DB_MAX_POOLS`, default 64, maximum 256), bounded per-pool queue and connection timeouts. A `mysqls://` managed DSN now enables certificate and hostname verification; `mysql://` remains a legacy, non-TLS transport and must not be used for customer-managed hosting. Infrastructure failures returned by the tenant-DB lifecycle API are mapped to stable, credential-free codes. The old marker-only migration and row-count backup endpoints now return explicit unavailable errors instead of false success. There is still no direct customer-managed connection/profile path.

The new direct-host network-policy primitive requires an exact deployment allowlist, rejects literal IP hosts, checks every resolved DNS answer against private/special-use ranges, and returns a pinned public address. It is **not yet wired to an active customer connection path**; merely having this primitive is not SSRF protection for existing dedicated connections.

## Required delivery sequence before pilot

1. Inventory and classify every SQL call and side store as control-plane or tenant business data. Replace direct global-pool business access with an explicit server-side tenant router; add routing-aware transactions and background job context.
2. Create a MySQL-only customer connection profile with server-side secret storage, staged rotation, mandatory verified TLS, DNS/IP policy, bounded pools and safe eviction. Do not accept arbitrary endpoints from tenant users.
3. Add full tenant schema migrations, drift checks, least-privilege runtime/migration users, migration locks and safe failed-migration recovery.
4. Build test-connection diagnostics with sanitized codes; implement health/circuit-breaker and no fallback to the shared data plane.
5. Implement a separately approved data migration/cutover state machine with reconciliation and rollback. Only then permit a selected pilot tenant to activate customer-managed mode.
6. Audit cross-tenant isolation, side stores, background jobs, all business modules, data residency and offboarding; run realistic customer-DB integration and restore tests, followed by security review.

Until all gates are met, the current supported production mode remains Muenot shared hosting. No database migration is required for this safeguard. No customer secrets, new hosting endpoint, or connector were added.

## Current feature compatibility (verified status)

| Module / surface | Shared DB | Isolated Muenot DB | Customer DB |
| --- | --- | --- | --- |
| Authentication, sessions, tenant directory, licensing | Existing control plane | Control-plane separation not fully audited | Not implemented |
| CRM, clients, vendors, finance, HR, attendance, projects | Existing shared-DB behavior | Business repository routing not verified | Not implemented |
| WhatsApp, email, notifications, automations, cron | Existing shared-DB behavior | Jobs/webhooks and credentials not verified | Not implemented |
| Reports, search, AI, dashboards, documents | Existing shared-DB behavior | Cross-store data flows not verified | Not implemented |
| Platform administration and DB health probe | Existing shared-DB behavior | Basic infrastructure probe only | Not implemented |

“Existing shared-DB behavior” is not a claim that every module has passed a new security review. No isolated or customer-managed module is certified by this audit.

# Specs 1–49: UI and ownership audit

Audit date: 2026-09-21

This document records where each specification is operated in the current ERP. The audit deliberately reuses the existing platform console, tenant administration pages and shared billing/storage/automation services. No parallel tenant, workflow, notification, queue or storage subsystem is introduced.

## Navigation decisions applied

- The **Platform Console** owns cross-tenant and infrastructure operations. It now exposes scheduled jobs, the central scheduler, background jobs/retries and job monitoring directly in its navigation.
- The **tenant Administration** area owns tenant-scoped access, organization, billing, storage and automation. Its control center only links to existing screens; it does not duplicate settings or data.
- Specifications that are implementation controls rather than user-configured capabilities (for example tenant isolation and job idempotency) remain enforced in their shared services and are represented in the UI that operates the relevant resource.

## Spec matrix

| Spec | Existing implementation / correct UI | Audit result |
| --- | --- | --- |
| 1. Multi-tenant SaaS foundation | `tenants`/tenant-context services; Platform Console → **Tenants & lifecycle** | Existing |
| 2. Tenant data isolation | `lib/tenant-scope.ts`, `lib/tenant-guard.ts`; tenant pages derive identity from session | Enforced control; no separate UI needed |
| 3. Platform and tenant administration separation | `/platform` guards and `/admin` tenant administration shell | Existing |
| 4. Super-admin console | Platform Console → **Overview**, **Tenants & lifecycle**, **Security & audit** | Existing |
| 5. Tenant onboarding | Platform Console → **Organization onboarding** | Existing |
| 6. Organization hierarchy | Administration → **Organization hierarchy** | Existing |
| 7. Multi-entity support | Administration → **Legal entities** | Existing |
| 8. RBAC | Administration → **Roles & permissions** | Existing |
| 9. ABAC | Administration → **Data permissions** | Existing |
| 10. Record-level scope | Administration → **Data permissions**; enforced in scoped record APIs | Existing |
| 11. Approval authority | Administration → **Approval authority** | Existing |
| 12. Maker-checker | Administration → **Maker-checker** | Existing |
| 13. Segregation of duties | Administration → **Segregation of duties** | Existing |
| 14. User lifecycle | Administration → **User lifecycle** | Existing |
| 15. Employee–user linking | Administration → **Employee links** | Existing |
| 16. Subscription management | Subscription & Billing → **Subscription Management** | Existing |
| 17. Plan management | Platform Console → **Plans & entitlements**; tenant plan view under **Plan Management** | Existing |
| 18. Feature entitlements | Subscription & Billing → **Feature Entitlements** | Existing |
| 19. Usage metering | Subscription & Billing → **Usage Metering**; platform usage overview | Existing |
| 20. Billing engine | Subscription & Billing → **Billing**, **Invoices & Credit Notes**, reconciliation controls | Existing |
| 21. Payment gateways | Subscription & Billing → **Payment Gateways** | Existing |
| 22. Payment webhooks | Subscription & Billing → **Payment Webhooks** | Existing |
| 23. Invoice and credit notes | Subscription & Billing → **Invoices & Credit Notes** | Existing |
| 24. Renewal management | Subscription & Billing → **Renewals** | Existing |
| 25. Customer billing portal | Subscription & Billing → **Customer Billing Portal** | Existing |
| 26. Customer-owned storage | Storage → **Storage connections** | Existing |
| 27. Storage isolation and encryption | Storage configuration and tenant key-prefix service | Existing; control is server-enforced |
| 28. Storage health | Storage → connection health panel | Existing |
| 29. Signed file access | Storage service/download proxy | Existing; no secret-bearing UI |
| 30. Multipart uploads | Storage → **Large uploads** | Existing |
| 31. CDN/media delivery | Storage service delivery policy | Existing; provider policy is not a duplicate screen |
| 32. Central file metadata | Shared storage metadata services and file panels | Existing |
| 33. File versioning | Storage → **File versions** | Existing |
| 34. File scanning | Shared storage scan state | Existing; surfaced with file health rather than a second scanner |
| 35. Storage quotas | Platform Console → **Usage & storage** and entitlement limits | Existing |
| 36. Storage retention | Storage → **Retention policies** | Existing |
| 37. Configuration management | Platform Console → **Configuration**, **Environment & config** | Existing |
| 38. Secrets management | Platform Console → **Secrets**; tenant APIs never expose secret values | Existing |
| 39. Tenant configuration | Administration → **Tenant settings** | Existing |
| 40. Cron/scheduled jobs | Platform Console → **Scheduled jobs** | Wired in this audit |
| 41. Central scheduler | Platform Console → **Central scheduler** | Wired in this audit |
| 42. Background queue | Platform Console → **Background jobs & retries** | Wired in this audit |
| 43. Job monitoring | Platform Console → **Job monitoring & alerts**; tenant Administration → **Job monitoring** | Wired in this audit |
| 44. Idempotent job execution | Shared queue/idempotency ledger; shown in job details | Existing control; no duplicate settings page |
| 45. Retries and dead-letter queue | Platform Console → **Background jobs & retries** | Wired in this audit |
| 46. Workflow engine | Automation → **Workflows** | Existing |
| 47. Visual workflow builder | Automation → **Workflows** | Existing |
| 48. Event bus | Automation → **Events** | Existing |
| 49. Notification engine | Automation → **Notifications**; user notification preferences remain under profile preferences | Existing |

## Verification boundary

This audit verifies repository routes, navigation, guards and linked services. Provider credentials and production-only integrations (payment processors, object storage providers, cron invokers and delivery channels) still require their environment configuration and operational testing after deployment. Their UI intentionally reports unconfigured state instead of creating sample records or fake success states.

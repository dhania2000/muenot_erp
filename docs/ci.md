# CI and security checks (Spec 23, #147–149)

Two workflows replace the old generic `webpack.yml` (which ran `npx webpack` — this is a Next 16 / Turbopack app with no webpack config, so it never tested anything).

## Workflows

### `.github/workflows/ci.yml` — every push to `main` and every pull request

| Job | What it does | Fails when |
|---|---|---|
| **Install** | `pnpm install --frozen-lockfile` (pnpm 10, Node 22) | `pnpm-lock.yaml` is out of sync with `package.json` |
| **Typecheck (ratchet)** | `pnpm typecheck` — full `tsc --noEmit`, compared per file with `scripts/ci/typecheck-baseline.json` | any file has more errors than its baseline (new files must be clean). New errors are shown as inline PR annotations |
| **Unit tests** | `pnpm test:critical` (tenant isolation, scope, permission, guard, billing, checkout, webhook, idempotency suites) first, then the full `pnpm test` | any test fails |
| **Build** | `pnpm build` (`next build`) and uploads `.next` | the build fails |
| **E2E smoke** | MySQL 8 service → `scripts/ci/db-bootstrap.sh` → mock Stripe → `next start` → `pnpm test:e2e` | login, tenant boundary or checkout smoke fails |

### `.github/workflows/security.yml` — every PR, `main`, and weekly (Mon 03:17 UTC)

| Job | Tool | Report |
|---|---|---|
| **Dependency audit** | `pnpm audit --prod` → `scripts/ci/audit-report.mjs` | Markdown table in the job summary and the `dependency-audit` artifact: severity, package, vulnerable range, the version to upgrade to, dependency path, advisory link. Fails on `high`/`critical` (set `AUDIT_FAIL_LEVEL` to change) |
| **Secret scan** | gitleaks, full history, `.gitleaks.toml` | Findings with file, line and commit in the job log/summary |
| **SAST** | CodeQL `security-extended` for JS/TS | Alerts under *Security → Code scanning*, with inline PR annotations |

## Required checks

In *Settings → Branches → Branch protection* for `main`, require these checks:

- `Install`
- `Typecheck (ratchet)`
- `Unit tests`
- `Build`
- `E2E smoke (login, tenant boundary, checkout)`
- `Dependency audit`
- `Secret scan`
- `SAST (CodeQL)`

## Secrets

CI does not need any production credentials. The E2E job uses a throwaway MySQL container, a mock Stripe server (`scripts/ci/mock-stripe.mjs`) and values generated per run. Repository secrets are optional overrides:

| Secret | Used by | Default if unset |
|---|---|---|
| `CI_MYSQL_PASSWORD` | E2E MySQL root password | fixed throwaway value (the container is not reachable from outside the runner) |
| `CI_SESSION_SECRET` | `SESSION_SECRET` for `next start` | generated from the run id |
| `CI_E2E_PASSWORD` | password seeded for the E2E fixture users | generated from the run id |
| `GITLEAKS_LICENSE` | gitleaks-action | required **only** if the repository is owned by an organisation |

Never put real gateway keys (Stripe, Razorpay, …) into CI. The checkout smoke test only needs `sk_test_mock` plus `STRIPE_API_BASE` pointing at the mock.

## Local commands

```bash
pnpm install --frozen-lockfile
pnpm typecheck                 # next typegen + tsc ratchet (needs ~6 GB RAM; don't run alongside build on <16 GB)
pnpm typecheck:baseline        # after fixing errors: lock in the lower count and commit
pnpm test                      # full unit suite
pnpm test:critical             # tenant/permission/billing/webhook suites only
pnpm build
pnpm audit:report              # writes audit-report.md
```

E2E against a local MySQL/MariaDB:

```bash
export DB_HOST=127.0.0.1 DB_PORT=3306 DB_USER=root DB_PASSWORD=... DB_NAME=erp_e2e
export SESSION_SECRET=local-e2e-secret E2E_PASSWORD='Local!e2e1'
export STRIPE_SECRET_KEY=sk_test_mock STRIPE_API_BASE=http://127.0.0.1:12111/v1
pnpm ci:db                                   # DROPS and recreates $DB_NAME
node scripts/ci/mock-stripe.mjs &
pnpm build && pnpm exec next start -p 3100 &
E2E_BASE_URL=http://127.0.0.1:3100 pnpm test:e2e
```

Secret scan and SAST locally: `gitleaks detect --config .gitleaks.toml` and the CodeQL CLI (`codeql database create … && codeql database analyze …`).

## What the E2E smoke covers

`test-e2e/smoke.e2e.ts` seeds two tenants (`e2e-alpha`, `e2e-beta`) with an admin each, a non-admin member in alpha, and one open invoice per tenant (`scripts/ci/seed-e2e.mjs`, idempotent). Then it checks:

- **Login**: a wrong password returns 401 with no session cookie. A valid login gives a session tied to the user's own tenant. Anonymous requests to tenant data are rejected.
- **Tenant boundary**: each admin sees only their own tenant's invoices. Opening checkout on another tenant's invoice id returns 404, even if the request body names that tenant's id. A same-tenant non-admin gets 403.
- **Checkout**: the first request creates a PaymentIntent (201). Repeating it replays the same pending payment (200, `replayed: true`, same `paymentNo`). An unconfigured provider returns 400.

## Checkout hardening shipped with this spec

`POST /api/billing/invoices/[id]/checkout` now calls `lib/billing/checkout.ts`, which:

- takes the tenant from the session only and ignores any `tenantId` in the body; the invoice lookup is scoped to that tenant;
- validates the provider and a `max 128 char` `Idempotency-Key` header;
- derives a deterministic key from tenant + invoice + provider + amount when the client sends none, so double-clicks and retries reuse the pending payment instead of opening a second one. The key is also sent to the gateway;
- enforces uniqueness with the `uq_billing_payments_checkout` index on `billing_payments (tenant_id, checkout_key)`, added by migration `2027-01-15-spec23-idempotent-checkout.sql` and the runtime schema self-heal;
- writes an audit entry for every opened checkout and returns 409 for invoices that are paid/void or have no balance.

## Dependency remediations

- **`xlsx`** is installed from SheetJS's official tarball (`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), because the npm registry copy stops at the vulnerable 0.18.5 (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9). To upgrade, change the URL in `package.json`. CI needs outbound access to `cdn.sheetjs.com`.
- Transitive advisories (brace-expansion, ip-address, nanoid, browserslist, hono, @hono/node-server, qs, baseline-browser-mapping, body-parser, postcss-selector-parser) are pinned with range-scoped `overrides` in `pnpm-workspace.yaml`. Each override only matches the vulnerable range. Remove an entry once the parent package ships the fix.

## Known limits

- **Type errors on `main`.** `next.config` still sets `typescript.ignoreBuildErrors`, and the baseline holds the pre-existing errors. The ratchet stops new errors from being added. Remove `ignoreBuildErrors` once the baseline reaches zero.
- **Migration chain is not replay-clean.** Some historical migrations depend on tables that are created later or at runtime, or have FK type drift. `db-bootstrap.sh` replays them with `--force` and uploads `migration-report.md` so the drift is visible. The app's runtime `ensure*Schema` self-heal covers the tables the smoke tests use.
- **`package-lock.json` is stale.** CI uses `pnpm-lock.yaml` only. Delete `package-lock.json` to avoid confusion.

import "server-only"
/**
 * Read-only platform observability aggregations.
 * ---------------------------------------------------------------------------
 * Everything here is derived live from real state (the database, the running
 * process, the environment) — no fabricated numbers. Used by the Super Admin
 * overview dashboard and the usage / storage / health / jobs / security /
 * integrations screens. Platform-gated (lib/platform-guard.ts).
 */
import { query } from "@/lib/db"
import { listSubscriptions, listInvoices } from "@/lib/platform-console"

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)

// ---------------------------------------------------------------------------
// Overview metrics
// ---------------------------------------------------------------------------

export type PlatformMetrics = {
  tenants: { total: number; active: number; suspended: number; inactive: number }
  users: { total: number; platformStaff: number; superAdmins: number }
  subscriptions: { total: number; active: number; trialing: number; pastDue: number; canceled: number }
  revenue: { mrr: number; arr: number; currency: string; openInvoices: number; openInvoiceTotal: number }
}

export async function getPlatformMetrics(): Promise<PlatformMetrics> {
  const [tenantRows, userRows, roleRows] = await Promise.all([
    query<any[]>("SELECT `status`, COUNT(*) AS n FROM `tenants` GROUP BY `status`"),
    query<any[]>("SELECT COUNT(*) AS n FROM `users`"),
    query<any[]>("SELECT `platform_role`, COUNT(*) AS n FROM `users` GROUP BY `platform_role`").catch(() => []),
  ])

  const tenants = { total: 0, active: 0, suspended: 0, inactive: 0 }
  for (const r of tenantRows) {
    const n = num(r.n)
    tenants.total += n
    if (r.status === "active") tenants.active = n
    else if (r.status === "suspended") tenants.suspended = n
    else if (r.status === "inactive") tenants.inactive = n
  }

  const users = { total: num(userRows[0]?.n), platformStaff: 0, superAdmins: 0 }
  for (const r of roleRows) {
    if (r.platform_role === "platform_staff") users.platformStaff = num(r.n)
    else if (r.platform_role === "platform_super_admin") users.superAdmins = num(r.n)
  }

  const subs = await listSubscriptions()
  const subscriptions = { total: subs.length, active: 0, trialing: 0, pastDue: 0, canceled: 0 }
  let mrr = 0
  let currency = "USD"
  for (const s of subs) {
    if (s.status === "active") subscriptions.active++
    else if (s.status === "trialing") subscriptions.trialing++
    else if (s.status === "past_due") subscriptions.pastDue++
    else if (s.status === "canceled") subscriptions.canceled++
    if (s.status !== "canceled") mrr += s.mrr
    currency = s.currency || currency
  }

  const invoices = await listInvoices()
  const open = invoices.filter((i) => i.status === "open")
  const revenue = {
    mrr,
    arr: mrr * 12,
    currency,
    openInvoices: open.length,
    openInvoiceTotal: open.reduce((sum, i) => sum + i.amount, 0),
  }

  return { tenants, users, subscriptions, revenue }
}

// ---------------------------------------------------------------------------
// Usage & storage
// ---------------------------------------------------------------------------

export type StorageBreakdown = {
  totalBytes: number
  tableCount: number
  rowEstimate: number
  tables: { name: string; bytes: number; rows: number }[]
}

/** Real storage figures straight from information_schema for the app database. */
export async function getStorageBreakdown(): Promise<StorageBreakdown> {
  const rows = await query<any[]>(
    `SELECT table_name AS name,
            (data_length + index_length) AS bytes,
            table_rows AS rows
       FROM information_schema.tables
      WHERE table_schema = DATABASE()
      ORDER BY (data_length + index_length) DESC`,
  )
  let totalBytes = 0
  let rowEstimate = 0
  const tables = rows.map((r) => {
    const bytes = num(r.bytes)
    const rowsN = num(r.rows)
    totalBytes += bytes
    rowEstimate += rowsN
    return { name: String(r.name), bytes, rows: rowsN }
  })
  return { totalBytes, tableCount: tables.length, rowEstimate, tables: tables.slice(0, 25) }
}

export type UsageMetrics = {
  perTenant: { tenant_id: number; tenant_name: string; users: number; seatLimit: number | null; planName: string }[]
  totalUsers: number
}

/** Per-tenant user counts vs. their plan seat limit — real occupancy data. */
export async function getUsageMetrics(): Promise<UsageMetrics> {
  const rows = await query<any[]>(
    `SELECT t.id AS tenant_id, t.name AS tenant_name, COUNT(u.id) AS users,
            p.seat_limit AS seat_limit, COALESCE(p.name, s.plan_code, '—') AS plan_name
       FROM \`tenants\` t
       LEFT JOIN \`users\` u ON u.tenant_id = t.id
       LEFT JOIN \`tenant_subscriptions\` s ON s.tenant_id = t.id
       LEFT JOIN \`platform_plans\` p ON p.code = s.plan_code
      GROUP BY t.id, t.name, p.seat_limit, p.name, s.plan_code
      ORDER BY users DESC`,
  )
  let totalUsers = 0
  const perTenant = rows.map((r) => {
    const users = num(r.users)
    totalUsers += users
    return {
      tenant_id: num(r.tenant_id),
      tenant_name: String(r.tenant_name),
      users,
      seatLimit: r.seat_limit != null ? num(r.seat_limit) : null,
      planName: String(r.plan_name),
    }
  })
  return { perTenant, totalUsers }
}

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

export type HealthCheck = { name: string; status: "ok" | "warn" | "down"; detail: string }
export type SystemHealth = {
  overall: "ok" | "warn" | "down"
  checks: HealthCheck[]
  runtime: { nodeVersion: string; platform: string; uptimeSeconds: number; env: string }
}

export async function getSystemHealth(): Promise<SystemHealth> {
  const checks: HealthCheck[] = []

  // Database connectivity + latency.
  const started = Date.now()
  try {
    await query("SELECT 1")
    const ms = Date.now() - started
    checks.push({
      name: "Database",
      status: ms < 300 ? "ok" : "warn",
      detail: `Connected — ${ms}ms round-trip`,
    })
  } catch (err) {
    checks.push({ name: "Database", status: "down", detail: (err as Error).message || "Connection failed" })
  }

  // Required DB env presence.
  const requiredEnv = ["DB_HOST", "DB_USER", "DB_NAME"]
  const missing = requiredEnv.filter((k) => !process.env[k])
  checks.push({
    name: "Configuration",
    status: missing.length === 0 ? "ok" : "warn",
    detail: missing.length === 0 ? "All required variables present" : `Missing: ${missing.join(", ")}`,
  })

  // Auth secret presence.
  checks.push({
    name: "Auth",
    status: process.env.AUTH_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET ? "ok" : "warn",
    detail:
      process.env.AUTH_SECRET || process.env.JWT_SECRET || process.env.SESSION_SECRET
        ? "Session signing secret configured"
        : "No session signing secret detected",
  })

  const order = { ok: 0, warn: 1, down: 2 } as const
  const overall = checks.reduce<HealthCheck["status"]>((worst, c) => (order[c.status] > order[worst] ? c.status : worst), "ok")

  return {
    overall,
    checks,
    runtime: {
      nodeVersion: process.version,
      platform: `${process.platform} ${process.arch}`,
      uptimeSeconds: Math.round(process.uptime()),
      env: process.env.NODE_ENV || "development",
    },
  }
}

// ---------------------------------------------------------------------------
// Scheduled jobs (registry of the app's real cron endpoints)
// ---------------------------------------------------------------------------

export type ScheduledJob = {
  name: string
  path: string
  schedule: string
  description: string
  enabled: boolean
}

/**
 * The platform's scheduled jobs. These map to real cron route handlers under
 * app/api/cron. `enabled` reflects whether the cron authentication secret is
 * configured — without it, Vercel Cron cannot invoke them.
 */
export function getScheduledJobs(): ScheduledJob[] {
  const cronConfigured = Boolean(process.env.CRON_SECRET)
  return [
    {
      name: "Subscription renewal reminders",
      path: "/api/cron",
      schedule: "0 6 * * *",
      description: "Emails owners about upcoming subscription renewals and expiries.",
      enabled: cronConfigured,
    },
    {
      name: "Invoice generation",
      path: "/api/cron",
      schedule: "0 0 1 * *",
      description: "Issues current-period invoices for active subscriptions.",
      enabled: cronConfigured,
    },
    {
      name: "Session cleanup",
      path: "/api/cron",
      schedule: "0 3 * * *",
      description: "Purges expired sessions and stale tokens.",
      enabled: cronConfigured,
    },
  ]
}

// ---------------------------------------------------------------------------
// Integrations (known registry + live env presence)
// ---------------------------------------------------------------------------

export type IntegrationStatus = {
  name: string
  category: string
  connected: boolean
  detail: string
}

export function getIntegrations(): IntegrationStatus[] {
  const has = (...keys: string[]) => keys.some((k) => Boolean(process.env[k]))
  return [
    {
      name: "MySQL database",
      category: "Data",
      connected: has("DB_HOST"),
      detail: has("DB_HOST") ? `Host ${process.env.DB_HOST}` : "Not configured",
    },
    {
      name: "Email (SMTP)",
      category: "Communication",
      connected: has("SMTP_HOST", "EMAIL_SERVER_HOST", "RESEND_API_KEY"),
      detail: has("SMTP_HOST", "EMAIL_SERVER_HOST", "RESEND_API_KEY") ? "Configured" : "Not configured",
    },
    {
      name: "Vercel Cron",
      category: "Automation",
      connected: has("CRON_SECRET"),
      detail: has("CRON_SECRET") ? "Cron secret present" : "No CRON_SECRET set",
    },
    {
      name: "Blob storage",
      category: "Storage",
      connected: has("BLOB_READ_WRITE_TOKEN"),
      detail: has("BLOB_READ_WRITE_TOKEN") ? "Token present" : "Not configured",
    },
    {
      name: "Supabase redirect proxy",
      category: "Auth",
      connected: has("NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL"),
      detail: has("NEXT_PUBLIC_DEV_SUPABASE_REDIRECT_URL") ? "Configured" : "Not configured",
    },
  ]
}

// ---------------------------------------------------------------------------
// Deployment / environment info
// ---------------------------------------------------------------------------

export type DeploymentInfo = {
  environment: string
  region: string
  nodeVersion: string
  commitSha: string | null
  branch: string | null
  url: string | null
}

export function getDeploymentInfo(): DeploymentInfo {
  return {
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
    region: process.env.VERCEL_REGION || "local",
    nodeVersion: process.version,
    commitSha: process.env.VERCEL_GIT_COMMIT_SHA || null,
    branch: process.env.VERCEL_GIT_COMMIT_REF || null,
    url: process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  }
}

// ---------------------------------------------------------------------------
// Security events + audit log (from platform_admin_audit)
// ---------------------------------------------------------------------------

export type AuditEntry = {
  id: number
  actor_user_id: number
  actor_email: string | null
  action: string
  target_user_id: number | null
  target_tenant_id: number | null
  detail: Record<string, unknown> | null
  created_at: string
}

function mapAudit(r: any): AuditEntry {
  let detail: Record<string, unknown> | null = null
  if (r.detail) {
    try {
      detail = typeof r.detail === "string" ? JSON.parse(r.detail) : r.detail
    } catch {
      detail = null
    }
  }
  return {
    id: num(r.id),
    actor_user_id: num(r.actor_user_id),
    actor_email: r.actor_email ?? null,
    action: r.action,
    target_user_id: r.target_user_id != null ? num(r.target_user_id) : null,
    target_tenant_id: r.target_tenant_id != null ? num(r.target_tenant_id) : null,
    detail,
    created_at: r.created_at,
  }
}

export async function listAuditLog(limit = 100): Promise<AuditEntry[]> {
  const rows = await query<any[]>(
    "SELECT * FROM `platform_admin_audit` ORDER BY `created_at` DESC, `id` DESC LIMIT ?",
    [Math.max(1, Math.min(500, limit))],
  ).catch(() => [])
  return rows.map(mapAudit)
}

/** Security-relevant subset of the audit log (impersonation, role changes). */
const SECURITY_ACTIONS = [
  "impersonation_start",
  "impersonation_stop",
  "assign_platform_role",
  "assign_tenant_role",
  "tenant_status_change",
]

export async function listSecurityEvents(limit = 100): Promise<AuditEntry[]> {
  const placeholders = SECURITY_ACTIONS.map(() => "?").join(",")
  const rows = await query<any[]>(
    `SELECT * FROM \`platform_admin_audit\` WHERE \`action\` IN (${placeholders})
      ORDER BY \`created_at\` DESC, \`id\` DESC LIMIT ?`,
    [...SECURITY_ACTIONS, Math.max(1, Math.min(500, limit))],
  ).catch(() => [])
  return rows.map(mapAudit)
}

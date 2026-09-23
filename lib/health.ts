import "server-only"

/**
 * SPEC 77 — High availability: application health probes.
 *
 * A horizontally scaled deployment (multiple application servers + background
 * workers behind a load balancer) needs machine-readable probes so the LB /
 * orchestrator can:
 *   - LIVENESS: confirm the process is up and serving (restart if not).
 *   - READINESS: confirm the node's critical dependencies (the database) are
 *     reachable, so an unhealthy node is drained from rotation instead of
 *     serving errors.
 *
 * These checks are intentionally cheap, dependency-light, and leak no secrets —
 * only booleans, latencies, and short status strings. They are safe to expose
 * unauthenticated because that is how infrastructure probes consume them.
 */

import { pool } from "@/lib/db"

export type DependencyStatus = {
  ok: boolean
  latencyMs: number
  detail?: string
}

export type ReadinessReport = {
  ok: boolean
  timestamp: string
  checks: {
    database: DependencyStatus
    storage: DependencyStatus
  }
}

const DB_PROBE_TIMEOUT_MS = 2500

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new Error("Probe timed out")), ms))
}

/**
 * Verify the database is reachable with a trivial round-trip. Uses the pool
 * directly (no tenant guard / write capture) and races a timeout so a hung
 * connection can't stall the probe and wedge the load balancer.
 */
export async function checkDatabase(): Promise<DependencyStatus> {
  const started = Date.now()
  if (!process.env.DB_HOST || !process.env.DB_USER || !process.env.DB_NAME) {
    return { ok: false, latencyMs: 0, detail: "Database is not configured" }
  }
  try {
    await Promise.race([pool.query("SELECT 1"), timeout(DB_PROBE_TIMEOUT_MS)])
    return { ok: true, latencyMs: Date.now() - started }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      detail: (error as { code?: string })?.code || "Database unreachable",
    }
  }
}

/**
 * Report whether a durable storage backend is configured. Per-tenant buckets
 * live in the database (covered by the database probe); here we only confirm a
 * default/managed store exists so uploads have somewhere to go. This is
 * config-only (no network call) and never gates readiness on a third party.
 */
export function checkStorage(): DependencyStatus {
  const configured = Boolean(
    process.env.BLOB_READ_WRITE_TOKEN ||
      process.env.STORAGE_S3_BUCKET ||
      (process.env.AWS_S3_BUCKET && process.env.AWS_ACCESS_KEY_ID),
  )
  return {
    ok: configured,
    latencyMs: 0,
    detail: configured ? undefined : "No managed storage backend configured",
  }
}

/**
 * Assemble the readiness report. The node is READY when the database is
 * reachable — that is the hard dependency shared by every request. Storage is
 * reported for observability but does not gate readiness, because storage is
 * resolved per-tenant at request time and its absence should not drain an
 * otherwise-serving node from the pool.
 */
export async function getReadiness(): Promise<ReadinessReport> {
  const database = await checkDatabase()
  const storage = checkStorage()
  return {
    ok: database.ok,
    timestamp: new Date().toISOString(),
    checks: { database, storage },
  }
}

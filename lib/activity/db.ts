import "server-only"
/**
 * SPEC 109 — Activity Timeline: data layer (Phase 2 & 3).
 * ---------------------------------------------------------------------------
 * The ONE place that reads and writes the centralized `activity_events` stream.
 * Mirrors the self-healing approach used elsewhere (lib/contacts/db.ts,
 * lib/sales/lead-lifecycle.ts): the schema is created / upgraded at runtime so
 * existing databases converge without a manual migration, then every read/write
 * is tenant-scoped.
 *
 * Ordering, keyset pagination and visibility all come from the PURE model
 * (model.ts) so the DB pre-filters cheaply on indexed columns and the model has
 * the authoritative final say — the exact same logic the unit tests exercise.
 */

import { query, pool } from "@/lib/db"
import { currentTenantId } from "@/lib/tenant-scope"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import { nextRecordId } from "@/lib/record-ids"
import {
  allowedKindsFor,
  buildActivityEvent,
  canViewActivity,
  clampLimit,
  decodeCursor,
  encodeCursor,
  isActivityKind,
  maxVisibilityRankFor,
  visibilityRank,
  type ActivityEvent,
  type ActivityEventInput,
  type ActivityKind,
  type ActivityViewer,
} from "@/lib/activity/model"

let ensured: Promise<void> | null = null

async function runEnsure(): Promise<void> {
  await query(`CREATE TABLE IF NOT EXISTS \`activity_events\` (
    \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    \`activity_code\` VARCHAR(40) DEFAULT NULL,
    \`kind\` VARCHAR(30) NOT NULL,
    \`subject_type\` VARCHAR(60) NOT NULL,
    \`subject_id\` VARCHAR(64) NOT NULL,
    \`subject_label\` VARCHAR(190) DEFAULT NULL,
    \`action\` VARCHAR(200) DEFAULT NULL,
    \`title\` VARCHAR(200) NOT NULL,
    \`body\` TEXT DEFAULT NULL,
    \`source_module\` VARCHAR(60) DEFAULT NULL,
    \`actor_id\` INT UNSIGNED DEFAULT NULL,
    \`actor_type\` VARCHAR(20) NOT NULL DEFAULT 'user',
    \`ref_type\` VARCHAR(60) DEFAULT NULL,
    \`ref_id\` VARCHAR(64) DEFAULT NULL,
    \`visibility\` VARCHAR(20) NOT NULL DEFAULT 'timeline',
    \`visibility_rank\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`importance\` TINYINT UNSIGNED NOT NULL DEFAULT 0,
    \`watchers\` JSON DEFAULT NULL,
    \`meta\` JSON DEFAULT NULL,
    \`occurred_at\` DATETIME(3) NOT NULL,
    \`tenant_id\` INT UNSIGNED DEFAULT NULL,
    \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (\`id\`),
    UNIQUE KEY \`uq_activity_code\` (\`activity_code\`),
    KEY \`idx_activity_subject\` (\`tenant_id\`, \`subject_type\`, \`subject_id\`, \`occurred_at\`, \`id\`),
    KEY \`idx_activity_kind\` (\`tenant_id\`, \`kind\`, \`occurred_at\`, \`id\`),
    KEY \`idx_activity_actor\` (\`tenant_id\`, \`actor_id\`, \`occurred_at\`, \`id\`),
    KEY \`idx_activity_feed\` (\`tenant_id\`, \`occurred_at\`, \`id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Spec42: idempotent ingestion (webhook retries, double-submits) keyed per tenant.
  const dedupeCol = await query<any[]>(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'activity_events' AND column_name = 'dedupe_key' LIMIT 1`,
  )
  if (dedupeCol.length === 0) {
    await query(
      `ALTER TABLE \`activity_events\`
         ADD COLUMN \`dedupe_key\` VARCHAR(191) DEFAULT NULL,
         ADD UNIQUE KEY \`uq_activity_dedupe\` (\`tenant_id\`, \`dedupe_key\`)`,
    ).catch((err: any) => {
      if (err?.code !== "ER_DUP_FIELDNAME" && err?.code !== "ER_DUP_KEYNAME") throw err
    })
  }

  await registerActivityFeatures()
  await ensureTenantIsolation()
}

/**
 * Register the timeline features into the feature registry if the table exists
 * and they are missing. Non-fatal: permission checks fall back safely.
 */
async function registerActivityFeatures(): Promise<void> {
  const hasFeatures = await query<any[]>(
    `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'features' LIMIT 1`,
  ).catch(() => [] as any[])
  if (hasFeatures.length === 0) return
  const cols = await query<any[]>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'features'`,
  ).catch(() => [] as any[])
  const names = new Set(cols.map((c: any) => String(c.column_name || c.COLUMN_NAME)))
  if (!names.has("feature_key") && !names.has("key")) return
  const keyCol = names.has("feature_key") ? "feature_key" : "key"
  const rows: Array<[string, string, string]> = [
    ["activity.view_timeline", "View Activity Timeline", "activity"],
    ["activity.record_activity", "Record Activity", "activity"],
  ]
  for (const [key, label, moduleSlug] of rows) {
    const fields = [keyCol]
    const values: any[] = [key]
    if (names.has("name")) {
      fields.push("name")
      values.push(label)
    } else if (names.has("label")) {
      fields.push("label")
      values.push(label)
    }
    if (names.has("module")) {
      fields.push("module")
      values.push(moduleSlug)
    } else if (names.has("module_slug")) {
      fields.push("module_slug")
      values.push(moduleSlug)
    }
    await query(
      `INSERT IGNORE INTO \`features\` (${fields.map((f) => `\`${f}\``).join(",")}) VALUES (${fields
        .map(() => "?")
        .join(",")})`,
      values,
    ).catch(() => {})
  }
}

export async function ensureActivityTables(): Promise<void> {
  if (!ensured) {
    ensured = runEnsure().catch((err) => {
      ensured = null
      throw err
    })
  }
  return ensured
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type RecordedActivity = { id: number; activity_code: string; duplicate?: boolean }

async function findByDedupeKey(tenantId: number, dedupeKey: string): Promise<RecordedActivity | null> {
  const rows = await query<any[]>(
    `SELECT id, activity_code FROM activity_events WHERE tenant_id = ? AND dedupe_key = ? LIMIT 1`,
    [tenantId, dedupeKey],
  )
  return rows[0] ? { id: Number(rows[0].id), activity_code: String(rows[0].activity_code), duplicate: true } : null
}

/**
 * Append one activity to the centralized stream for the current tenant. Returns
 * the new id + code. Use `recordActivitySafe` from module code paths where a
 * timeline write must never break the primary operation.
 *
 * `opts.dedupeKey` makes the write idempotent per tenant: a repeat returns the
 * original event with `duplicate: true` instead of inserting a second row.
 */
export async function recordActivity(
  input: ActivityEventInput,
  opts: { dedupeKey?: string | null } = {},
): Promise<RecordedActivity> {
  await ensureActivityTables()
  const tenantId = currentTenantId()
  const event = buildActivityEvent(input)
  const dedupeKey = opts.dedupeKey ? String(opts.dedupeKey).slice(0, 191) : null
  if (dedupeKey) {
    const existing = await findByDedupeKey(tenantId, dedupeKey)
    if (existing) return existing
  }
  const code = await nextRecordId("ACT").catch(() => `ACT-${Date.now()}`)

  let result: any
  try {
    result = await insertEvent(event, code, tenantId, dedupeKey)
  } catch (err: any) {
    if (dedupeKey && err?.code === "ER_DUP_ENTRY") {
      const existing = await findByDedupeKey(tenantId, dedupeKey)
      if (existing) return existing
    }
    throw err
  }
  const id = Number((result as any)?.insertId ?? 0)
  return { id, activity_code: code, duplicate: false }
}

async function insertEvent(
  event: ReturnType<typeof buildActivityEvent>,
  code: string,
  tenantId: number,
  dedupeKey: string | null,
): Promise<any> {
  return query<any>(
    `INSERT INTO activity_events
       (activity_code, kind, subject_type, subject_id, subject_label, action, title, body,
        source_module, actor_id, actor_type, ref_type, ref_id, visibility, visibility_rank,
        importance, watchers, meta, occurred_at, tenant_id, dedupe_key)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      code,
      event.kind,
      event.subject_type,
      event.subject_id,
      event.subject_label,
      event.action,
      event.title,
      event.body,
      event.source_module,
      event.actor_id,
      event.actor_type,
      event.ref_type,
      event.ref_id,
      event.visibility,
      visibilityRank(event.visibility),
      event.importance,
      event.watchers.length ? JSON.stringify(event.watchers) : null,
      event.meta ? JSON.stringify(event.meta) : null,
      event.occurred_at,
      tenantId,
      dedupeKey,
    ],
  )
}

/**
 * Fire-and-forget variant for module hooks: records the activity but swallows
 * (and logs) any failure so a timeline problem never rolls back the caller's
 * real write. Mirrors the pattern in lib/sales/lead-lifecycle.ts.
 */
export async function recordActivitySafe(
  input: ActivityEventInput,
  opts: { dedupeKey?: string | null } = {},
): Promise<RecordedActivity | null> {
  try {
    return await recordActivity(input, opts)
  } catch (err) {
    console.error("[activity] record failed", err)
    return null
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export type TimelineFilters = {
  subjectType?: string | null
  subjectId?: string | number | null
  kinds?: Array<ActivityKind | string> | null
  actorId?: number | null
  sourceModule?: string | null
  from?: string | Date | null
  to?: string | Date | null
  cursor?: string | null
  limit?: number | null
}

export type TimelinePage = {
  events: ActivityEvent[]
  nextCursor: string | null
}

function rowToEvent(row: any): ActivityEvent {
  return {
    id: Number(row.id),
    activity_code: row.activity_code ?? undefined,
    kind: row.kind,
    subject_type: row.subject_type,
    subject_id: String(row.subject_id),
    subject_label: row.subject_label ?? null,
    action: row.action ?? null,
    title: row.title,
    body: row.body ?? null,
    source_module: row.source_module ?? null,
    actor_id: row.actor_id == null ? null : Number(row.actor_id),
    actor_type: row.actor_type ?? "user",
    ref_type: row.ref_type ?? null,
    ref_id: row.ref_id == null ? null : String(row.ref_id),
    occurred_at: typeof row.occurred_at === "string" ? row.occurred_at : toIso(row.occurred_at),
    visibility: row.visibility ?? "timeline",
    importance: Number(row.importance ?? 0),
    watchers: parseJsonArray(row.watchers),
    meta: parseJsonObject(row.meta),
  }
}

function toIso(value: any): string {
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 23).replace("T", " ")
}
function parseJsonArray(value: any): number[] {
  if (value == null) return []
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value
    return Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n)) : []
  } catch {
    return []
  }
}
function parseJsonObject(value: any): Record<string, any> | null {
  if (value == null) return null
  try {
    const v = typeof value === "string" ? JSON.parse(value) : value
    return v && typeof v === "object" && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/**
 * Read a subject's (or the whole tenant's) timeline, newest-first, using keyset
 * pagination on the (occurred_at, id) index — no OFFSET, so page cost stays
 * flat no matter how deep the caller scrolls. The `viewer` scopes the read:
 *
 *   - restricted kinds the viewer can't read are excluded at the DB with a
 *     cheap `kind IN (...)` pre-filter (allowedKindsFor);
 *   - visibility above the viewer's ceiling is excluded via `visibility_rank`;
 *   - the pure `canViewActivity` predicate is then applied as the authoritative
 *     final filter (private-watcher checks, defense in depth).
 *
 * The pure `canViewActivity` runs as the authoritative final filter.
 */
export async function getTimeline(filters: TimelineFilters, viewer: ActivityViewer): Promise<TimelinePage> {
  await ensureActivityTables()
  const tenantId = currentTenantId()
  const limit = clampLimit(filters.limit)

  const allowedKinds = allowedKindsFor(viewer)
  if (allowedKinds.length === 0) return { events: [], nextCursor: null }

  const clauses = ["tenant_id = ?"]
  const args: any[] = [tenantId]

  // Restrict to the intersection of the viewer's allowed kinds and any explicit
  // kind filter the caller asked for.
  let kinds = allowedKinds as string[]
  if (Array.isArray(filters.kinds) && filters.kinds.length > 0) {
    const requested = filters.kinds.filter(isActivityKind)
    kinds = kinds.filter((k) => requested.includes(k as ActivityKind))
    if (kinds.length === 0) return { events: [], nextCursor: null }
  }
  clauses.push(`kind IN (${kinds.map(() => "?").join(",")})`)
  args.push(...kinds)

  // Visibility ceiling — BUT the viewer may always see their own "private"
  // events (as actor or a named watcher), which sit above the ceiling.
  clauses.push(
    "(visibility_rank <= ? OR actor_id = ? OR (watchers IS NOT NULL AND JSON_CONTAINS(watchers, ?)))",
  )
  args.push(maxVisibilityRankFor(viewer), viewer.userId, String(viewer.userId))

  if (filters.subjectType) {
    clauses.push("subject_type = ?")
    args.push(String(filters.subjectType))
  }
  if (filters.subjectId != null && String(filters.subjectId).trim() !== "") {
    clauses.push("subject_id = ?")
    args.push(String(filters.subjectId))
  }
  if (filters.actorId != null) {
    clauses.push("actor_id = ?")
    args.push(Number(filters.actorId))
  }
  if (filters.sourceModule) {
    clauses.push("source_module = ?")
    args.push(String(filters.sourceModule))
  }
  if (filters.from) {
    clauses.push("occurred_at >= ?")
    args.push(toDbTime(filters.from))
  }
  if (filters.to) {
    clauses.push("occurred_at <= ?")
    args.push(toDbTime(filters.to))
  }

  // Keyset pagination on the (occurred_at, id) index — no OFFSET scan.
  const cursor = decodeCursor(filters.cursor)
  if (cursor) {
    clauses.push("(occurred_at < ? OR (occurred_at = ? AND id < ?))")
    args.push(cursor.occurredAt, cursor.occurredAt, cursor.id)
  }

  const rows = await query<any[]>(
    `SELECT * FROM activity_events
      WHERE ${clauses.join(" AND ")}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?`,
    [...args, limit + 1],
  )

  // Authoritative final filter (defense in depth). Given the DB predicates
  // above, every returned row already passes, so this never shortens the page.
  const visible = rows.map(rowToEvent).filter((e) => canViewActivity(e, viewer))
  const hasMore = visible.length > limit
  const events = visible.slice(0, limit)
  const last = events[events.length - 1]
  const nextCursor =
    hasMore && last ? encodeCursor({ occurredAt: last.occurred_at, id: last.id ?? 0 }) : null
  return { events, nextCursor }
}

/** Count activities per kind for a subject (for timeline filter chips). */
export async function countTimelineByKind(
  filters: Pick<TimelineFilters, "subjectType" | "subjectId">,
  viewer: ActivityViewer,
): Promise<Record<string, number>> {
  await ensureActivityTables()
  const tenantId = currentTenantId()
  const allowed = allowedKindsFor(viewer)
  if (allowed.length === 0) return {}
  const clauses = ["tenant_id = ?", `kind IN (${allowed.map(() => "?").join(",")})`, "visibility_rank <= ?"]
  const args: any[] = [tenantId, ...allowed, maxVisibilityRankFor(viewer)]
  if (filters.subjectType) {
    clauses.push("subject_type = ?")
    args.push(String(filters.subjectType))
  }
  if (filters.subjectId != null && String(filters.subjectId).trim() !== "") {
    clauses.push("subject_id = ?")
    args.push(String(filters.subjectId))
  }
  const rows = await query<any[]>(
    `SELECT kind, COUNT(*) AS n FROM activity_events WHERE ${clauses.join(" AND ")} GROUP BY kind`,
    args,
  )
  const out: Record<string, number> = {}
  for (const r of rows) out[String(r.kind)] = Number(r.n)
  return out
}

function toDbTime(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(String(value))
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString().slice(0, 23).replace("T", " ")
}

export { pool }

import "server-only"
/**
 * SPEC 103 — Duplicate Detection: server integration (Phase 3).
 * ---------------------------------------------------------------------------
 * The DB-facing layer that turns the pure matching engine (model.ts) into a
 * usable feature: it detects duplicates for a record, records them for review,
 * lists what's pending, and logs a completed merge. The framework never has to
 * know about any specific module's tables — the caller supplies the candidate
 * rows (already tenant-scoped) it wants checked.
 */
import { query } from "@/lib/db"
import { ensureDuplicateSchema } from "./schema"
import {
  findDuplicateMatches,
  getEntityConfig,
  planMerge,
  type CandidateWithId,
  type DuplicateEntity,
  type DuplicateMatch,
  type EntityMatchConfig,
  type FindMatchesOptions,
  type MergePlan,
  type MergeStrategy,
  type RecordData,
} from "./model"

export type ReviewStatus = "pending" | "dismissed" | "merged"

/**
 * Detect duplicates of `target` among caller-supplied `candidates`. Pure scoring
 * under the hood; this wrapper simply lets a route pass its already-fetched,
 * tenant-scoped rows and pick a config override.
 */
export function detectDuplicates<T extends CandidateWithId>(
  entity: DuplicateEntity,
  target: RecordData,
  candidates: readonly T[],
  options: FindMatchesOptions & { config?: EntityMatchConfig } = {},
): DuplicateMatch<T>[] {
  const { config, ...findOpts } = options
  return findDuplicateMatches(config ?? getEntityConfig(entity), target, candidates, findOpts)
}

/**
 * Persist detected matches for a record as pending review rows. Idempotent per
 * pair (UNIQUE key) — re-detecting refreshes the score/classification instead of
 * creating duplicates of duplicates. Pairs are stored order-independently
 * (smaller id first) so A↔B and B↔A collapse to one row.
 */
export async function recordCandidates(params: {
  tenantId: number
  entity: DuplicateEntity
  recordId: string | number
  matches: DuplicateMatch[]
}): Promise<number> {
  await ensureDuplicateSchema()
  const { tenantId, entity, recordId, matches } = params
  let written = 0
  for (const match of matches) {
    const [primaryId, duplicateId] = orderPair(recordId, match.candidate.id)
    await query(
      `INSERT INTO dup_candidates
         (tenant_id, entity_type, primary_id, duplicate_id, score, classification, matched_fields_json, hard_match, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         score = VALUES(score),
         classification = VALUES(classification),
         matched_fields_json = VALUES(matched_fields_json),
         hard_match = VALUES(hard_match),
         status = IF(status = 'merged', status, 'pending')`,
      [
        tenantId,
        entity,
        String(primaryId),
        String(duplicateId),
        match.score,
        match.classification,
        JSON.stringify(match.matchedFields),
        match.hardMatch ? 1 : 0,
      ],
    )
    written++
  }
  return written
}

export type PendingCandidateRow = {
  id: number
  entityType: string
  primaryId: string
  duplicateId: string
  score: number
  classification: string
  matchedFields: string[]
  hardMatch: boolean
  status: ReviewStatus
}

/** List pending (or any status) candidate pairs for an entity, strongest first. */
export async function listCandidates(params: {
  tenantId: number
  entity: DuplicateEntity
  status?: ReviewStatus
  limit?: number
}): Promise<PendingCandidateRow[]> {
  await ensureDuplicateSchema()
  const { tenantId, entity, status = "pending", limit = 100 } = params
  const rows = (await query<any[]>(
    `SELECT id, entity_type, primary_id, duplicate_id, score, classification, matched_fields_json, hard_match, status
       FROM dup_candidates
      WHERE tenant_id = ? AND entity_type = ? AND status = ?
      ORDER BY score DESC, id DESC
      LIMIT ?`,
    [tenantId, entity, status, limit],
  )) as any[]
  return rows.map(mapCandidateRow)
}

/** Mark a candidate pair dismissed ("not a duplicate") — leaves both records. */
export async function dismissCandidate(params: {
  tenantId: number
  candidateId: number
  reviewedBy?: number | null
}): Promise<boolean> {
  await ensureDuplicateSchema()
  const { tenantId, candidateId, reviewedBy = null } = params
  const res = (await query(
    `UPDATE dup_candidates
        SET status = 'dismissed', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ? AND id = ? AND status = 'pending'`,
    [reviewedBy, tenantId, candidateId],
  )) as { affectedRows?: number }
  return Number(res?.affectedRows ?? 0) > 0
}

/**
 * Log a completed merge and close the pair. Applying the merge to the module's
 * own records (repoint FKs, delete the merged row) is the caller's job and MUST
 * run in the same transaction; this records the audit trail + review outcome.
 */
export async function logMerge(params: {
  tenantId: number
  entity: DuplicateEntity
  survivingId: string | number
  mergedId: string | number
  plan: MergePlan
  mergedBy?: number | null
}): Promise<void> {
  await ensureDuplicateSchema()
  const { tenantId, entity, survivingId, mergedId, plan, mergedBy = null } = params
  await query(
    `INSERT INTO dup_merge_log
       (tenant_id, entity_type, surviving_id, merged_id, plan_json, conflicts_json, merged_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      entity,
      String(survivingId),
      String(mergedId),
      JSON.stringify(plan.fields),
      JSON.stringify(plan.conflicts),
      mergedBy,
    ],
  )
  const [primaryId, duplicateId] = orderPair(survivingId, mergedId)
  await query(
    `UPDATE dup_candidates
        SET status = 'merged', reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP
      WHERE tenant_id = ? AND entity_type = ? AND primary_id = ? AND duplicate_id = ?`,
    [mergedBy, tenantId, entity, String(primaryId), String(duplicateId)],
  )
}

/** Convenience: build the merge plan the reviewer will confirm. */
export function buildMergePlan(
  survivor: RecordData,
  merged: RecordData,
  options: { fields?: string[]; strategy?: MergeStrategy; overrides?: Record<string, "primary" | "secondary"> } = {},
): MergePlan {
  return planMerge(survivor, merged, options)
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Deterministic pair ordering so A↔B and B↔A resolve to the same row. */
function orderPair(a: string | number, b: string | number): [string, string] {
  const sa = String(a)
  const sb = String(b)
  return sa <= sb ? [sa, sb] : [sb, sa]
}

function mapCandidateRow(row: any): PendingCandidateRow {
  return {
    id: Number(row.id),
    entityType: String(row.entity_type),
    primaryId: String(row.primary_id),
    duplicateId: String(row.duplicate_id),
    score: Number(row.score),
    classification: String(row.classification),
    matchedFields: parseJson(row.matched_fields_json, []),
    hardMatch: Number(row.hard_match) === 1,
    status: String(row.status) as ReviewStatus,
  }
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === "object") return value as T
  try {
    return JSON.parse(String(value)) as T
  } catch {
    return fallback
  }
}

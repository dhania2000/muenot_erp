import "server-only"
/**
 * SPEC 40 — Unified identity registry: server store.
 * ---------------------------------------------------------------------------
 * The only module that touches the DB for the identity graph. Two tables:
 *
 *   - `identity_map`      one row per (module, source id) reference, pointing at
 *                         a canonical identity key; this is the cross-module
 *                         join by stable id.
 *   - `identity_merge_log` append-only merge history (survivor, merged-away,
 *                         collisions acknowledged, actor, idempotency key).
 *
 * Every statement binds tenant_id (tenant separation), merges are authority-
 * gated (critical master change), collisions are surfaced from the pure model
 * and must be acknowledged, and merges are idempotent on a per-tenant key so a
 * retry never double-applies.
 */
import { query, tableColumns, withTransaction } from "@/lib/db"
import {
  canonicalKey,
  detectMergeCollisions,
  evaluateMergeAuthority,
  isAllowedSourceModule,
  isIdentityKind,
  validateMerge,
  type IdentityAttributes,
  type IdentityKind,
  type MergeCollision,
} from "./model"

const MAP_TABLE = "identity_map"
const LOG_TABLE = "identity_merge_log"

export class IdentityRegistryError extends Error {
  constructor(
    message: string,
    readonly code: "setup_required" | "invalid" | "forbidden" | "conflict" | "not_found",
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = "IdentityRegistryError"
  }
}

async function assertSchema(): Promise<void> {
  const map = await tableColumns(MAP_TABLE)
  const log = await tableColumns(LOG_TABLE)
  const needMap = ["tenant_id", "identity_kind", "canonical_key", "source_module", "source_id", "status"]
  const needLog = ["tenant_id", "identity_kind", "survivor_key", "merged_key", "idempotency_key"]
  if (needMap.some((c) => !map.has(c)) || needLog.some((c) => !log.has(c))) {
    throw new IdentityRegistryError("Identity registry is not set up. Run the SPEC 40 migration.", "setup_required", 503)
  }
}

export type IdentityMapEntry = {
  kind: IdentityKind
  canonicalKey: string
  sourceModule: string
  sourceId: number
  externalRef: string | null
  status: "active" | "merged"
}

/**
 * Map a module's reference onto a canonical identity (idempotent upsert). Rejects
 * a cross-kind reference (e.g. a party pointing at an HR row) so the graph can
 * never link two different kinds.
 */
export async function mapIdentity(
  tenantId: number,
  input: { kind: IdentityKind; canonicalId: number; sourceModule: string; sourceId: number; externalRef?: string | null },
): Promise<IdentityMapEntry> {
  await assertSchema()
  if (!isIdentityKind(input.kind)) throw new IdentityRegistryError("Unknown identity kind.", "invalid", 400)
  if (!isAllowedSourceModule(input.kind, input.sourceModule)) {
    throw new IdentityRegistryError(
      `Module "${input.sourceModule}" cannot reference a ${input.kind} identity.`,
      "invalid",
      400,
    )
  }
  if (!Number.isSafeInteger(input.canonicalId) || input.canonicalId <= 0 || !Number.isSafeInteger(input.sourceId) || input.sourceId <= 0) {
    throw new IdentityRegistryError("Invalid identity or source id.", "invalid", 400)
  }
  const key = canonicalKey(input.kind, input.canonicalId)

  await query(
    `INSERT INTO \`${MAP_TABLE}\` (tenant_id, identity_kind, canonical_key, source_module, source_id, external_ref, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
     ON DUPLICATE KEY UPDATE canonical_key = VALUES(canonical_key), external_ref = VALUES(external_ref)`,
    [tenantId, input.kind, key, input.sourceModule, input.sourceId, input.externalRef ?? null],
  )

  return {
    kind: input.kind,
    canonicalKey: key,
    sourceModule: input.sourceModule,
    sourceId: input.sourceId,
    externalRef: input.externalRef ?? null,
    status: "active",
  }
}

/** All module references linked to a canonical identity (the 360 cross-module set). */
export async function getIdentityLinks(
  tenantId: number,
  kind: IdentityKind,
  canonicalId: number,
): Promise<IdentityMapEntry[]> {
  await assertSchema()
  if (!isIdentityKind(kind)) throw new IdentityRegistryError("Unknown identity kind.", "invalid", 400)
  const key = canonicalKey(kind, canonicalId)
  const rows = (await query<any[]>(
    `SELECT identity_kind, canonical_key, source_module, source_id, external_ref, status
       FROM \`${MAP_TABLE}\` WHERE tenant_id = ? AND identity_kind = ? AND canonical_key = ?
      ORDER BY source_module, source_id`,
    [tenantId, kind, key],
  )) as any[]
  return rows.map((r) => ({
    kind: r.identity_kind,
    canonicalKey: r.canonical_key,
    sourceModule: r.source_module,
    sourceId: Number(r.source_id),
    externalRef: r.external_ref ?? null,
    status: r.status,
  }))
}

async function isMergedAway(tenantId: number, key: string): Promise<boolean> {
  const rows = (await query<any[]>(
    `SELECT 1 FROM \`${LOG_TABLE}\` WHERE tenant_id = ? AND merged_key = ? LIMIT 1`,
    [tenantId, key],
  )) as any[]
  return rows.length > 0
}

export type MergeInput = {
  kind: IdentityKind
  survivorId: number
  mergedId: number
  survivorAttrs?: IdentityAttributes
  mergedAttrs?: IdentityAttributes
  /** The caller must acknowledge known collisions to proceed. */
  acknowledgeCollisions?: boolean
  /** Per-tenant idempotency key so a retried merge is a no-op. */
  idempotencyKey: string
}

export type MergeResult = {
  survivorKey: string
  mergedKey: string
  collisions: MergeCollision[]
  relinked: number
  reused: boolean
}

/**
 * Merge `mergedId` into `survivorId`: re-points every module reference to the
 * survivor's canonical key and writes an append-only merge-history row. Enforces
 * authority, structural legality (validateMerge), and collision acknowledgement.
 * Idempotent: a repeat with the same idempotency key returns the prior result.
 */
export async function mergeIdentities(
  tenantId: number,
  input: MergeInput,
  actor: { userId: number; isAdmin: boolean; hasGovernanceGrant: boolean },
): Promise<MergeResult> {
  await assertSchema()
  if (!isIdentityKind(input.kind)) throw new IdentityRegistryError("Unknown identity kind.", "invalid", 400)

  const auth = evaluateMergeAuthority({ actorIsAdmin: actor.isAdmin, actorHasGovernanceGrant: actor.hasGovernanceGrant })
  if (!auth.ok) throw new IdentityRegistryError(auth.error, "forbidden", 403)

  if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
    throw new IdentityRegistryError("A valid idempotency key is required.", "invalid", 400)
  }

  const survivorKey = canonicalKey(input.kind, input.survivorId)
  const mergedKey = canonicalKey(input.kind, input.mergedId)

  // Idempotency: replay a completed merge with the same key.
  const prior = (await query<any[]>(
    `SELECT survivor_key, merged_key, collisions FROM \`${LOG_TABLE}\`
      WHERE tenant_id = ? AND idempotency_key = ? LIMIT 1`,
    [tenantId, input.idempotencyKey],
  )) as any[]
  if (prior[0]) {
    if (prior[0].survivor_key !== survivorKey || prior[0].merged_key !== mergedKey) {
      throw new IdentityRegistryError("Idempotency key already used for a different merge.", "conflict", 409)
    }
    let collisions: MergeCollision[] = []
    try {
      collisions = prior[0].collisions ? (typeof prior[0].collisions === "string" ? JSON.parse(prior[0].collisions) : prior[0].collisions) : []
    } catch {
      collisions = []
    }
    return { survivorKey, mergedKey, collisions, relinked: 0, reused: true }
  }

  const legal = validateMerge({
    kind: input.kind,
    survivorId: input.survivorId,
    mergedId: input.mergedId,
    survivorKind: input.kind,
    mergedKind: input.kind,
    mergedAlreadyMerged: await isMergedAway(tenantId, mergedKey),
    survivorIsTombstone: await isMergedAway(tenantId, survivorKey),
  })
  if (!legal.ok) throw new IdentityRegistryError(legal.error, "invalid", 400)

  const collisions = detectMergeCollisions(input.survivorAttrs ?? {}, input.mergedAttrs ?? {})
  if (collisions.length > 0 && !input.acknowledgeCollisions) {
    throw new IdentityRegistryError(
      "Merge blocked: the identities disagree on stable attributes. Review and acknowledge to proceed.",
      "conflict",
      409,
      { collisions },
    )
  }

  const relinked = await withTransaction(async (conn) => {
    // Re-point every reference from the merged identity to the survivor.
    const [res] = (await conn.query(
      `UPDATE \`${MAP_TABLE}\` SET canonical_key = ?, status = 'active'
         WHERE tenant_id = ? AND identity_kind = ? AND canonical_key = ?`,
      [survivorKey, tenantId, input.kind, mergedKey],
    )) as any

    // Insert the append-only history row. The unique (tenant, idempotency_key)
    // makes a concurrent duplicate fail closed rather than double-merge.
    await conn.query(
      `INSERT INTO \`${LOG_TABLE}\`
         (tenant_id, identity_kind, survivor_key, merged_key, collisions, acknowledged, actor_user_id, idempotency_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        tenantId,
        input.kind,
        survivorKey,
        mergedKey,
        collisions.length ? JSON.stringify(collisions) : null,
        collisions.length ? 1 : 0,
        actor.userId,
        input.idempotencyKey,
      ],
    )
    return Number(res?.affectedRows ?? 0)
  })

  return { survivorKey, mergedKey, collisions, relinked, reused: false }
}

export type MergeHistoryEntry = {
  id: number
  kind: IdentityKind
  survivorKey: string
  mergedKey: string
  collisions: MergeCollision[]
  actorUserId: number | null
  createdAt: string
}

/** Merge history for a tenant (append-only, newest first), optionally filtered. */
export async function listMergeHistory(
  tenantId: number,
  opts: { kind?: IdentityKind; canonicalId?: number } = {},
): Promise<MergeHistoryEntry[]> {
  await assertSchema()
  const where = ["tenant_id = ?"]
  const args: unknown[] = [tenantId]
  if (opts.kind && isIdentityKind(opts.kind)) {
    where.push("identity_kind = ?")
    args.push(opts.kind)
  }
  if (opts.kind && opts.canonicalId != null) {
    const key = canonicalKey(opts.kind, opts.canonicalId)
    where.push("(survivor_key = ? OR merged_key = ?)")
    args.push(key, key)
  }
  const rows = (await query<any[]>(
    `SELECT id, identity_kind, survivor_key, merged_key, collisions, actor_user_id, created_at
       FROM \`${LOG_TABLE}\` WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id DESC LIMIT 500`,
    args,
  )) as any[]
  return rows.map((r) => {
    let collisions: MergeCollision[] = []
    try {
      collisions = r.collisions ? (typeof r.collisions === "string" ? JSON.parse(r.collisions) : r.collisions) : []
    } catch {
      collisions = []
    }
    return {
      id: Number(r.id),
      kind: r.identity_kind,
      survivorKey: r.survivor_key,
      mergedKey: r.merged_key,
      collisions,
      actorUserId: r.actor_user_id == null ? null : Number(r.actor_user_id),
      createdAt: r.created_at,
    }
  })
}

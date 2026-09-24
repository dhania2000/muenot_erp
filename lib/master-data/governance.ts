import "server-only"
/**
 * SPEC 91 — Master Data Governance service (Phase 2 & 3).
 * ---------------------------------------------------------------------------
 * The maker/checker workflow around critical SPEC 90 masters. A change is never
 * applied directly: a maker submits a change request, an approver with the
 * right authority reviews it, and only on approval is the underlying canonical
 * value written (via the SPEC 90 service). Every step is recorded in an
 * append-only history so the full lifecycle is auditable.
 *
 * All routing decisions (is this kind governed? is this transition legal? may
 * this person approve?) live in the pure governance-model.ts, which is unit
 * tested without a database.
 */
import { query, withTransaction } from "@/lib/db"
import { ensureGovernanceSchema } from "./governance-schema"
import { upsertMaster, deactivateMaster, getMaster } from "./service"
import {
  isGovernedKind,
  resolvedStatusForAction,
  validateActionForStatus,
  evaluateApprovalAuthority,
  isEffectiveNow,
  type GovStatus,
  type GovAction,
} from "./governance-model"
import type { MasterKind } from "./types"

export type GovRecord = {
  id: number
  kind: MasterKind
  code: string
  status: GovStatus
  ownerId: number | null
  approvalAuthority: string | null
  effectiveDate: string | null
  version: number
  updatedBy: number | null
  createdAt: string
  updatedAt: string
}

export type ChangeRequest = {
  id: number
  kind: MasterKind
  code: string
  action: GovAction
  payload: Record<string, unknown> | null
  effectiveDate: string | null
  status: "pending" | "approved" | "rejected" | "cancelled"
  requestedBy: number | null
  requestComment: string | null
  reviewedBy: number | null
  reviewComment: string | null
  reviewedAt: string | null
  createdAt: string
  updatedAt: string
}

export type HistoryEntry = {
  id: number
  kind: MasterKind
  code: string
  event: string
  fromStatus: GovStatus | null
  toStatus: GovStatus | null
  actorId: number | null
  changeRequestId: number | null
  detail: Record<string, unknown> | null
  createdAt: string
}

function assertGoverned(kind: MasterKind) {
  if (!isGovernedKind(kind)) {
    throw new Error(`Master "${kind}" is not under governance. Only critical masters are governed.`)
  }
}

function mapRecord(r: any): GovRecord {
  return {
    id: Number(r.id),
    kind: r.master_kind,
    code: String(r.code),
    status: r.status,
    ownerId: r.owner_id == null ? null : Number(r.owner_id),
    approvalAuthority: r.approval_authority ?? null,
    effectiveDate: r.effective_date ?? null,
    version: Number(r.version),
    updatedBy: r.updated_by == null ? null : Number(r.updated_by),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapRequest(r: any): ChangeRequest {
  return {
    id: Number(r.id),
    kind: r.master_kind,
    code: String(r.code),
    action: r.action,
    payload: parseJson(r.payload),
    effectiveDate: r.effective_date ?? null,
    status: r.status,
    requestedBy: r.requested_by == null ? null : Number(r.requested_by),
    requestComment: r.request_comment ?? null,
    reviewedBy: r.reviewed_by == null ? null : Number(r.reviewed_by),
    reviewComment: r.review_comment ?? null,
    reviewedAt: r.reviewed_at ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function mapHistory(r: any): HistoryEntry {
  return {
    id: Number(r.id),
    kind: r.master_kind,
    code: String(r.code),
    event: r.event,
    fromStatus: r.from_status ?? null,
    toStatus: r.to_status ?? null,
    actorId: r.actor_id == null ? null : Number(r.actor_id),
    changeRequestId: r.change_request_id == null ? null : Number(r.change_request_id),
    detail: parseJson(r.detail),
    createdAt: r.created_at,
  }
}

function parseJson(v: unknown): Record<string, unknown> | null {
  if (v == null) return null
  if (typeof v === "object") return v as Record<string, unknown>
  try {
    return JSON.parse(String(v))
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** The governance record for a value, or null if it has never been governed. */
export async function getGovernance(
  tenantId: number,
  kind: MasterKind,
  code: string,
): Promise<GovRecord | null> {
  await ensureGovernanceSchema()
  const rows = (await query<any[]>(
    `SELECT * FROM md_gov_records WHERE tenant_id = ? AND master_kind = ? AND code = ? LIMIT 1`,
    [tenantId, kind, code],
  )) as any[]
  return rows[0] ? mapRecord(rows[0]) : null
}

/** All governance records for a tenant, newest first, optionally filtered. */
export async function listGovernance(
  tenantId: number,
  opts: { kind?: MasterKind; status?: GovStatus } = {},
): Promise<GovRecord[]> {
  await ensureGovernanceSchema()
  const where = ["tenant_id = ?"]
  const args: any[] = [tenantId]
  if (opts.kind) {
    where.push("master_kind = ?")
    args.push(opts.kind)
  }
  if (opts.status) {
    where.push("status = ?")
    args.push(opts.status)
  }
  const rows = (await query<any[]>(
    `SELECT * FROM md_gov_records WHERE ${where.join(" AND ")} ORDER BY updated_at DESC LIMIT 500`,
    args,
  )) as any[]
  return rows.map(mapRecord)
}

/** Change requests for a tenant, newest first. */
export async function listChangeRequests(
  tenantId: number,
  opts: { status?: ChangeRequest["status"]; kind?: MasterKind; code?: string } = {},
): Promise<ChangeRequest[]> {
  await ensureGovernanceSchema()
  const where = ["tenant_id = ?"]
  const args: any[] = [tenantId]
  if (opts.status) {
    where.push("status = ?")
    args.push(opts.status)
  }
  if (opts.kind) {
    where.push("master_kind = ?")
    args.push(opts.kind)
  }
  if (opts.code) {
    where.push("code = ?")
    args.push(opts.code)
  }
  const rows = (await query<any[]>(
    `SELECT * FROM md_gov_change_requests WHERE ${where.join(" AND ")} ORDER BY
       (status = 'pending') DESC, created_at DESC LIMIT 500`,
    args,
  )) as any[]
  return rows.map(mapRequest)
}

/** Change history for a single governed value (append-only, newest first). */
export async function getHistory(
  tenantId: number,
  kind: MasterKind,
  code: string,
): Promise<HistoryEntry[]> {
  await ensureGovernanceSchema()
  const rows = (await query<any[]>(
    `SELECT * FROM md_gov_history WHERE tenant_id = ? AND master_kind = ? AND code = ?
       ORDER BY created_at DESC, id DESC LIMIT 500`,
    [tenantId, kind, code],
  )) as any[]
  return rows.map(mapHistory)
}

// ---------------------------------------------------------------------------
// Ownership
// ---------------------------------------------------------------------------

/**
 * Assign or update the data owner and approval authority for a governed value,
 * creating a draft governance record if one does not exist yet.
 */
export async function setOwnership(
  tenantId: number,
  kind: MasterKind,
  code: string,
  input: { ownerId?: number | null; approvalAuthority?: string | null },
  actorId: number,
): Promise<GovRecord> {
  assertGoverned(kind)
  await ensureGovernanceSchema()
  const existing = await getGovernance(tenantId, kind, code)
  if (!existing) {
    await query(
      `INSERT INTO md_gov_records (tenant_id, master_kind, code, status, owner_id, approval_authority, updated_by)
       VALUES (?,?,?,?,?,?,?)`,
      [tenantId, kind, code, "draft", input.ownerId ?? null, input.approvalAuthority ?? null, actorId],
    )
    await writeHistory(tenantId, kind, code, {
      event: "ownership_set",
      toStatus: "draft",
      actorId,
      detail: { ownerId: input.ownerId ?? null, approvalAuthority: input.approvalAuthority ?? null },
    })
  } else {
    await query(
      `UPDATE md_gov_records SET owner_id = ?, approval_authority = ?, updated_by = ?
       WHERE tenant_id = ? AND master_kind = ? AND code = ?`,
      [
        input.ownerId !== undefined ? input.ownerId : existing.ownerId,
        input.approvalAuthority !== undefined ? input.approvalAuthority : existing.approvalAuthority,
        actorId,
        tenantId,
        kind,
        code,
      ],
    )
    await writeHistory(tenantId, kind, code, {
      event: "ownership_changed",
      fromStatus: existing.status,
      toStatus: existing.status,
      actorId,
      detail: { ownerId: input.ownerId, approvalAuthority: input.approvalAuthority },
    })
  }
  return (await getGovernance(tenantId, kind, code))!
}

// ---------------------------------------------------------------------------
// Workflow — submit
// ---------------------------------------------------------------------------

export type SubmitInput = {
  kind: MasterKind
  code: string
  action: GovAction
  /** Desired value for create/update/reactivate (code, name, active, parent, meta). */
  payload?: Record<string, unknown>
  effectiveDate?: string | null
  comment?: string | null
}

/**
 * Submit a change request against a governed value. Validates the action
 * against the current lifecycle status, moves the record into
 * `pending_approval`, and records the request + history. Does NOT touch the
 * underlying master — that only happens on approval.
 */
export async function submitChangeRequest(
  tenantId: number,
  input: SubmitInput,
  requesterId: number,
): Promise<ChangeRequest> {
  assertGoverned(input.kind)
  await ensureGovernanceSchema()

  const current = await getGovernance(tenantId, input.kind, input.code)
  const check = validateActionForStatus(input.action, current?.status ?? null)
  if (!check.ok) throw new Error(check.reason)

  if (current?.status === "pending_approval") {
    throw new Error("There is already a change awaiting approval for this value.")
  }

  return withTransaction(async (conn) => {
    const [res] = (await conn.query(
      `INSERT INTO md_gov_change_requests
         (tenant_id, master_kind, code, action, payload, effective_date, status, requested_by, request_comment)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        input.kind,
        input.code,
        input.action,
        input.payload ? JSON.stringify(input.payload) : null,
        input.effectiveDate ?? null,
        "pending",
        requesterId,
        input.comment ?? null,
      ],
    )) as any
    const crId = Number(res.insertId)

    // Upsert governance record into pending_approval.
    if (current) {
      await conn.query(
        `UPDATE md_gov_records SET status = 'pending_approval', updated_by = ? WHERE id = ?`,
        [requesterId, current.id],
      )
    } else {
      await conn.query(
        `INSERT INTO md_gov_records (tenant_id, master_kind, code, status, updated_by)
         VALUES (?,?,?,?,?)`,
        [tenantId, input.kind, input.code, "pending_approval", requesterId],
      )
    }

    await conn.query(
      `INSERT INTO md_gov_history
         (tenant_id, master_kind, code, event, from_status, to_status, actor_id, change_request_id, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        input.kind,
        input.code,
        "submitted",
        current?.status ?? null,
        "pending_approval",
        requesterId,
        crId,
        JSON.stringify({ action: input.action, effectiveDate: input.effectiveDate ?? null }),
      ],
    )

    const rows = (await conn.query(`SELECT * FROM md_gov_change_requests WHERE id = ?`, [crId])) as any
    return mapRequest(rows[0][0])
  })
}

// ---------------------------------------------------------------------------
// Workflow — review (approve / reject)
// ---------------------------------------------------------------------------

/**
 * Approve a pending change request: enforces segregation of duties, applies the
 * change to the underlying canonical master (SPEC 90 service), transitions the
 * governance record to the action's resolved status, and records history.
 */
export async function approveChangeRequest(
  tenantId: number,
  changeRequestId: number,
  approver: { userId: number; isAdmin: boolean; authorities?: string[] },
  comment?: string | null,
): Promise<{ request: ChangeRequest; record: GovRecord }> {
  await ensureGovernanceSchema()
  const cr = await getChangeRequest(tenantId, changeRequestId)
  if (!cr) throw new Error("Change request not found.")
  if (cr.status !== "pending") throw new Error(`Change request is already ${cr.status}.`)

  const record = await getGovernance(tenantId, cr.kind, cr.code)
  const authority = evaluateApprovalAuthority({
    requesterId: cr.requestedBy ?? -1,
    approverId: approver.userId,
    approverIsAdmin: approver.isAdmin,
    approverAuthorities: approver.authorities ?? [],
    requiredAuthority: record?.approvalAuthority ?? null,
  })
  if (!authority.ok) throw new Error(authority.reason)

  const targetStatus = resolvedStatusForAction(cr.action)
  const effectiveNow = isEffectiveNow(cr.effectiveDate)

  // Apply the change to the underlying canonical master. Effective-dated future
  // changes are recorded but not applied to the live value until due; we apply
  // immediately when effective now.
  if (effectiveNow) {
    await applyToMaster(tenantId, cr)
  }

  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE md_gov_change_requests
         SET status = 'approved', reviewed_by = ?, review_comment = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [approver.userId, comment ?? null, changeRequestId],
    )

    const nextStatus: GovStatus = effectiveNow ? targetStatus : "pending_approval"
    if (record) {
      await conn.query(
        `UPDATE md_gov_records
           SET status = ?, effective_date = ?, version = version + 1, updated_by = ?
         WHERE id = ?`,
        [nextStatus, cr.effectiveDate ?? null, approver.userId, record.id],
      )
    } else {
      await conn.query(
        `INSERT INTO md_gov_records (tenant_id, master_kind, code, status, effective_date, updated_by)
         VALUES (?,?,?,?,?,?)`,
        [tenantId, cr.kind, cr.code, nextStatus, cr.effectiveDate ?? null, approver.userId],
      )
    }

    await conn.query(
      `INSERT INTO md_gov_history
         (tenant_id, master_kind, code, event, from_status, to_status, actor_id, change_request_id, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        cr.kind,
        cr.code,
        "approved",
        record?.status ?? "pending_approval",
        nextStatus,
        approver.userId,
        changeRequestId,
        JSON.stringify({ action: cr.action, effectiveNow, effectiveDate: cr.effectiveDate ?? null }),
      ],
    )
  })

  return {
    request: (await getChangeRequest(tenantId, changeRequestId))!,
    record: (await getGovernance(tenantId, cr.kind, cr.code))!,
  }
}

/**
 * Reject a pending change request. Sends the governed value back to its prior
 * resting status (draft for a brand-new value, otherwise active/inactive), and
 * records history. The underlying master is never touched.
 */
export async function rejectChangeRequest(
  tenantId: number,
  changeRequestId: number,
  approver: { userId: number; isAdmin: boolean; authorities?: string[] },
  comment?: string | null,
): Promise<{ request: ChangeRequest; record: GovRecord | null }> {
  await ensureGovernanceSchema()
  const cr = await getChangeRequest(tenantId, changeRequestId)
  if (!cr) throw new Error("Change request not found.")
  if (cr.status !== "pending") throw new Error(`Change request is already ${cr.status}.`)

  const record = await getGovernance(tenantId, cr.kind, cr.code)
  const authority = evaluateApprovalAuthority({
    requesterId: cr.requestedBy ?? -1,
    approverId: approver.userId,
    approverIsAdmin: approver.isAdmin,
    approverAuthorities: approver.authorities ?? [],
    requiredAuthority: record?.approvalAuthority ?? null,
  })
  if (!authority.ok) throw new Error(authority.reason)

  // A rejected create has no prior live value → back to draft. Otherwise return
  // to the last stable status implied by whether the value is currently active.
  const backTo: GovStatus = cr.action === "create" ? "draft" : "active"

  await withTransaction(async (conn) => {
    await conn.query(
      `UPDATE md_gov_change_requests
         SET status = 'rejected', reviewed_by = ?, review_comment = ?, reviewed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [approver.userId, comment ?? null, changeRequestId],
    )
    if (record) {
      await conn.query(`UPDATE md_gov_records SET status = ?, updated_by = ? WHERE id = ?`, [
        backTo,
        approver.userId,
        record.id,
      ])
    }
    await conn.query(
      `INSERT INTO md_gov_history
         (tenant_id, master_kind, code, event, from_status, to_status, actor_id, change_request_id, detail)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        tenantId,
        cr.kind,
        cr.code,
        "rejected",
        record?.status ?? "pending_approval",
        record ? backTo : null,
        approver.userId,
        changeRequestId,
        JSON.stringify({ action: cr.action }),
      ],
    )
  })

  return {
    request: (await getChangeRequest(tenantId, changeRequestId))!,
    record: await getGovernance(tenantId, cr.kind, cr.code),
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function getChangeRequest(tenantId: number, id: number): Promise<ChangeRequest | null> {
  const rows = (await query<any[]>(
    `SELECT * FROM md_gov_change_requests WHERE tenant_id = ? AND id = ? LIMIT 1`,
    [tenantId, id],
  )) as any[]
  return rows[0] ? mapRequest(rows[0]) : null
}

/** Push an approved change into the canonical SPEC 90 master. */
async function applyToMaster(tenantId: number, cr: ChangeRequest): Promise<void> {
  const ctx = { tenantId, userId: cr.reviewedBy ?? cr.requestedBy ?? undefined }
  switch (cr.action) {
    case "create":
    case "update":
    case "reactivate": {
      const p = cr.payload ?? {}
      const name = String(p.name ?? "")
      await upsertMaster(
        cr.kind,
        {
          code: cr.code,
          name: name || (await fallbackName(cr, tenantId)),
          active: true,
          parent: (p.parent as string | null | undefined) ?? undefined,
          meta: (p.meta as Record<string, unknown> | undefined) ?? undefined,
        },
        ctx,
      )
      break
    }
    case "deactivate":
    case "archive": {
      await deactivateMaster(cr.kind, cr.code, ctx)
      break
    }
  }
}

/** When reactivating without a supplied name, keep the existing one. */
async function fallbackName(cr: ChangeRequest, tenantId: number): Promise<string> {
  const existing = await getMaster(cr.kind, cr.code, { tenantId })
  return existing?.name ?? cr.code
}

async function writeHistory(
  tenantId: number,
  kind: MasterKind,
  code: string,
  entry: {
    event: string
    fromStatus?: GovStatus | null
    toStatus?: GovStatus | null
    actorId: number | null
    changeRequestId?: number | null
    detail?: Record<string, unknown> | null
  },
): Promise<void> {
  await query(
    `INSERT INTO md_gov_history
       (tenant_id, master_kind, code, event, from_status, to_status, actor_id, change_request_id, detail)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      tenantId,
      kind,
      code,
      entry.event,
      entry.fromStatus ?? null,
      entry.toStatus ?? null,
      entry.actorId,
      entry.changeRequestId ?? null,
      entry.detail ? JSON.stringify(entry.detail) : null,
    ],
  )
}

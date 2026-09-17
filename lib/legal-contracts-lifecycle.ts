import "server-only"
import { query } from "@/lib/db"
import { ensureContractTables } from "@/lib/legal-contracts-db"
import { getGeneratedContract, generateContract, type GenerateResult } from "@/lib/legal-contracts-generate"
import { getContractTemplate } from "@/lib/legal-contracts-templates"
import { logContractEvent } from "@/lib/legal-contracts-audit"
import { hasUnresolvedTokens } from "@/lib/legal-contracts-render"
import { CONTRACT_STATUSES, type ContractStatus, type GeneratedContract } from "@/lib/legal-contracts-shared"

// ---------------------------------------------------------------------------
// Legal Contracts — generated-contract lifecycle actions (server-only).
//
// Status transitions, permitted content edits (template stays untouched —
// Phase 30/31), renewals that preserve the superseded contract (Phase 47/48),
// and the renewal chain used by the detail view. Every action is audited.
// ---------------------------------------------------------------------------

type Actor = { actorId?: number | null; actorName?: string | null }

type ActionResult<T = GeneratedContract> =
  | { ok: true; contract: T }
  | { ok: false; error: string; code: number }

/** Change a generated contract's status with a full audit entry. */
export async function setContractStatus(
  id: number,
  to: string,
  actor: Actor & { note?: string | null } = {},
): Promise<ActionResult> {
  await ensureContractTables()
  if (!(CONTRACT_STATUSES as readonly string[]).includes(to)) {
    return { ok: false, error: `Unknown status "${to}"`, code: 400 }
  }
  const existing = await getGeneratedContract(id)
  if (!existing) return { ok: false, error: "Contract not found", code: 404 }
  if (existing.status === to) return { ok: true, contract: existing }

  await query("UPDATE legal_generated_contracts SET status = ? WHERE id = ?", [to, id])
  const contract = await getGeneratedContract(id)
  if (!contract) return { ok: false, error: "Failed to reload contract", code: 500 }

  const type =
    to === "Terminated" ? "contract_terminated" : to === "Cancelled" ? "contract_cancelled" : "contract_status_changed"
  await logContractEvent({
    entity: "contract",
    entityId: id,
    entityRef: contract.reference_no || contract.contract_uid,
    type,
    summary: `Status ${existing.status} → ${to}`,
    detail: { from: existing.status, to, note: actor.note ?? null },
    actorId: actor.actorId ?? null,
    actorName: actor.actorName ?? null,
  })
  return { ok: true, contract }
}

/**
 * Edit a permitted generated contract in place (Phase 31). The source template
 * is never touched. The previous content is snapshotted into the audit detail
 * and the contract version is bumped so history stays intact.
 */
export async function updateGeneratedContract(
  id: number,
  input: {
    title?: string | null
    content?: string | null
    effectiveDate?: string | null
    startDate?: string | null
    endDate?: string | null
    renewalDate?: string | null
    partyName?: string | null
  },
  actor: Actor & { reason?: string | null } = {},
): Promise<ActionResult> {
  await ensureContractTables()
  const existing = await getGeneratedContract(id)
  if (!existing) return { ok: false, error: "Contract not found", code: 404 }
  if (["Signed", "Active", "Terminated", "Cancelled", "Expired"].includes(existing.status)) {
    return { ok: false, error: `A ${existing.status} contract can no longer be edited`, code: 409 }
  }

  const contentChanged = input.content != null && input.content !== existing.content
  const nextVersion = contentChanged ? existing.version + 1 : existing.version

  await query(
    `UPDATE legal_generated_contracts SET
        title = ?, content = ?, effective_date = ?, start_date = ?, end_date = ?, renewal_date = ?,
        party_name = ?, version = ?
      WHERE id = ?`,
    [
      input.title?.trim() || existing.title,
      input.content ?? existing.content,
      input.effectiveDate !== undefined ? input.effectiveDate || null : existing.effective_date,
      input.startDate !== undefined ? input.startDate || null : existing.start_date,
      input.endDate !== undefined ? input.endDate || null : existing.end_date,
      input.renewalDate !== undefined ? input.renewalDate || null : existing.renewal_date,
      input.partyName !== undefined ? input.partyName : existing.party_name,
      nextVersion,
      id,
    ],
  )
  const contract = await getGeneratedContract(id)
  if (!contract) return { ok: false, error: "Failed to reload contract", code: 500 }

  await logContractEvent({
    entity: "contract",
    entityId: id,
    entityRef: contract.reference_no || contract.contract_uid,
    type: "contract_edited",
    summary: contentChanged ? `Edited content → v${nextVersion}` : "Updated contract fields",
    detail: {
      reason: actor.reason ?? null,
      version: nextVersion,
      previousContent: contentChanged ? existing.content : undefined,
    },
    actorId: actor.actorId ?? null,
    actorName: actor.actorName ?? null,
  })
  return { ok: true, contract }
}

/**
 * Create a renewal of an existing contract (Phase 47/48). The new contract is
 * generated from the same template/source with fresh dates; the old contract
 * is preserved and marked Expired + superseded_by the renewal.
 */
export async function renewContract(
  id: number,
  input: { startDate?: string | null; endDate?: string | null; renewalDate?: string | null; effectiveDate?: string | null },
  actor: Actor = {},
): Promise<GenerateResult> {
  await ensureContractTables()
  const existing = await getGeneratedContract(id)
  if (!existing) return { ok: false, error: "Contract not found", code: 404 }

  const template = existing.template_id ? await getContractTemplate(existing.template_id) : null

  const result = await generateContract({
    templateId: existing.template_id,
    title: `${existing.title} (Renewal)`,
    contractType: existing.contract_type,
    category: existing.category,
    source: existing.source,
    sourceRef: existing.source_ref,
    // If the template is gone/archived, fall back to the prior rendered content.
    contentOverride: template ? null : existing.content,
    effectiveDate: input.effectiveDate ?? input.startDate ?? null,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    renewalDate: input.renewalDate ?? null,
    manualVars: existing.variables_snapshot ?? {},
    status: "Generated",
    allowMissing: true,
    supersedesId: id,
    supersedeStatus: "Expired",
    auditType: "contract_renewed",
    actorId: actor.actorId ?? null,
    actorName: actor.actorName ?? null,
  })

  if (result.ok) {
    await logContractEvent({
      entity: "contract",
      entityId: id,
      entityRef: existing.reference_no || existing.contract_uid,
      type: "contract_renewed",
      summary: `Renewed as ${result.contract.reference_no || result.contract.contract_uid}`,
      detail: { newContractId: result.contract.id, newVersion: result.contract.version },
      actorId: actor.actorId ?? null,
      actorName: actor.actorName ?? null,
    })
  }
  return result
}

/** The full renewal chain (oldest → newest) a contract belongs to. */
export async function getContractChain(id: number): Promise<GeneratedContract[]> {
  await ensureContractTables()
  const chain: GeneratedContract[] = []
  const seen = new Set<number>()

  // Walk backwards to the root.
  let rootId = id
  for (let i = 0; i < 50; i++) {
    const rows = await query<any[]>("SELECT supersedes_id FROM legal_generated_contracts WHERE id = ?", [rootId])
    const prev = rows[0]?.supersedes_id
    if (!prev || seen.has(Number(prev))) break
    seen.add(Number(prev))
    rootId = Number(prev)
  }

  // Walk forward collecting each contract in order.
  let cursor: number | null = rootId
  seen.clear()
  for (let i = 0; i < 50 && cursor && !seen.has(cursor); i++) {
    seen.add(cursor)
    const c = await getGeneratedContract(cursor)
    if (!c) break
    chain.push(c)
    cursor = c.superseded_by ? Number(c.superseded_by) : null
  }
  return chain
}

/** Guard used before marking a contract Approved/Sent (Phase 83). */
export function contentHasUnresolved(contract: GeneratedContract): boolean {
  return hasUnresolvedTokens(contract.content)
}

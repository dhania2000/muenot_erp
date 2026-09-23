import "server-only"
/**
 * SPEC 87 — bridge between the Document Management System and the configurable
 * Approval Authority engine (lib/approval-authority.ts).
 *
 * Documents never approve themselves. When a document is submitted for
 * approval it is routed through the SAME rule / level / delegation / escalation
 * machinery every other high-risk operation uses — keyed by the document's
 * workflow type (SOP, policy, contract, …), each of which maps to an approval
 * `moduleKey`. Approvers act from the Approvals inbox or the Document Approval
 * console; the outcome is synced back onto the document lifecycle here.
 *
 * Segregation of duties, multi-level chains, quorum, delegation and escalation
 * are all owned by the engine — this module only translates between a document
 * and an approval request, and fans out targeted notifications.
 */
import { query } from "@/lib/db"
import { requireCurrentTenantId } from "@/lib/tenant-context"
import {
  raiseApprovalRequest,
  getRequestDetail,
  type ApprovalStepRecord,
} from "@/lib/approval-authority"
import { ensureNotificationsSchema } from "@/lib/notifications"
import {
  formatDocRef,
  mapApprovalToDocStatus,
  workflowLabel,
  workflowModuleKey,
  type DocWorkflowType,
  type EngineStatus,
} from "./model"
import {
  getDocument,
  getDocumentByApprovalRequest,
  setDocumentWorkflow,
} from "./store"

export type ApprovalActor = { userId: number; name?: string | null; role?: string | null }

export type SubmitDocumentResult = {
  ok: true
  requestId: number
  autoApproved: boolean
  status: EngineStatus
}

/**
 * Route a document into the approval engine under its workflow type. Persists
 * the workflow linkage on the document and moves it to `submitted` (or straight
 * to `approved` when no rule is configured, i.e. the engine auto-approves).
 */
export async function submitDocumentForApproval(input: {
  documentId: number
  workflowType: DocWorkflowType
  actor: ApprovalActor
}): Promise<SubmitDocumentResult> {
  const doc = await getDocument(input.documentId)
  if (!doc) throw new Error("Document not found")

  const raise = await raiseApprovalRequest({
    moduleKey: workflowModuleKey(input.workflowType),
    entityType: "dms_document",
    entityPk: doc.id,
    entityRef: formatDocRef(doc.id),
    title: `${workflowLabel(input.workflowType)}: ${doc.title}`,
    requesterRole: input.actor.role ?? null,
    requestedBy: input.actor.userId,
    requestedByName: input.actor.name ?? null,
  })

  if (raise.autoApproved) {
    await setDocumentWorkflow(doc.id, {
      workflowType: input.workflowType,
      approvalRequestId: raise.requestId,
      approvalStatus: "approved",
      status: "approved",
      approvedBy: null,
      approvedAt: new Date(),
    })
    // No configured authority — let the owner know it went straight through.
    await notifyUsers(dedupe([doc.ownerId, doc.createdBy]), {
      actor: input.actor,
      title: `Document approved: ${doc.title}`,
      body: `${workflowLabel(input.workflowType)} was auto-approved — no approval rule is configured for this document type.`,
      link: "/modules/operations/document-approval",
    })
    return { ok: true, requestId: raise.requestId, autoApproved: true, status: "approved" }
  }

  await setDocumentWorkflow(doc.id, {
    workflowType: input.workflowType,
    approvalRequestId: raise.requestId,
    approvalStatus: "pending",
    status: "submitted",
    approvedBy: null,
    approvedAt: null,
  })
  await notifyApprovers(raise.requestId, {
    actor: input.actor,
    title: `Approval requested: ${doc.title}`,
    body: `A ${workflowLabel(input.workflowType)} document is awaiting your approval.`,
  })
  return { ok: true, requestId: raise.requestId, autoApproved: false, status: "pending" }
}

/**
 * Sync a document with the terminal/interim state of its approval request.
 * Called from the approvals action route after every approve/reject/cancel — a
 * no-op for requests that are not bound to a document. Also called after a
 * document owner withdraws (cancels) their own request.
 */
export async function handleDocumentApprovalOutcome(
  requestId: number,
  engineStatus: EngineStatus,
): Promise<void> {
  const doc = await getDocumentByApprovalRequest(requestId)
  if (!doc) return

  const detail = await getRequestDetail(requestId)
  const anyStepActed = detail
    ? detail.steps.some((s) => s.decision && s.decision !== "pending")
    : false
  const nextStatus = mapApprovalToDocStatus(engineStatus, { anyStepActed })

  if (engineStatus === "approved") {
    await setDocumentWorkflow(doc.id, {
      approvalStatus: "approved",
      status: nextStatus,
      approvedBy: lastActorId(detail?.steps) ?? null,
      approvedAt: new Date(),
    })
  } else if (engineStatus === "rejected") {
    await setDocumentWorkflow(doc.id, {
      approvalStatus: "rejected",
      status: nextStatus,
      approvedBy: null,
      approvedAt: null,
    })
  } else if (engineStatus === "cancelled") {
    await setDocumentWorkflow(doc.id, {
      approvalStatus: "none",
      status: nextStatus,
      approvedBy: null,
      approvedAt: null,
    })
  } else {
    // still pending — reflect interim progress (submitted → review)
    await setDocumentWorkflow(doc.id, { approvalStatus: "pending", status: nextStatus })
    return
  }

  await notifyUsers(dedupe([doc.ownerId, doc.createdBy]), {
    title:
      engineStatus === "approved"
        ? `Document approved: ${doc.title}`
        : engineStatus === "rejected"
          ? `Document rejected: ${doc.title}`
          : `Approval withdrawn: ${doc.title}`,
    body:
      engineStatus === "approved"
        ? "Your document completed its approval workflow."
        : engineStatus === "rejected"
          ? "Your document was rejected. Review the comments and resubmit if needed."
          : "The approval request was withdrawn and the document returned to draft.",
    link: "/modules/operations/document-approval",
  })
}

// ---------------------------------------------------------------------------
// Notifications (targeted, in-app)
// ---------------------------------------------------------------------------

function dedupe(ids: Array<number | null | undefined>): number[] {
  return Array.from(new Set(ids.filter((v): v is number => typeof v === "number" && v > 0)))
}

function lastActorId(steps: ApprovalStepRecord[] | undefined): number | null {
  if (!steps?.length) return null
  const acted = steps.filter((s) => s.decision === "approved" && s.actedBy != null)
  return acted.length ? Number(acted[acted.length - 1].actedBy) : null
}

/** Notify the concrete approver users on the request's current level. */
async function notifyApprovers(
  requestId: number,
  opts: { actor: ApprovalActor; title: string; body: string },
): Promise<void> {
  const detail = await getRequestDetail(requestId)
  if (!detail) return
  const level = detail.request.currentLevel
  const approverIds = dedupe(
    detail.steps
      .filter((s) => (level == null || s.levelNo === level) && s.decision === "pending")
      .map((s) => s.approverUserId),
  ).filter((id) => id !== opts.actor.userId)
  await notifyUsers(approverIds, {
    actor: opts.actor,
    title: opts.title,
    body: opts.body,
    link: "/modules/operations/document-approval",
  })
}

/** Direct, precisely-targeted in-app notifications for specific users. */
async function notifyUsers(
  userIds: number[],
  opts: { actor?: ApprovalActor; title: string; body: string; link: string },
): Promise<void> {
  if (userIds.length === 0) return
  try {
    const tenantId = requireCurrentTenantId()
    await ensureNotificationsSchema()
    // Only notify active members of this tenant.
    const rows = await query<Array<{ id: number }>>(
      `SELECT id FROM users WHERE tenant_id = ? AND status = 'active' AND id IN (${userIds
        .map(() => "?")
        .join(",")})`,
      [tenantId, ...userIds],
    )
    for (const r of rows) {
      await query(
        `INSERT INTO notifications (user_id, actor_id, actor_name, module_key, action, title, body, link)
         VALUES (?,?,?,?,?,?,?,?)`,
        [
          r.id,
          opts.actor?.userId ?? null,
          opts.actor?.name ?? null,
          "operations.document-approval",
          "update",
          opts.title.slice(0, 255),
          opts.body.slice(0, 500),
          opts.link,
        ],
      )
    }
  } catch (err) {
    // Notifications must never break the approval decision itself.
    console.error("[v0] dms approval notify failed:", err)
  }
}

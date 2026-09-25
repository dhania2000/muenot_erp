import { NextResponse } from "next/server"
import { requireAnomaly, isResponse, serviceError } from "@/lib/ai/anomaly-detection/request"
import { reviewAlert, isServiceError } from "@/lib/ai/anomaly-detection/service"
import { ALERT_STATUSES, normalizeStatus } from "@/lib/ai/anomaly-detection/model"

export const dynamic = "force-dynamic"

/**
 * POST — a human review decision: move status and optionally assign an owner and
 * attach a resolution note. This is the ONLY way an alert changes state; no rule
 * or model ever resolves an alert automatically. Terminal outcomes (dismiss /
 * resolve) require a note (enforced in the service via model.validateReview).
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAnomaly({ requireManage: true })
  if (isResponse(ctx)) return ctx

  const { id } = await params
  const alertId = Number(id)
  if (!Number.isInteger(alertId) || alertId <= 0) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const toStatusRaw = String(body?.status ?? "")
  if (!(ALERT_STATUSES as readonly string[]).includes(toStatusRaw)) {
    return NextResponse.json({ error: "Invalid target status" }, { status: 400 })
  }

  let ownerId: number | null | undefined
  if (body?.ownerId === null) {
    ownerId = null
  } else if (body?.ownerId !== undefined) {
    const n = Number(body.ownerId)
    if (!Number.isInteger(n) || n <= 0) {
      return NextResponse.json({ error: "ownerId must be a positive integer" }, { status: 400 })
    }
    ownerId = n
  }

  const note = body?.note == null ? null : String(body.note)

  const result = await reviewAlert({
    actor: ctx.actor,
    alertId,
    toStatus: normalizeStatus(toStatusRaw),
    note,
    ownerId,
  })
  if (isServiceError(result)) return serviceError(result)
  return NextResponse.json({ alert: result })
}

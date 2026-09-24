import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import { ensureContactTables, mergeContacts } from "@/lib/contacts/db"
import { ContactNotFoundError } from "@/lib/contacts/model"

/**
 * Merge a duplicate into this survivor. Body: { loserId }. The survivor is the
 * `:id` in the path; the loser is archived and re-parented into it.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.manage_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const body = await request.json().catch(() => ({}) as any)
  const loserId = Number(body.loserId)
  const survivorId = Number(id)
  if (!Number.isFinite(loserId) || loserId <= 0) {
    return NextResponse.json({ error: "loserId is required" }, { status: 400 })
  }

  try {
    await mergeContacts(survivorId, loserId, session.userId)
  } catch (err) {
    if (err instanceof ContactNotFoundError) return NextResponse.json({ error: err.message }, { status: 404 })
    return NextResponse.json({ error: (err as Error).message || "Unable to merge" }, { status: 400 })
  }

  await recordAudit(null, {
    entityType: "contact",
    entityId: id,
    action: "merged",
    summary: `Contact ${loserId} merged into ${survivorId}`,
    meta: { survivorId, loserId },
    actorId: session.userId,
  })

  return NextResponse.json({ ok: true, survivorId, loserId })
}

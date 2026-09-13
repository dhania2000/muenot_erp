import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import { ensureClientTables, mergeClients, ClientNotFoundError } from "@/lib/clients-db"

/**
 * Merge a duplicate client into a survivor. Requires manage permission and an
 * explicit source/target — never merges automatically on name similarity.
 * Financial history is repointed, not lost, and the source is archived.
 */
export async function POST(request: Request) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const sourceId = Number(body.source_id)
  const targetId = Number(body.target_id)
  if (!Number.isFinite(sourceId) || !Number.isFinite(targetId)) {
    return NextResponse.json({ error: "source_id and target_id are required" }, { status: 400 })
  }

  try {
    const result = await mergeClients(sourceId, targetId, session.userId)

    await recordAudit(null, {
      entityType: "client",
      entityId: result.target_code,
      action: "merged",
      summary: `Merged ${result.source_name} (${result.source_code}) into ${result.target_name}`,
      meta: { source_code: result.source_code, invoices_repointed: result.invoices_repointed, inherited: result.inherited },
      actorId: session.userId,
    })
    await recordAudit(null, {
      entityType: "client",
      entityId: result.source_code,
      action: "merged",
      summary: `Merged into ${result.target_name} (${result.target_code}) and archived`,
      meta: { target_code: result.target_code },
      actorId: session.userId,
    })

    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    if (error instanceof ClientNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    return NextResponse.json({ error: (error as Error).message || "Unable to merge clients" }, { status: 400 })
  }
}

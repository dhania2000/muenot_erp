import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteCustomConflict, logSodAudit } from "@/lib/sod"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** Delete a custom conflict (built-in conflicts can only be disabled). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ key: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { key } = await params
  await deleteCustomConflict(key)
  await logSodAudit({
    action: "custom_conflict_deleted",
    actorId: session.userId,
    actorName: session.name,
    conflictKey: key,
    summary: `Custom conflict "${key}" deleted`,
  })
  return NextResponse.json({ ok: true })
}

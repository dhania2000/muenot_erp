import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { logSodAudit, setViolationStatus } from "@/lib/sod"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** Waive (accept the risk) or re-open a violation. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number((await params).id)
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "Invalid violation id" }, { status: 400 })
  }

  const body = (await request.json().catch(() => null)) as { status?: "open" | "waived"; note?: string } | null
  if (!body || (body.status !== "open" && body.status !== "waived")) {
    return NextResponse.json({ error: "status must be 'open' or 'waived'" }, { status: 400 })
  }

  await setViolationStatus(id, body.status, { id: session.userId, name: session.name }, body.note)
  await logSodAudit({
    action: body.status === "waived" ? "violation_waived" : "violation_reopened",
    actorId: session.userId,
    actorName: session.name,
    summary: body.status === "waived" ? `Violation #${id} waived` : `Violation #${id} re-opened`,
    detail: body.note ? { note: body.note } : null,
  })
  return NextResponse.json({ ok: true })
}

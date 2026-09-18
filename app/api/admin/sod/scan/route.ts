import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { logSodAudit, scanTenant } from "@/lib/sod"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** Re-scan every user and refresh the violation snapshot. */
export async function POST() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const violations = await scanTenant()
  await logSodAudit({
    action: "scan_run",
    actorId: session.userId,
    actorName: session.name,
    summary: `Full SoD scan — ${violations.length} active violation(s)`,
  })
  return NextResponse.json({ ok: true, violations })
}

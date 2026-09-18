import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  createCustomConflict,
  getResolvedConflicts,
  listSodAudit,
  listViolations,
  logSodAudit,
  updateConflictSetting,
} from "@/lib/sod"
import { SOD_DUTIES, SOD_ENFORCEMENTS, SOD_SEVERITIES } from "@/lib/sod-registry"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

/** Full SoD console payload: catalog, matrix, violations and audit trail. */
export async function GET() {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const [conflicts, violations, audit] = await Promise.all([
    getResolvedConflicts(),
    listViolations(),
    listSodAudit(200),
  ])

  return NextResponse.json({
    duties: SOD_DUTIES.map((d) => ({
      key: d.key,
      label: d.label,
      domain: d.domain,
      side: d.side,
      description: d.description,
    })),
    severities: SOD_SEVERITIES,
    enforcements: SOD_ENFORCEMENTS,
    conflicts,
    violations,
    audit,
  })
}

/** Update enable/enforcement/severity for a built-in or custom conflict. */
export async function PATCH(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as {
    conflictKey?: string
    enabled?: boolean
    enforcement?: "block" | "warn"
    severity?: "low" | "medium" | "high" | "critical"
  } | null
  if (!body?.conflictKey) {
    return NextResponse.json({ error: "conflictKey is required" }, { status: 400 })
  }

  try {
    await updateConflictSetting(body.conflictKey, {
      enabled: body.enabled,
      enforcement: body.enforcement,
      severity: body.severity,
    })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }

  await logSodAudit({
    action: "config_updated",
    actorId: session.userId,
    actorName: session.name,
    conflictKey: body.conflictKey,
    summary: `Conflict "${body.conflictKey}" updated`,
    detail: { enabled: body.enabled, enforcement: body.enforcement, severity: body.severity },
  })

  return NextResponse.json({ ok: true })
}

/** Create an admin-authored custom conflict. */
export async function POST(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as {
    label?: string
    description?: string
    dutyA?: string
    dutyB?: string
    severity?: "low" | "medium" | "high" | "critical"
    enforcement?: "block" | "warn"
  } | null
  if (!body?.label || !body.dutyA || !body.dutyB) {
    return NextResponse.json({ error: "label, dutyA and dutyB are required" }, { status: 400 })
  }

  try {
    const key = await createCustomConflict({
      label: body.label,
      description: body.description,
      dutyA: body.dutyA,
      dutyB: body.dutyB,
      severity: body.severity ?? "high",
      enforcement: body.enforcement ?? "block",
      createdBy: session.userId,
    })
    await logSodAudit({
      action: "custom_conflict_created",
      actorId: session.userId,
      actorName: session.name,
      conflictKey: key,
      summary: `Custom conflict "${body.label}" created`,
      detail: { dutyA: body.dutyA, dutyB: body.dutyB },
    })
    return NextResponse.json({ ok: true, key })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

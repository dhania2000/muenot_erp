import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getOperationGates, setOperationGate, listChanges, type ChangeStatus } from "@/lib/maker-checker"

// SPEC 12 — admin console backend. Configure which high-risk operations require
// maker-checker, and review captured changes. Admin-only, tenant-scoped.

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  if (!getCurrentTenant()) return null
  return session
}

export async function GET(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const status = url.searchParams.get("status") as ChangeStatus | null

  try {
    const [operations, changes] = await Promise.all([
      getOperationGates(),
      listChanges(status ? { status } : undefined),
    ])
    return NextResponse.json({ operations, changes })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as {
    operationKey?: string
    enabled?: boolean
  } | null

  if (!body?.operationKey || typeof body.enabled !== "boolean")
    return NextResponse.json({ error: "operationKey and enabled are required" }, { status: 400 })

  try {
    await setOperationGate(body.operationKey, body.enabled, session.userId)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

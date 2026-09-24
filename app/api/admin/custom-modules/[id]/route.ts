import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { deleteModule, getModuleById, setModuleStatus } from "@/lib/custom-modules/store"
import { recordStateCounts, runReport } from "@/lib/custom-modules/service"
import type { ModuleStatus } from "@/lib/custom-modules/model"

export const dynamic = "force-dynamic"

async function requireAdminTenant() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return { session, tenantId: tenant.tenantId }
}

function parseId(raw: string): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid module id." }, { status: 400 })

  const module = await getModuleById(id)
  if (!module) return NextResponse.json({ error: "Module not found." }, { status: 404 })

  const [counts, reports] = await Promise.all([
    recordStateCounts(id),
    Promise.all(module.reports.map((r) => runReport(module, r))),
  ])
  return NextResponse.json({ module, counts, reports })
}

const VALID_STATUS: ModuleStatus[] = ["draft", "published", "archived"]

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid module id." }, { status: 400 })

  const body = await request.json().catch(() => null)
  const status = body?.status as string | undefined
  if (!status || !VALID_STATUS.includes(status as ModuleStatus)) {
    return NextResponse.json({ error: "A valid status is required." }, { status: 400 })
  }

  const result = await setModuleStatus(id, status as ModuleStatus)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireAdminTenant()
  if (!ctx) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const id = parseId((await params).id)
  if (!id) return NextResponse.json({ error: "Invalid module id." }, { status: 400 })

  const result = await deleteModule(id)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 })
  return NextResponse.json({ ok: true })
}

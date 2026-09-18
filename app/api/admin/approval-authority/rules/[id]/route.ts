import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { getRule, updateRule, deleteRule, type RuleInput } from "@/lib/approval-authority"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  const tenant = getCurrentTenant()
  if (!tenant) return null
  return session
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const rule = await getRule(Number(id))
  if (!rule) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ rule })
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = (await request.json().catch(() => null)) as RuleInput | null
  if (!body?.name?.trim()) return NextResponse.json({ error: "Rule name is required" }, { status: 400 })
  if (!Array.isArray(body.levels) || body.levels.length === 0)
    return NextResponse.json({ error: "At least one approval level is required" }, { status: 400 })

  const ok = await updateRule(Number(id), body)
  if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 })
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  await deleteRule(Number(id))
  return NextResponse.json({ ok: true })
}

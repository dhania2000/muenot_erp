import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { setDelegationActive, deleteDelegation } from "@/lib/approval-authority"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  if (!getCurrentTenant()) return null
  return session
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  const body = (await request.json().catch(() => null)) as { active?: boolean } | null
  await setDelegationActive(Number(id), Boolean(body?.active))
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const { id } = await params
  await deleteDelegation(Number(id))
  return NextResponse.json({ ok: true })
}

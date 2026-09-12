import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listDepartmentAgents, setDepartmentAgents } from "@/lib/whatsapp-platform"

function parseId(id: string): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Lists agents assigned to a department. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const departmentId = parseId(id)
  if (!departmentId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const agents = await listDepartmentAgents(departmentId)
  return NextResponse.json({ agents })
}

/** Replaces the department's agent roster (admins only). */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const departmentId = parseId(id)
  if (!departmentId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as { userIds?: unknown }
  const userIds = Array.isArray(body.userIds)
    ? body.userIds.map((v) => Number(v)).filter((n) => Number.isInteger(n) && n > 0)
    : []

  await setDepartmentAgents(departmentId, userIds)
  const agents = await listDepartmentAgents(departmentId)
  return NextResponse.json({ ok: true, agents })
}

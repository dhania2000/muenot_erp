import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { deleteDepartment, listDepartments, updateDepartment } from "@/lib/whatsapp-platform"

function parseId(id: string): number | null {
  const n = Number(id)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** Updates a department (admins only). */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const departmentId = parseId(id)
  if (!departmentId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    description?: string | null
    color?: string | null
    autoAssign?: boolean
    isActive?: boolean
  }
  await updateDepartment(departmentId, body)
  const departments = await listDepartments()
  return NextResponse.json({ ok: true, departments })
}

/** Deletes a department (admins only). */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const departmentId = parseId(id)
  if (!departmentId) return NextResponse.json({ error: "Invalid id" }, { status: 400 })

  await deleteDepartment(departmentId)
  const departments = await listDepartments()
  return NextResponse.json({ ok: true, departments })
}

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

async function requireAdmin() {
  const session = await getSession()
  if (!session || session.role !== "admin") return null
  return session
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const { status, designation, name } = await request.json()

  const updates: string[] = []
  const values: any[] = []
  if (status) {
    updates.push("status = ?")
    values.push(status)
  }
  if (designation !== undefined) {
    updates.push("designation = ?")
    values.push(designation)
  }
  if (name) {
    updates.push("name = ?")
    values.push(name)
  }
  if (updates.length === 0) {
    return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
  }

  values.push(id)
  await query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, values)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireAdmin()
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  if (Number(id) === session.userId) {
    return NextResponse.json({ error: "You cannot delete your own account" }, { status: 400 })
  }

  await query("DELETE FROM users WHERE id = ? AND role != 'admin'", [id])
  return NextResponse.json({ ok: true })
}

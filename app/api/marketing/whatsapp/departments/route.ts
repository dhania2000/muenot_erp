import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { createDepartment, listDepartments } from "@/lib/whatsapp-platform"

/** Lists all WhatsApp departments (any authenticated agent may read). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const departments = await listDepartments()
  return NextResponse.json({ departments })
}

/** Creates a department (admins only). */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => ({}))) as {
    name?: string
    description?: string | null
    color?: string | null
    autoAssign?: boolean
  }
  if (!body.name?.trim()) return NextResponse.json({ error: "Name is required" }, { status: 400 })

  const id = await createDepartment({
    name: body.name,
    description: body.description ?? null,
    color: body.color ?? null,
    autoAssign: Boolean(body.autoAssign),
  })
  const departments = await listDepartments()
  return NextResponse.json({ ok: true, id, departments }, { status: 201 })
}

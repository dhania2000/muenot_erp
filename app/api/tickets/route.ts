import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"

const priorities = ["low", "medium", "high", "urgent"] as const
const statuses = ["open", "pending", "resolved", "closed"] as const
const types = ["general", "bug", "feature", "incident", "billing", "question"] as const

async function loadEmployees(): Promise<string[]> {
  try {
    const rows = await query<any[]>(
      "SELECT employee_name FROM hr_employees WHERE employee_name IS NOT NULL AND employee_name <> '' ORDER BY employee_name",
    )
    return rows.map((r) => r.employee_name)
  } catch {
    return []
  }
}

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canView = await userHasFeature(session.userId, session.role, "tickets.view")
  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "tickets.manage"))
  if (!canView && !canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const params: unknown[] = []

  // Permission scope: managers see everything, everyone else sees only their own tickets.
  if (!canManage) {
    where.push("created_by = ?")
    params.push(session.userId)
  }

  const search = sp.get("q")?.trim()
  if (search) {
    where.push("(subject LIKE ? OR requester_name LIKE ? OR agent_name LIKE ?)")
    params.push(`%${search}%`, `%${search}%`, `%${search}%`)
  }
  if (statuses.includes(sp.get("status") as any)) {
    where.push("status = ?")
    params.push(sp.get("status"))
  }
  if (priorities.includes(sp.get("priority") as any)) {
    where.push("priority = ?")
    params.push(sp.get("priority"))
  }

  const tickets = await query<any[]>(
    "SELECT * FROM hr_tickets" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY created_at DESC",
    params as any[],
  )

  return NextResponse.json({
    tickets,
    employees: canManage ? await loadEmployees() : [],
    canManage,
    me: { userId: session.userId, name: session.name, email: session.email },
  })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "tickets.manage"))
  const canView = await userHasFeature(session.userId, session.role, "tickets.view")
  if (!canView && !canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const subject = String(body.subject || "").trim()
  const description = body.description != null ? String(body.description).trim() : null
  const type = types.includes(body.type) ? body.type : "general"
  const priority = priorities.includes(body.priority) ? body.priority : "medium"
  if (!subject) return NextResponse.json({ error: "Subject is required" }, { status: 400 })

  // Managers may raise on behalf of anyone and assign an agent up front.
  // Employees always raise as themselves.
  const requesterName = canManage && body.requester_name ? String(body.requester_name).trim() : session.name
  const requesterEmail = canManage && body.requester_email ? String(body.requester_email).trim() : session.email
  const agentName = canManage && body.agent_name ? String(body.agent_name).trim() : null

  const result = await query<any>(
    "INSERT INTO hr_tickets (subject, description, type, priority, status, requester_name, requester_email, agent_name, created_by, created_by_name) VALUES (?,?,?,?,?,?,?,?,?,?)",
    [subject, description, type, priority, "open", requesterName, requesterEmail, agentName, session.userId, session.name],
  )
  return NextResponse.json({ ok: true, id: result?.insertId }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  // Only management can update tickets (status, priority, type, assigned agent).
  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "tickets.manage"))
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const id = Number(body.id)
  if (!id) return NextResponse.json({ error: "Ticket id required" }, { status: 400 })

  const sets: string[] = []
  const params: unknown[] = []
  if (body.status !== undefined) {
    if (!statuses.includes(body.status)) return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    sets.push("status = ?"); params.push(body.status)
  }
  if (body.priority !== undefined) {
    if (!priorities.includes(body.priority)) return NextResponse.json({ error: "Invalid priority" }, { status: 400 })
    sets.push("priority = ?"); params.push(body.priority)
  }
  if (body.type !== undefined) {
    if (!types.includes(body.type)) return NextResponse.json({ error: "Invalid type" }, { status: 400 })
    sets.push("type = ?"); params.push(body.type)
  }
  if (body.agent_name !== undefined) {
    sets.push("agent_name = ?"); params.push(body.agent_name ? String(body.agent_name).trim() : null)
  }
  if (sets.length === 0) return NextResponse.json({ error: "Nothing to update" }, { status: 400 })

  params.push(id)
  await query(`UPDATE hr_tickets SET ${sets.join(", ")} WHERE id = ?`, params as any[])
  return NextResponse.json({ ok: true })
}

export async function DELETE(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const canManage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "tickets.manage"))
  if (!canManage) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const id = Number(request.nextUrl.searchParams.get("id"))
  if (!id) return NextResponse.json({ error: "Ticket id required" }, { status: 400 })
  await query("DELETE FROM hr_tickets WHERE id = ?", [id])
  return NextResponse.json({ ok: true })
}

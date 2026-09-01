import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"

const allowedStatuses = ["Open", "In Progress", "Waiting", "Resolved", "Closed"]
const allowedPriorities = ["Low", "Medium", "High", "Urgent"]

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sp = request.nextUrl.searchParams
  const where: string[] = []
  const params: unknown[] = []
  if (sp.get("status")) { where.push("status = ?"); params.push(sp.get("status")) }
  if (sp.get("priority")) { where.push("priority = ?"); params.push(sp.get("priority")) }
  if (sp.get("category")) { where.push("support_category = ?"); params.push(sp.get("category")) }
  const rows = await query("SELECT * FROM hr_support_tickets" + (where.length ? ` WHERE ${where.join(" AND ")}` : "") + " ORDER BY created_at DESC", params as any[])
  return NextResponse.json({ tickets: rows })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const { employee_id, employee_name, support_category, subject, description, priority = "Medium", attachment_path, employee_remarks } = body
  if (!support_category || !subject || !description || !allowedPriorities.includes(priority)) return NextResponse.json({ error: "Category, subject, description and valid priority are required" }, { status: 400 })
  const ticketId = `HRS-${Date.now().toString(36).toUpperCase()}`
  const slaHours = priority === "Urgent" ? 4 : priority === "High" ? 8 : priority === "Medium" ? 24 : 48
  await query("INSERT INTO hr_support_tickets (ticket_id, employee_id, employee_name, support_category, subject, description, priority, attachment_path, employee_remarks, sla_due_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(), INTERVAL ? HOUR))", [ticketId, employee_id || null, employee_name || null, support_category, subject, description, priority, attachment_path || null, employee_remarks || null, slaHours])
  return NextResponse.json({ ticket_id: ticketId }, { status: 201 })
}

export async function PATCH(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await request.json()
  const { id, status, assigned_to, assigned_to_name, hr_remarks, resolution } = body
  if (!id || !status || !allowedStatuses.includes(status)) return NextResponse.json({ error: "Valid ticket and status are required" }, { status: 400 })
  await query("UPDATE hr_support_tickets SET status = ?, assigned_to = ?, assigned_to_name = ?, hr_remarks = ?, resolution = ?, first_response_at = IF(first_response_at IS NULL AND ? <> 'Open', NOW(), first_response_at), resolved_at = IF(? = 'Resolved', NOW(), resolved_at), closed_at = IF(? = 'Closed', NOW(), closed_at), closed_by = IF(? = 'Closed', ?, closed_by) WHERE id = ?", [status, assigned_to || null, assigned_to_name || null, hr_remarks || null, resolution || null, status, status, status, status, assigned_to_name || "HR", id])
  return NextResponse.json({ ok: true })
}

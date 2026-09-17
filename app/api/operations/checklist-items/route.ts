import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { canCreateInModule, canPerformAction } from "@/lib/permission-enforce"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import { recomputeChecklistFromItems } from "@/lib/operations-sync"

const PERMISSION_KEY = "operations.checklists"
const ITEM_STATUSES = ["Pending", "Completed", "Not Applicable"]

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const checklistId = Number(new URL(request.url).searchParams.get("checklist_id"))
  if (!Number.isFinite(checklistId) || checklistId <= 0) {
    return NextResponse.json({ error: "Missing checklist_id" }, { status: 400 })
  }
  try {
    await ensureOperationsSchema()
    const rows = await query<any[]>(
      `SELECT * FROM operations_checklist_items WHERE checklist_id = ? ORDER BY sort_order IS NULL, sort_order, id`,
      [checklistId],
    )
    return NextResponse.json({ rows })
  } catch {
    return NextResponse.json({ error: "Failed to load checklist items" }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to edit this checklist." }, { status: 403 })
  }
  const body = await request.json()
  const checklistId = Number(body.checklist_id)
  if (!Number.isFinite(checklistId) || checklistId <= 0) {
    return NextResponse.json({ error: "Missing checklist_id" }, { status: 400 })
  }
  const itemText = String(body.item_text ?? "").trim()
  if (!itemText) return NextResponse.json({ error: "Item text is required" }, { status: 400 })
  const status = ITEM_STATUSES.includes(body.item_status) ? body.item_status : "Pending"
  try {
    await ensureOperationsSchema()
    const result = await query<any>(
      `INSERT INTO operations_checklist_items (checklist_id, item_text, sort_order, item_status, remarks, created_by)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [checklistId, itemText, body.sort_order ?? null, status, body.remarks ?? null, session.userId],
    )
    await recomputeChecklistFromItems(checklistId)
    return NextResponse.json({ id: result.insertId }, { status: 201 })
  } catch {
    return NextResponse.json({ error: "Failed to add checklist item" }, { status: 500 })
  }
}

export async function PUT(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, PERMISSION_KEY, "update"))) {
    return NextResponse.json({ error: "You do not have permission to edit this checklist." }, { status: 403 })
  }
  const body = await request.json()
  const id = Number(body.id)
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: "Missing item id" }, { status: 400 })
  try {
    await ensureOperationsSchema()
    const existing = await query<any[]>(
      `SELECT checklist_id FROM operations_checklist_items WHERE id = ? LIMIT 1`,
      [id],
    )
    if (!existing.length) return NextResponse.json({ error: "Item not found" }, { status: 404 })

    const sets: string[] = []
    const args: any[] = []
    if (typeof body.item_text === "string") { sets.push("item_text = ?"); args.push(body.item_text.trim() || null) }
    if (typeof body.remarks === "string") { sets.push("remarks = ?"); args.push(body.remarks || null) }
    if (body.sort_order !== undefined) { sets.push("sort_order = ?"); args.push(body.sort_order === "" ? null : body.sort_order) }
    if (body.item_status !== undefined) {
      const status = ITEM_STATUSES.includes(body.item_status) ? body.item_status : "Pending"
      sets.push("item_status = ?"); args.push(status)
      // Stamp who/when on completion; clear the stamp when reopened.
      if (status === "Completed") {
        sets.push("completed_by = ?", "completed_at = NOW()")
        args.push(session.name)
      } else {
        sets.push("completed_by = NULL", "completed_at = NULL")
      }
    }
    if (!sets.length) return NextResponse.json({ error: "No fields supplied" }, { status: 400 })
    args.push(id)
    await query(`UPDATE operations_checklist_items SET ${sets.join(", ")} WHERE id = ?`, args)
    await recomputeChecklistFromItems(existing[0].checklist_id)
    return NextResponse.json({ id })
  } catch {
    return NextResponse.json({ error: "Failed to update checklist item" }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, PERMISSION_KEY, "delete"))) {
    return NextResponse.json({ error: "You do not have permission to edit this checklist." }, { status: 403 })
  }
  const id = Number(new URL(request.url).searchParams.get("id"))
  if (!Number.isFinite(id) || id <= 0) return NextResponse.json({ error: "Missing item id" }, { status: 400 })
  try {
    await ensureOperationsSchema()
    const existing = await query<any[]>(
      `SELECT checklist_id FROM operations_checklist_items WHERE id = ? LIMIT 1`,
      [id],
    )
    if (!existing.length) return NextResponse.json({ error: "Item not found" }, { status: 404 })
    await query(`DELETE FROM operations_checklist_items WHERE id = ?`, [id])
    await recomputeChecklistFromItems(existing[0].checklist_id)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: "Failed to delete checklist item" }, { status: 500 })
  }
}

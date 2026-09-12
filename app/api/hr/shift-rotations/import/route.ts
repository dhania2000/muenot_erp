import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { userHasFeature } from "@/lib/permissions"
import { ensureShiftRotationSchema, addMembers, type Actor } from "@/lib/hr-shift-rotations"

/**
 * Bulk membership import. Accepts a CSV whose columns are (header row required,
 * order-independent, case-insensitive):
 *   rotation_id, employee_code, start_date, end_date(optional)
 *
 * Employee codes are resolved to internal ids, rows are grouped per rotation,
 * and each group is applied through the same addMembers() path the UI uses, so
 * every validation and conflict rule (§bulk assign) is enforced identically.
 */
function parseCsv(text: string): Record<string, string>[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0)
  if (lines.length < 2) return []
  const split = (line: string) => {
    const out: string[] = []
    let cur = ""
    let inQ = false
    for (let i = 0; i < line.length; i++) {
      const c = line[i]
      if (inQ) {
        if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ } else if (c === '"') inQ = false
        else cur += c
      } else if (c === '"') inQ = true
      else if (c === ",") { out.push(cur); cur = "" }
      else cur += c
    }
    out.push(cur)
    return out.map((s) => s.trim())
  }
  const headers = split(lines[0]).map((h) => h.toLowerCase().replace(/\s+/g, "_"))
  return lines.slice(1).map((line) => {
    const cells = split(line)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => (row[h] = cells[i] ?? ""))
    return row
  })
}

export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureShiftRotationSchema()
  const manage = session.role === "admin" || (await userHasFeature(session.userId, session.role, "hr.manage_shift_rotations"))
  if (!manage) return NextResponse.json({ error: "You do not have permission to import rotation members." }, { status: 403 })

  const text = await request.text()
  const rows = parseCsv(text)
  if (rows.length === 0) {
    return NextResponse.json({ error: "The CSV is empty or missing a header row." }, { status: 400 })
  }

  // Resolve every referenced employee code in one round trip.
  const codes = Array.from(new Set(rows.map((r) => r.employee_code).filter(Boolean)))
  const codeToId = new Map<string, number>()
  if (codes.length) {
    const found = await query<{ id: number; employee_id: string }[]>(
      `SELECT id, employee_id FROM hr_employees WHERE archived_at IS NULL AND employee_id IN (${codes.map(() => "?").join(",")})`,
      codes,
    )
    for (const e of found) codeToId.set(String(e.employee_id), Number(e.id))
  }

  // Group valid rows by rotation with a shared start/end window.
  type Group = { employeeIds: number[]; start_date: string; end_date: string | null }
  const groups = new Map<string, Group>()
  const errors: string[] = []
  rows.forEach((r, idx) => {
    const line = idx + 2
    const rotationId = r.rotation_id
    const start = (r.start_date || "").slice(0, 10)
    const end = r.end_date ? r.end_date.slice(0, 10) : null
    if (!rotationId) return errors.push(`Row ${line}: missing rotation_id.`)
    if (!r.employee_code) return errors.push(`Row ${line}: missing employee_code.`)
    if (!start) return errors.push(`Row ${line}: missing start_date.`)
    const empId = codeToId.get(r.employee_code)
    if (!empId) return errors.push(`Row ${line}: unknown employee_code "${r.employee_code}".`)
    const key = `${rotationId}|${start}|${end ?? ""}`
    const g = groups.get(key) ?? { employeeIds: [], start_date: start, end_date: end }
    if (!groups.has(key)) groups.set(key, g)
    g.employeeIds.push(empId)
    // Track the rotation id alongside the window key via a side map.
    ;(g as any).rotationId = rotationId
  })

  const actor: Actor = { userId: session.userId, name: session.name, email: session.email, role: session.role }
  let created = 0
  let skipped = 0
  for (const g of groups.values()) {
    const rotationId = (g as any).rotationId as string
    try {
      const result = await addMembers(rotationId, { employeeIds: g.employeeIds, start_date: g.start_date, end_date: g.end_date }, actor, false)
      if (result.ok) {
        created += result.added
        skipped += result.skipped.length
      } else {
        errors.push(`${rotationId}: ${result.errors[0] || "assignment failed"}`)
      }
    } catch (error) {
      console.log("[v0] rotation import group failed", (error as Error).message)
      errors.push(`${rotationId}: import failed.`)
    }
  }

  return NextResponse.json({ created, skipped, failed: errors.length, errors: errors.slice(0, 50) })
}

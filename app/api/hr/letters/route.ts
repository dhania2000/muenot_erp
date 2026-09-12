import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { userHasFeature } from "@/lib/permissions"
import { ensureLetterTables } from "@/lib/hr-letters-db"
import { generateLetter, type GenerateLetterInput } from "@/lib/hr-letters-generate"
import type { LetterSource, LetterStatus } from "@/lib/hr-letters-shared"

const FEATURE = "hr.view_letters"

// ---------------------------------------------------------------------------
// HR Letters collection endpoint.
//   GET  — filtered registry of generated letters (with employee display fields)
//   POST — generate a letter through the shared orchestrator (template or ad-hoc)
// PATCH/DELETE for a single letter live under /[id].
// ---------------------------------------------------------------------------

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, FEATURE))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  await ensureLetterTables()

  const sp = new URL(request.url).searchParams
  const where: string[] = ["l.superseded_by IS NULL"]
  const args: any[] = []

  if (sp.get("status")) {
    where.push("l.status = ?")
    args.push(sp.get("status"))
  }
  if (sp.get("letter_type")) {
    where.push("l.letter_type = ?")
    args.push(sp.get("letter_type"))
  }
  if (sp.get("category")) {
    where.push("l.category = ?")
    args.push(sp.get("category"))
  }
  if (sp.get("source")) {
    where.push("l.source = ?")
    args.push(sp.get("source"))
  }
  if (sp.get("employee_id")) {
    where.push("l.employee_id = ?")
    args.push(Number(sp.get("employee_id")))
  }
  if (sp.get("template_id")) {
    where.push("l.template_id = ?")
    args.push(Number(sp.get("template_id")))
  }
  if (sp.get("q")) {
    const like = `%${sp.get("q")}%`
    where.push("(l.letter_number LIKE ? OR l.subject LIKE ? OR l.recipient_name LIKE ? OR e.employee_name LIKE ?)")
    args.push(like, like, like, like)
  }
  // Superseded/older versions are hidden by default; ?history=all shows them.
  if (sp.get("history") === "all") where.shift()

  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const letters = await query<any[]>(
    `SELECT l.id, l.letter_number, l.reference_no, l.employee_id, l.template_id, l.template_version,
            l.letter_type, l.category, l.audience, l.subject, l.issue_date, l.status,
            l.source, l.source_ref, l.event_key, l.recipient_name, l.document_id, l.email_id,
            l.supersedes_id, l.superseded_by, l.created_at, l.issued_at, l.delivered_at,
            e.employee_name, e.employee_id AS employee_code, e.designation, e.department,
            t.name AS template_name, u.name AS created_by_name
       FROM hr_letters l
       LEFT JOIN hr_employees e ON e.id = l.employee_id
       LEFT JOIN hr_letter_templates t ON t.id = l.template_id
       LEFT JOIN users u ON u.id = l.created_by
       ${whereSql}
       ORDER BY l.created_at DESC, l.id DESC`,
    args,
  )
  return NextResponse.json({ letters })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await userHasFeature(session.userId, session.role, FEATURE))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))

  const input: GenerateLetterInput = {
    templateId: body.template_id ? Number(body.template_id) : null,
    subjectOverride: body.subject ?? null,
    bodyOverride: body.body ?? null,
    letterType: body.letter_type ?? null,
    category: body.category ?? null,
    audience: body.audience ?? null,
    eventKey: body.event_key ?? null,
    source: (body.source ?? null) as LetterSource | null,
    sourceRef: body.source_ref ?? null,
    employeeId: body.employee_id ? Number(body.employee_id) : null,
    issueDate: body.issue_date ?? null,
    status: (body.status as LetterStatus) || "Generated",
    extraVars: body.extra_vars && typeof body.extra_vars === "object" ? body.extra_vars : undefined,
    // Draft letters may be saved with unresolved required values.
    allowMissing: body.status === "Draft" || body.allow_missing === true,
    actorId: session.userId,
  }

  const result = await generateLetter(input)
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, missing: result.missing },
      { status: result.code || 400 },
    )
  }
  return NextResponse.json(
    { letter: result.letter, deduped: result.deduped ?? false },
    { status: result.deduped ? 200 : 201 },
  )
}

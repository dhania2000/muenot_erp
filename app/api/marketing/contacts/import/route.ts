import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import {
  ensureContactSchema,
  buildContactColumns,
  validateContact,
  setContactTags,
  normalizeEmail,
  normalizePhone,
  recordContactActivity,
} from "@/lib/marketing/contacts-db"

type ImportRow = Record<string, any>

/**
 * Bulk import contacts from parsed rows (the client parses CSV and posts JSON).
 * Each row is validated independently; valid rows are inserted or, when they
 * match an existing email/phone, updated (upsert). A per-row report is returned
 * so the UI can show exactly what happened.
 */
export async function POST(request: Request) {
  await ensureContactSchema()
  const session = await requireFeature("marketing.contacts.manage")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  const rows: ImportRow[] = Array.isArray(body.rows) ? body.rows : []
  const dedupe = body.dedupe !== false // default on
  if (rows.length === 0) return NextResponse.json({ error: "No rows to import" }, { status: 400 })
  if (rows.length > 5000) return NextResponse.json({ error: "Import is limited to 5000 rows at a time" }, { status: 400 })

  const report = { created: 0, updated: 0, skipped: 0, errors: [] as { row: number; message: string }[] }

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i]
    // Normalize common header variants.
    const mapped: ImportRow = {
      first_name: raw.first_name ?? raw.firstName ?? raw["First Name"],
      last_name: raw.last_name ?? raw.lastName ?? raw["Last Name"],
      full_name: raw.full_name ?? raw.name ?? raw["Name"],
      email: raw.email ?? raw["Email"],
      phone: raw.phone ?? raw.mobile ?? raw["Phone"],
      company_name: raw.company_name ?? raw.company ?? raw["Company"],
      job_title: raw.job_title ?? raw.title ?? raw["Title"],
      lifecycle_stage: raw.lifecycle_stage ?? raw.stage,
      country: raw.country ?? raw["Country"],
      city: raw.city ?? raw["City"],
      source: raw.source || "Import",
    }
    const tags =
      typeof raw.tags === "string"
        ? raw.tags.split(/[;,]/).map((t: string) => t.trim()).filter(Boolean)
        : Array.isArray(raw.tags)
          ? raw.tags
          : []

    const errors = validateContact(mapped)
    if (Object.keys(errors).length > 0) {
      report.skipped++
      report.errors.push({ row: i + 1, message: Object.values(errors)[0] })
      continue
    }

    const columns = buildContactColumns(mapped)
    const email = normalizeEmail(mapped.email)
    const phone = normalizePhone(mapped.phone)

    try {
      let existingId: number | null = null
      if (dedupe && (email || phone)) {
        const clauses: string[] = []
        const args: any[] = []
        if (email) {
          clauses.push("email_normalized = ?")
          args.push(email)
        }
        if (phone) {
          clauses.push("phone_normalized = ?")
          args.push(phone)
        }
        const match = await query<any[]>(
          `SELECT id FROM marketing_contacts WHERE archived_at IS NULL AND (${clauses.join(" OR ")}) LIMIT 1`,
          args,
        )
        existingId = match[0]?.id ?? null
      }

      if (existingId) {
        const keys = Object.keys(columns)
        await query(
          `UPDATE marketing_contacts SET ${keys
            .map((k) => `${k} = COALESCE(NULLIF(?, ''), ${k})`)
            .join(", ")}, row_version = row_version + 1 WHERE id = ?`,
          [...keys.map((k) => columns[k]), existingId],
        )
        if (tags.length) await setContactTags(existingId, tags)
        report.updated++
      } else {
        const code = await nextRecordId("MKC", { allowCustom: true, digits: 6 })
        const fields = ["contact_code", ...Object.keys(columns)]
        const values = [code, ...Object.keys(columns).map((k) => columns[k])]
        const res = await query<any>(
          `INSERT INTO marketing_contacts (${fields.join(",")},created_by) VALUES (${fields
            .map(() => "?")
            .join(",")},?)`,
          [...values, session.userId],
        )
        const newId = Number((res as any).insertId)
        if (tags.length) await setContactTags(newId, tags)
        await recordContactActivity({
          contactId: newId,
          contactCode: code,
          type: "import",
          summary: "Imported from file",
          actorId: session.userId,
        })
        report.created++
      }
    } catch (e) {
      report.skipped++
      report.errors.push({ row: i + 1, message: "Database error" })
      console.error("[contacts-import] row failed", e)
    }
  }

  return NextResponse.json({ ok: true, report })
}

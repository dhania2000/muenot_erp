import { NextRequest, NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureLetterTables, getCompanySettings } from "@/lib/hr-letters-db"
import { renderLetter } from "@/lib/hr-letters"

// Server-side merge preview. Company settings are admin-only, so the browser
// never reads them directly — it posts the draft here and gets back the
// rendered subject/body with every {{placeholder}} resolved.
export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureLetterTables()

  const body = await request.json()
  let employee: Record<string, any> | null = null
  if (body.employee_id) {
    const rows = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [body.employee_id])
    employee = rows[0] ?? null
  }

  const company = await getCompanySettings()
  const ctx = { employee, company, letter_number: "LTR-PREVIEW" }
  return NextResponse.json({
    subject: renderLetter(body.subject ?? "", ctx),
    body: renderLetter(body.body ?? "", ctx),
    company,
  })
}

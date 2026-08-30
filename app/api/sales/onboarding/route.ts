import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"

export async function GET() {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const onboarding = await query(
    `SELECT o.*, u.name AS added_by_name
     FROM sales_onboarding o
     LEFT JOIN users u ON u.id = o.added_by
     ORDER BY o.created_at DESC`,
  )
  return NextResponse.json({ onboarding })
}

export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()
  if (!body.company_name) {
    return NextResponse.json({ error: "Company name is required" }, { status: 400 })
  }

  const [{ next }] = await query<{ next: number }[]>(
    "SELECT COALESCE(MAX(CAST(SUBSTRING(onboarding_code, 4) AS UNSIGNED)), 0) + 1 AS next FROM sales_onboarding",
  )
  const onboardingCode = `OB-${String(next).padStart(3, "0")}`

  const result = await query<any>(
    `INSERT INTO sales_onboarding
     (onboarding_code, onboarding_date, company_name, contract_code, start_date,
      kickoff_meeting_date, current_stage, status, onboarding_by, added_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      onboardingCode,
      new Date().toISOString().slice(0, 10),
      body.company_name,
      body.contract_code || null,
      body.start_date || null,
      body.kickoff_meeting_date || null,
      body.current_stage || "Kickoff",
      body.status || "Not Started",
      body.onboarding_by || null,
      session.userId,
    ],
  )

  return NextResponse.json({ id: result.insertId, onboarding_code: onboardingCode })
}

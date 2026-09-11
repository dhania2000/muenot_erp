import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureSupportSchema, getCategories, canViewSensitive } from "@/lib/hr-support"

// GET /api/hr/support/categories — active categories for the new-ticket form.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureSupportSchema()

  const sensitive = await canViewSensitive(session)
  const categories = await getCategories()
  // Sensitive categories (e.g. Grievance) are always raiseable by employees, but
  // only agents with the sensitive feature can browse/filter them in lists. The
  // form still needs them, so we return all active categories here.
  return NextResponse.json({ categories, canViewSensitive: sensitive })
}

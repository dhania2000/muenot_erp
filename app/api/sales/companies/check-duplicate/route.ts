import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { findDuplicates } from "@/lib/sales/company-master"

export async function POST(request: Request) {
  const session = await requireFeature("sales.view_companies")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}))
  const duplicates = await findDuplicates({
    company_name: body.company_name,
    domain: body.domain,
    website: body.website,
    company_email: body.company_email,
    excludeId: body.exclude_id ? Number(body.exclude_id) : null,
  })
  return NextResponse.json({ duplicates })
}

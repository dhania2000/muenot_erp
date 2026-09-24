import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import { ensureContactTables, findContactDuplicates } from "@/lib/contacts/db"

/**
 * On-demand duplicate check so the UI can pre-warn while the user types, before
 * they ever submit. Uses the SAME model the POST/PATCH routes enforce with.
 */
export async function POST(request: Request) {
  await ensureContactTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.view_contacts")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => ({}) as any)
  const duplicates = await findContactDuplicates(
    {
      full_name: body.full_name,
      first_name: body.first_name,
      last_name: body.last_name,
      company_name: body.company_name,
      email: body.email,
      phone: body.phone,
      gstin: body.gstin,
      pan: body.pan,
    },
    body.excludeId != null ? Number(body.excludeId) : null,
  )
  return NextResponse.json({ duplicates })
}

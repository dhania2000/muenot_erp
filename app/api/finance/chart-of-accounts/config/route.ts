import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  getAccountMappings,
  setRoleMapping,
  ACCOUNT_ROLE_GROUPS,
  COMPANY_DEFAULT_ROLES,
} from "@/lib/finance-account-config"

// GET: the full role → account mapping table (override + effective) plus the
// UI groupings and the friendly company-default subset. Both screens read this.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const mappings = await getAccountMappings()
  return NextResponse.json({
    mappings,
    roleGroups: ACCOUNT_ROLE_GROUPS,
    companyDefaults: COMPANY_DEFAULT_ROLES,
  })
}

// PUT: persist one role → account override. A blank account_id clears it so the
// role falls back to its seeded default code.
export async function PUT(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json().catch(() => ({}))
  const role = String(body.role ?? "")
  const accountId = body.account_id == null ? null : String(body.account_id)
  const result = await setRoleMapping(role, accountId, session.userId)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  return NextResponse.json({ ok: true })
}

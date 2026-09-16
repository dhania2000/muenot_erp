import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listOffers, createOffer } from "@/lib/recruit-db"
import { canCreateInModule, scopeWhereForModule } from "@/lib/permission-enforce"
import { logRecruitmentAudit } from "@/lib/recruit-audit"

const PERMISSION_KEY = "recruitment.offers"
const AUDIT_MODULE = "recruit-offers"

export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const scoped = await scopeWhereForModule(session, PERMISSION_KEY, "view", "recruit_offers")
  const offers = await listOffers(scoped)
  return NextResponse.json({ offers })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canCreateInModule(session, PERMISSION_KEY))) {
    return NextResponse.json({ error: "You do not have permission to add offers" }, { status: 403 })
  }
  const body = await request.json()
  if (!body.candidate_name?.trim()) return NextResponse.json({ error: "Candidate is required" }, { status: 400 })
  const result = await createOffer(body, session.userId)
  await logRecruitmentAudit({
    module: AUDIT_MODULE,
    table: "recruit_offers",
    recordId: (result as any)?.offer_id ?? (result as any)?.id ?? null,
    action: "create",
    userId: session.userId,
    userName: session.name,
    newValue: { ...body, offer_id: (result as any)?.offer_id },
  })
  return NextResponse.json(result, { status: 201 })
}

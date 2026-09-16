import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { convertOfferToEmployee } from "@/lib/recruit-integrations-db"
import { getOfferById } from "@/lib/recruit-db"
import { canActOnRecordAction } from "@/lib/permission-enforce"

const PERMISSION_KEY = "recruitment.offers"

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params

  // Phase 53: converting an accepted offer into an employee creates HR +
  // onboarding data — an irreversible step gated separately from Update/Delete.
  // Unconfigured / admin accounts fall through to full access.
  const offer = await getOfferById(id)
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404 })
  if (!(await canActOnRecordAction(session, PERMISSION_KEY, "convert_offer", offer))) {
    return NextResponse.json(
      { error: "You do not have permission to convert this offer to an employee" },
      { status: 403 },
    )
  }

  const body = await request.json().catch(() => ({}))
  try {
    const result = await convertOfferToEmployee(id, body || {}, session.userId)
    return NextResponse.json({ ok: true, ...result }, { status: 201 })
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Conversion failed" }, { status: 400 })
  }
}

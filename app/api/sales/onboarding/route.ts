import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  createFromContract,
  createOnboarding,
  listOnboarding,
  onboardingErrorStatus,
} from "@/lib/sales/onboarding-service"
import { canCreateInModule } from "@/lib/permission-enforce"

/** GET /api/sales/onboarding — filtered list of onboarding records. */
export async function GET(request: Request) {
  const session = await requireFeature("sales.view_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const sp = new URL(request.url).searchParams
  try {
    const onboarding = await listOnboarding({
      search: sp.get("search") || undefined,
      status: sp.get("status") || undefined,
      stage: sp.get("stage") || undefined,
      health: sp.get("health") || undefined,
      ownerId: sp.get("ownerId") ? Number(sp.get("ownerId")) : undefined,
      companyId: sp.get("companyId") ? Number(sp.get("companyId")) : undefined,
      includeArchived: sp.get("archived") === "1",
    })
    return NextResponse.json({ onboarding })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to load onboarding" },
      { status: onboardingErrorStatus(err) },
    )
  }
}

/** POST /api/sales/onboarding — create a relational onboarding record. */
export async function POST(request: Request) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!(await canCreateInModule(session, "sales.onboarding"))) {
    return NextResponse.json({ error: "You do not have permission to add onboarding records." }, { status: 403 })
  }

  const body = await request.json().catch(() => ({}))
  try {
    const fromContractId = body?.from_contract_id ? Number(body.from_contract_id) : null
    const record = fromContractId
      ? await createFromContract(fromContractId, session.userId)
      : await createOnboarding(body, session.userId)
    return NextResponse.json({ id: record.id, onboarding_code: record.onboarding_code, record })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Failed to create onboarding", details: (err as any)?.details },
      { status: onboardingErrorStatus(err) },
    )
  }
}

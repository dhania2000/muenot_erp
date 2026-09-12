import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canManageMaster, ensureHrMasterSchema, applyDuePromotions } from "@/lib/hr-master-data"

// Effective-date employee update job (spec §7, §39, §76).
//
// Applies every Approved promotion whose effective date has arrived to the
// employee master. Idempotent: rows already effected are skipped by the query,
// so repeated runs (manual button or a scheduler) are safe.
export async function POST() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canManageMaster(session))) {
    return NextResponse.json({ error: "You do not have permission to apply promotions." }, { status: 403 })
  }
  await ensureHrMasterSchema()

  try {
    const result = await applyDuePromotions(session)
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    console.log("[v0] applyDuePromotions failed", (error as Error).message)
    return NextResponse.json({ error: "Could not apply due promotions." }, { status: 500 })
  }
}

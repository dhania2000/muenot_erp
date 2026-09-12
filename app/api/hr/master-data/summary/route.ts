import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureHrMasterSchema, getMasterSummary } from "@/lib/hr-master-data"

// HR Master Data dashboard / data-quality summary (spec §33, §34, §69).
// Read access for any authenticated HR user; all figures come from real data.
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureHrMasterSchema()

  try {
    const summary = await getMasterSummary()
    return NextResponse.json(summary)
  } catch (error) {
    console.log("[v0] getMasterSummary failed", (error as Error).message)
    return NextResponse.json({ error: "Could not load summary." }, { status: 500 })
  }
}

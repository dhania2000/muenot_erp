import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listResources } from "@/lib/bulk-actions/registry"

/**
 * SPEC 85 — bulk-action catalog. Lists every registered resource and its
 * supported actions so a client can render the action menu generically. Gated
 * on an authenticated session only; per-resource feature gates are enforced at
 * submission time.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  return NextResponse.json({ resources: listResources() })
}

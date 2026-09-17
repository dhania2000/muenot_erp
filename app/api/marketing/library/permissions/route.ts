import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canUseLibrary, canManageLibrary } from "@/lib/library"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/marketing/library/permissions
 * Lightweight capability probe used by the client to decide whether to render
 * upload / manage affordances. Returns `canUse` (view) and `canManage`
 * (create/update/version/delete) for the current session.
 */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ canUse: false, canManage: false })
  const [canUse, canManage] = await Promise.all([canUseLibrary(session), canManageLibrary(session)])
  return NextResponse.json({ canUse, canManage })
}

import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listInboxForUser } from "@/lib/approval-authority"

/** Requests currently awaiting the signed-in user (directly or via delegation). */
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!getCurrentTenant()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const requests = await listInboxForUser(session.userId, { isAdmin: session.role === "admin" })
  return NextResponse.json({ requests })
}

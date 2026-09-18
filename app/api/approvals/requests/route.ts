import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { listRequests, type ApprovalRequestRecord } from "@/lib/approval-authority"

/** Tenant-wide request log. Admin-only (approvers use the inbox route). */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!getCurrentTenant()) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const status = url.searchParams.get("status") as ApprovalRequestRecord["status"] | null
  const moduleKey = url.searchParams.get("module")

  const requests = await listRequests({
    status: status ?? undefined,
    moduleKey: moduleKey ?? undefined,
  })
  return NextResponse.json({ requests })
}

import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getInbox } from "@/lib/collaboration/service"
import { collabErrorResponse } from "@/lib/collaboration/http"

export async function GET() {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    return NextResponse.json(await getInbox(auth.session, auth.tenantId))
  } catch (err) {
    return collabErrorResponse(err, "inbox")
  }
}

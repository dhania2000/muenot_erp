import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { getRecordActivity } from "@/lib/collaboration/service"
import { collabErrorResponse } from "@/lib/collaboration/http"

export async function GET(request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const { type, id } = await params
  const cursor = new URL(request.url).searchParams.get("cursor")
  try {
    return NextResponse.json(await getRecordActivity(auth.session, auth.tenantId, type, id, cursor))
  } catch (err) {
    return collabErrorResponse(err, "record activity")
  }
}

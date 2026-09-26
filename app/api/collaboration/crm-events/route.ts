import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { recordCrmCommunication } from "@/lib/collaboration/service"
import { collabErrorResponse, readJson } from "@/lib/collaboration/http"

export async function POST(request: Request) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  try {
    const result = await recordCrmCommunication(auth.session, auth.tenantId, await readJson(request))
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 })
  } catch (err) {
    return collabErrorResponse(err, "crm event")
  }
}

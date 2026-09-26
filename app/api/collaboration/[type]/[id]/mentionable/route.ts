import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { mentionCandidates } from "@/lib/collaboration/service"
import { collabErrorResponse } from "@/lib/collaboration/http"

export async function GET(request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const { type, id } = await params
  try {
    const q = new URL(request.url).searchParams.get("q")
    return NextResponse.json(await mentionCandidates(auth.session, auth.tenantId, type, id, q))
  } catch (err) {
    return collabErrorResponse(err, "mention candidates")
  }
}

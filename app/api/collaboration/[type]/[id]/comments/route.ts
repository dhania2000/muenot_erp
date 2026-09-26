import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { addComment } from "@/lib/collaboration/service"
import { collabErrorResponse, readJson } from "@/lib/collaboration/http"

export async function POST(request: Request, { params }: { params: Promise<{ type: string; id: string }> }) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const { type, id } = await params
  try {
    const body = (await readJson(request)) as Record<string, unknown>
    const headerKey = request.headers.get("idempotency-key")
    const input = headerKey && !body?.idempotencyKey ? { ...body, idempotencyKey: headerKey } : body
    const result = await addComment(auth.session, auth.tenantId, type, id, input)
    return NextResponse.json(result, { status: result.duplicate ? 200 : 201 })
  } catch (err) {
    return collabErrorResponse(err, "add comment")
  }
}

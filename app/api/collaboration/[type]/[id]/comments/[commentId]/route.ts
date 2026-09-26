import { NextResponse } from "next/server"
import { requireTenant } from "@/lib/api-auth"
import { deleteComment } from "@/lib/collaboration/service"
import { collabErrorResponse } from "@/lib/collaboration/http"

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ type: string; id: string; commentId: string }> },
) {
  const auth = await requireTenant()
  if (!auth) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  const { type, id, commentId } = await params
  try {
    return NextResponse.json(await deleteComment(auth.session, auth.tenantId, type, id, commentId))
  } catch (err) {
    return collabErrorResponse(err, "delete comment")
  }
}

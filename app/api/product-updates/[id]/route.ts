import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { captureAuditContext } from "@/lib/audit-log-store"
import { validateUpdateInput, ProductUpdateError } from "@/lib/product-updates/model"
import { updateUpdate, publishUpdate, setStatus, deleteUpdate } from "@/lib/product-updates/store"
import { isProductUpdateAuthor } from "@/lib/product-updates/guard"
import { NO_STORE, readJson, errorResponse } from "@/lib/spec32-http"

export const dynamic = "force-dynamic"

async function requireAuthor() {
  const session = await getSession()
  if (!session) return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE }) }
  if (!(await isProductUpdateAuthor(session))) return { error: NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE }) }
  return { session }
}

function parseId(raw: string): number {
  const id = Number(raw)
  if (!Number.isInteger(id) || id <= 0) throw new ProductUpdateError("Invalid update id", "INVALID_ID")
  return id
}

/** PATCH — { action: "publish" | "archive" | "draft" } or a full content edit. */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthor()
    if (auth.error) return auth.error
    const id = parseId((await params).id)
    const body = (await readJson(request)) as Record<string, unknown>
    const ctx = await captureAuditContext(request)
    const action = typeof body.action === "string" ? body.action : "update"

    if (action === "publish") {
      const res = await publishUpdate(id, ctx)
      return NextResponse.json({ changed: res.changed, update: res.update }, { headers: NO_STORE })
    }
    if (action === "archive" || action === "draft") {
      const res = await setStatus(id, action, ctx)
      return NextResponse.json({ changed: res.changed, update: res.update }, { headers: NO_STORE })
    }
    // Content edit.
    const input = validateUpdateInput(body)
    const update = await updateUpdate(id, { userId: auth.session.userId, name: auth.session.email }, input, ctx)
    return NextResponse.json({ update }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to update product update")
  }
}

/** DELETE — drafts only; published updates must be archived instead. */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const auth = await requireAuthor()
    if (auth.error) return auth.error
    const id = parseId((await params).id)
    const ctx = await captureAuditContext(request)
    const deleted = await deleteUpdate(id, ctx)
    return NextResponse.json({ deleted }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to delete product update")
  }
}

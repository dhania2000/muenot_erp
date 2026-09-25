import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { captureAuditContext } from "@/lib/audit-log-store"
import { validateUpdateInput, type UpdateStatus } from "@/lib/product-updates/model"
import { createUpdate, publishUpdate, listAll, listForViewer } from "@/lib/product-updates/store"
import { resolveViewer, isProductUpdateAuthor } from "@/lib/product-updates/guard"
import { NO_STORE, readJson, errorResponse } from "@/lib/spec32-http"

export const dynamic = "force-dynamic"

/**
 * GET  — default: the updates visible to the caller + unread count.
 *        ?scope=manage: the full authoring list (platform operators only).
 */
export async function GET(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })

    const url = new URL(request.url)
    if (url.searchParams.get("scope") === "manage") {
      if (!(await isProductUpdateAuthor(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE })
      const statusParam = url.searchParams.get("status")
      const status = statusParam && ["draft", "published", "archived"].includes(statusParam) ? (statusParam as UpdateStatus) : undefined
      const updates = await listAll({ status })
      return NextResponse.json({ updates }, { headers: NO_STORE })
    }

    const viewer = await resolveViewer(session)
    const { updates, unread } = await listForViewer(viewer, session.userId)
    return NextResponse.json({ updates, unread }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to load product updates")
  }
}

/** POST — create a release note (draft, or published when { publish: true }). */
export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })
    if (!(await isProductUpdateAuthor(session))) return NextResponse.json({ error: "Forbidden" }, { status: 403, headers: NO_STORE })

    const body = (await readJson(request)) as Record<string, unknown>
    const input = validateUpdateInput(body)
    const ctx = await captureAuditContext(request)
    const created = await createUpdate({ userId: session.userId, name: session.email }, input, ctx)
    if (body.publish === true) {
      const res = await publishUpdate(created.id, ctx)
      return NextResponse.json({ update: res.update }, { status: 201, headers: NO_STORE })
    }
    return NextResponse.json({ update: created }, { status: 201, headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to create product update")
  }
}

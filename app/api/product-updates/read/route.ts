import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { markRead, markAllRead } from "@/lib/product-updates/store"
import { resolveViewer } from "@/lib/product-updates/guard"
import { ProductUpdateError } from "@/lib/product-updates/model"
import { NO_STORE, readJson, errorResponse } from "@/lib/spec32-http"

export const dynamic = "force-dynamic"

/** POST — mark one update read ({ id }) or all currently-visible ({ all: true }). Idempotent. */
export async function POST(request: Request) {
  try {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })
    const viewer = await resolveViewer(session)
    const body = (await readJson(request)) as Record<string, unknown>

    if (body.all === true) {
      const count = await markAllRead(viewer, session.userId)
      return NextResponse.json({ markedRead: count }, { headers: NO_STORE })
    }

    const id = Number(body.id)
    if (!Number.isInteger(id) || id <= 0) throw new ProductUpdateError("Invalid update id", "INVALID_ID")
    const res = await markRead(id, viewer, session.userId)
    return NextResponse.json({ changed: res.changed }, { headers: NO_STORE })
  } catch (err) {
    return errorResponse(err, "Failed to update read state")
  }
}

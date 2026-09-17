import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { ensureCallsSchema } from "@/lib/calls-ensure"
import { isDnd, setDnd } from "@/lib/calls-core"

export const dynamic = "force-dynamic"

// GET /api/calls/dnd — my Do Not Disturb flag (Phase 42).
export async function GET() {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()
  return NextResponse.json({ dnd: await isDnd(session.userId) })
}

// POST /api/calls/dnd { dnd: boolean } — toggle Do Not Disturb.
export async function POST(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureCallsSchema()
  const body = await request.json().catch(() => ({}))
  await setDnd(session.userId, !!body.dnd)
  return NextResponse.json({ dnd: !!body.dnd })
}

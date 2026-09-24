import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { aggregateCalendar } from "@/lib/calendar/aggregate"

export const runtime = "nodejs"

/**
 * Central calendar feed for the signed-in employee (spec Phases 2, 14-16).
 *
 * Returns the unified, de-duplicated set of the user's OWN events: their ERP
 * source records (sales/operations/recruitment) merged with their personal
 * Google Calendar events. The response shape is a superset of the legacy
 * Google-only feed, so the client keeps working while gaining source/category
 * and per-event sync context.
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const url = new URL(request.url)
  const now = Date.now()
  const timeMin = url.searchParams.get("timeMin") || new Date(now - 45 * 864e5).toISOString()
  const timeMax = url.searchParams.get("timeMax") || new Date(now + 45 * 864e5).toISOString()

  const result = await aggregateCalendar({
    userId: session.userId,
    email: session.email,
    tenantId: session.tenantId ?? null,
    timeMin,
    timeMax,
  })

  return NextResponse.json(result)
}

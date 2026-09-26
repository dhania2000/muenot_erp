import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { canPerformAction } from "@/lib/permission-enforce"
import { loadConflictData } from "@/lib/resource-conflicts"
import { computeAvailability, isoDate } from "@/lib/resource-conflicts-model"

const MAX_WINDOW_DAYS = 366

export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  if (!(await canPerformAction(session, "operations.allocations", "view"))) {
    return NextResponse.json({ error: "You do not have permission to view allocations." }, { status: 403 })
  }
  const params = new URL(request.url).searchParams
  const today = new Date().toISOString().slice(0, 10)
  const from = params.get("from") ? isoDate(params.get("from")) : today
  const to = params.get("to") ? isoDate(params.get("to")) : from
  if (!from || !to) return NextResponse.json({ error: "from/to must be YYYY-MM-DD" }, { status: 400 })
  if (to < from) return NextResponse.json({ error: "to must be on or after from" }, { status: 400 })
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000
  if (days > MAX_WINDOW_DAYS) return NextResponse.json({ error: `Window cannot exceed ${MAX_WINDOW_DAYS} days` }, { status: 400 })
  try {
    const { allocations, leaves } = await loadConflictData(session)
    return NextResponse.json({ from, to, resources: computeAvailability(allocations, leaves, from, to) })
  } catch {
    return NextResponse.json({ error: "Failed to compute availability" }, { status: 500 })
  }
}

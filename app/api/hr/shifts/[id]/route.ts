import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { getSession } from "@/lib/auth"
import { ensureShiftSchema, getShiftAssignments, getShiftEvents, getAssignmentCounts } from "@/lib/hr-shifts"

/**
 * Detail view for one shift (keyed by numeric hr_shifts.id): the policy row plus
 * its real assignment usage, assignment history and change audit — all read from
 * their own masters so the Shift Master never duplicates that data.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const { id } = await params
  const shiftDbId = Number(id)
  if (!Number.isInteger(shiftDbId) || shiftDbId <= 0) {
    return NextResponse.json({ error: "Invalid shift id" }, { status: 400 })
  }

  await ensureShiftSchema()
  const rows = await query<any[]>("SELECT * FROM hr_shifts WHERE id = ? LIMIT 1", [shiftDbId])
  const shift = rows[0]
  if (!shift) return NextResponse.json({ error: "Shift not found" }, { status: 404 })

  const [assignments, events, counts] = await Promise.all([
    getShiftAssignments(shiftDbId),
    getShiftEvents(shiftDbId),
    getAssignmentCounts(),
  ])

  const usage = counts[shiftDbId] ?? { activeAssignments: 0, totalAssignments: 0, assignedEmployees: 0 }

  return NextResponse.json({ shift, usage, assignments, events })
}

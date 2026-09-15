import { NextRequest, NextResponse } from "next/server"
import { requireFeature, requireModuleAction } from "@/lib/api-auth"
import {
  complianceCalendar,
  listTdsReminders,
  runTdsReminderSweep,
  setReminderStatus,
} from "@/lib/finance-tds-automation"
import type { TdsDirection } from "@/lib/finance-tds-filing"

const FEATURE = "finance.tds_filing"
const MODULE = "finance.tds_filing"

function dirOf(value: unknown): TdsDirection {
  const s = String(value)
  if (s === "payable") return "payable"
  if (s === "employee") return "employee"
  return "receivable"
}

const REMINDER_STATUSES = ["open", "acknowledged", "done", "dismissed"] as const
type ReminderStatus = (typeof REMINDER_STATUSES)[number]
function reminderStatusOf(value: unknown): ReminderStatus | null {
  const s = String(value)
  return (REMINDER_STATUSES as readonly string[]).includes(s) ? (s as ReminderStatus) : null
}

export async function GET(req: NextRequest) {
  const session = await requireFeature(FEATURE)
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const params = req.nextUrl.searchParams
  const fy = params.get("fy")
  try {
    // Phase 32 — open reminder queue (direction-independent).
    if (params.get("reminders")) {
      const reminders = await listTdsReminders({ includeDone: params.get("all") === "1" })
      return NextResponse.json({ reminders })
    }
    // Phase 31 — compliance calendar for a financial year + direction.
    if (!fy) return NextResponse.json({ error: "financial year is required" }, { status: 400 })
    const calendar = await complianceCalendar(fy, dirOf(params.get("direction")))
    return NextResponse.json({ calendar })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  const session = await requireModuleAction(MODULE, "file_return")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  const body = await req.json().catch(() => ({}))
  const action = String(body.action || "sweep")
  try {
    // Phase 32 — acknowledge / dismiss / reopen a single reminder.
    if (action === "set_reminder_status") {
      const target = reminderStatusOf(body.status)
      if (!target) return NextResponse.json({ error: "Unknown reminder status." }, { status: 400 })
      const result = await setReminderStatus(String(body.reminder_id || ""), target, {
        actorId: session.userId,
        note: body.note ?? null,
      })
      return NextResponse.json({ ok: true, ...result })
    }

    // Phase 32 — idempotent reminder sweep across the requested financial year(s).
    const years: string[] = Array.isArray(body.financial_years)
      ? body.financial_years.map(String)
      : body.fy
        ? [String(body.fy)]
        : []
    if (years.length === 0) return NextResponse.json({ error: "financial year is required" }, { status: 400 })
    const result = await runTdsReminderSweep(years, { actorId: session.userId })
    return NextResponse.json({ ok: true, ...result })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

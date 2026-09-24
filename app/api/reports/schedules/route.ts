import { NextResponse } from "next/server"
import { requireTenantAdmin, effectiveTenantId } from "@/lib/platform-guard"
import { listReports, type Actor } from "@/lib/reports/store"
import { createReportSchedule, listReportSchedules } from "@/lib/reports/scheduler-store"
import {
  CHANNEL_LABELS,
  DELIVERY_CHANNELS,
  DELIVERY_FORMATS,
  FORMAT_LABELS,
  FREQUENCY_LABELS,
  SCHEDULE_FREQUENCIES,
  SCHEDULER_CAPS,
} from "@/lib/reports/scheduler-model"

export const runtime = "nodejs"

const metadata = {
  frequencies: SCHEDULE_FREQUENCIES.map((f) => ({ value: f, label: FREQUENCY_LABELS[f] })),
  formats: DELIVERY_FORMATS.map((f) => ({ value: f, label: FORMAT_LABELS[f] })),
  channels: DELIVERY_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
  caps: SCHEDULER_CAPS,
}

export async function GET() {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const [schedules, reports] = await Promise.all([listReportSchedules(tenantId), listReports(tenantId)])
  return NextResponse.json({
    schedules,
    reports: reports.map((r) => ({ id: r.id, name: r.name, sourceKey: r.sourceKey })),
    metadata,
  })
}

export async function POST(request: Request) {
  const guard = await requireTenantAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const tenantId = effectiveTenantId(guard.ctx)

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 })

  const actor: Actor = {
    userId: guard.session.userId,
    name: guard.session.name ?? null,
    email: guard.session.email ?? null,
    role: guard.ctx.tenantRole,
  }

  try {
    const schedule = await createReportSchedule(
      tenantId,
      {
        reportId: body.reportId,
        frequency: body.frequency,
        format: body.format,
        channel: body.channel,
        recipients: body.recipients,
        timezone: body.timezone,
        cadence: body.cadence,
        customCron: body.customCron,
      },
      actor,
    )
    return NextResponse.json({ schedule }, { status: 201 })
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 })
  }
}

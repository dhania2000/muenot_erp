import { NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import {
  archiveOnboarding,
  addNote,
  changeStage,
  changeStatus,
  completeOnboarding,
  getOnboardingDetail,
  handoverOnboarding,
  onboardingErrorStatus,
  recordGoLive,
  reopenOnboarding,
  restoreOnboarding,
  scheduleKickoff,
  type OnboardingStage,
  type OnboardingStatus,
} from "@/lib/sales/onboarding-service"

/**
 * Single dispatcher for every onboarding lifecycle transition and workflow.
 * Body: { action: "stage" | "status" | "complete" | "reopen" | "handover" |
 *         "go-live" | "schedule-kickoff" | "archive" | "restore" | "note", ... }
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireFeature("sales.manage_onboarding")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const { id } = await params
  const onboardingId = Number(id)
  const body = await request.json().catch(() => ({}))
  const action = String(body.action || "")
  const actor = session.userId
  const opts = {
    reason: body.reason,
    expected_resume_date: body.expected_resume_date,
    expectedRowVersion: body.expectedRowVersion,
    override: body.override,
  }

  try {
    switch (action) {
      case "stage":
        await changeStage(onboardingId, body.stage as OnboardingStage, opts, actor)
        break
      case "status":
        await changeStatus(onboardingId, body.status as OnboardingStatus, opts, actor)
        break
      case "complete":
        await completeOnboarding(onboardingId, opts, actor)
        break
      case "reopen":
        await reopenOnboarding(onboardingId, opts, actor)
        break
      case "handover":
        await handoverOnboarding(
          onboardingId,
          {
            handover_to_id: Number(body.handover_to_id),
            notes: body.notes,
            reassign: body.reassign,
            expectedRowVersion: body.expectedRowVersion,
          },
          actor,
        )
        break
      case "go-live":
        await recordGoLive(
          onboardingId,
          { go_live_date: body.go_live_date, notes: body.notes, expectedRowVersion: body.expectedRowVersion },
          actor,
        )
        break
      case "schedule-kickoff":
        await scheduleKickoff(
          onboardingId,
          {
            meeting_date: body.meeting_date,
            meeting_time: body.meeting_time,
            duration_minutes: body.duration_minutes,
            agenda: body.agenda,
            location: body.location,
            attendees: body.attendees,
            create_google_meet: body.create_google_meet,
          },
          actor,
        )
        break
      case "archive":
        await archiveOnboarding(onboardingId, actor)
        break
      case "restore":
        await restoreOnboarding(onboardingId, actor)
        break
      case "note":
        if (!body.body?.trim()) return NextResponse.json({ error: "A note body is required" }, { status: 400 })
        await addNote(onboardingId, body.body.trim(), actor)
        break
      default:
        return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
    }
    const detail = await getOnboardingDetail(onboardingId)
    return NextResponse.json({ success: true, onboarding: detail })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error)?.message || "Action failed", details: (err as any)?.details },
      { status: onboardingErrorStatus(err) },
    )
  }
}

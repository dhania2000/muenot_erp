import { NextRequest, NextResponse } from "next/server"
import { requirePlatformSuperAdmin } from "@/lib/platform-guard"
import { cancelBackgroundJob } from "@/lib/background-jobs"

export const dynamic = "force-dynamic"

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requirePlatformSuperAdmin()
  if (!guard.ok) return NextResponse.json({ error: guard.reason }, { status: guard.status })
  const { id } = await params
  const jobId = Number(id)
  if (!Number.isInteger(jobId) || jobId < 1) return NextResponse.json({ error: "Invalid job id" }, { status: 400 })
  try {
    const job = await cancelBackgroundJob(jobId)
    if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 })
    return NextResponse.json({ ok: true, job })
  } catch (error) {
    console.error("[background-jobs] cancel failed", error)
    return NextResponse.json({ error: "Unable to cancel background job" }, { status: 500 })
  }
}

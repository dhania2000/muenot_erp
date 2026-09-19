import { NextRequest, NextResponse } from "next/server"
import {
  claimCronRun,
  ensureCronJobSchema,
  finishCronRun,
  isCronConfigDue,
  listCronJobs,
  updateCronRunAttempt,
} from "@/lib/cron-jobs"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return process.env.NODE_ENV !== "production"
  return request.headers.get("authorization") === `Bearer ${secret}`
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!)
}

async function runOne(job: Awaited<ReturnType<typeof listCronJobs>>[number], request: NextRequest) {
  const claim = await claimCronRun(job)
  if (!claim) return { key: job.key, status: "skipped" as const }
  const startedAt = Date.now()
  let lastError: string | null = null
  const attempts = job.retry_limit + 1
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await updateCronRunAttempt(claim.id, attempt)
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), job.timeout_seconds * 1000)
      try {
        const base = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || new URL(request.url).origin
        const headers: HeadersInit = { "cache-control": "no-store", "x-muenot-cron-dispatcher": "1" }
        if (process.env.CRON_SECRET) headers.authorization = `Bearer ${process.env.CRON_SECRET}`
        const response = await fetch(new URL(job.endpoint, base), { method: "GET", headers, signal: controller.signal, cache: "no-store" })
        if (!response.ok) throw new Error(`Job endpoint returned HTTP ${response.status}`)
      } finally {
        clearTimeout(timer)
      }
      await finishCronRun(claim.id, "succeeded", startedAt, null)
      return { key: job.key, status: "succeeded" as const }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Unknown job error"
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** (attempt - 1))))
    }
  }
  await finishCronRun(claim.id, "failed", startedAt, lastError)
  console.error(`[cron-dispatcher] ${job.key} failed after ${attempts} attempt(s): ${lastError}`)
  if (job.notify_on_failure) {
    try {
      const { recordActivity } = await import("@/lib/notifications")
      await recordActivity({
        action: "update",
        title: `Scheduled job failed: ${job.name}`,
        body: `${lastError ?? "Unknown error"} (${attempts} attempt(s))`,
        link: "/platform/cron-jobs",
      })
      if (job.notification_emails) {
        const { sendEmail } = await import("@/lib/email")
        const safeError = escapeHtml(lastError ?? "Unknown error")
        for (const to of job.notification_emails.split(",").map((email) => email.trim()).filter(Boolean)) {
          await sendEmail({
            to,
            subject: `Muenot scheduled job failed: ${job.name}`,
            html: `<p>The scheduled job <strong>${escapeHtml(job.name)}</strong> failed after ${attempts} attempt(s).</p><p>${safeError}</p>`,
          }).catch((error) => console.error("[cron-dispatcher] failure email failed", error))
        }
      }
    } catch (error) {
      console.error("[cron-dispatcher] failure notification failed", error)
    }
  }
  return { key: job.key, status: "failed" as const, error: lastError }
}

export async function GET(request: NextRequest) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  try {
    await ensureCronJobSchema()
    const jobs = (await listCronJobs()).filter((job) => isCronConfigDue(job))
    const results = []
    for (const job of jobs) results.push(await runOne(job, request))
    return NextResponse.json({ ok: true, considered: jobs.length, results })
  } catch (error) {
    console.error("[cron-dispatcher] failed", error)
    return NextResponse.json({ error: "Scheduler dispatch failed" }, { status: 500 })
  }
}

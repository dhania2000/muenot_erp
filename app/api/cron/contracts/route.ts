import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { runExpiryScheduler } from "@/lib/sales/contract-service"
import { runContractScheduler } from "@/lib/legal-contracts-scheduler"

export const runtime = "nodejs"

/**
 * Contract expiry + renewal / review / approval scheduler.
 *
 * Runs unattended via Vercel Cron (see vercel.json) authenticated with the
 * shared `CRON_SECRET` Bearer token. Also runnable on demand by a signed-in
 * user so a button in the UI can trigger a manual sweep. Covers BOTH the Sales
 * contracts module and the Legal contracts module. Every pass is idempotent.
 */
function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return true
  return request.headers.get("authorization") === `Bearer ${secret}`
}

async function handle(request: Request) {
  const isCron = authorized(request)
  if (!isCron) {
    const session = await getSession()
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  const [sales, legal] = await Promise.all([
    runExpiryScheduler(30).catch((error) => {
      console.error("[v0] sales expiry scheduler failed:", (error as Error).message)
      return { expired: 0, warned: 0 }
    }),
    runContractScheduler().catch((error) => {
      console.error("[v0] legal contract scheduler failed:", (error as Error).message)
      return {
        expired: 0,
        expiryReminders: 0,
        renewalReminders: 0,
        reviewReminders: 0,
        approvalReminders: 0,
      }
    }),
  ])
  return NextResponse.json({ success: true, sales, legal })
}

export async function GET(request: Request) {
  return handle(request)
}

export async function POST(request: Request) {
  return handle(request)
}

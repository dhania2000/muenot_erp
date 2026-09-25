import { NextResponse } from "next/server"
import { sweepAllTenants } from "@/lib/customer-success/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 300

/** Spec31 (#174-175) — nightly retention purge + daily health snapshot per active tenant. */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret ? process.env.NODE_ENV === "production" : request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    return NextResponse.json({ ok: true, ...(await sweepAllTenants()) })
  } catch (error) {
    console.error("[customer-success] sweep failed", error)
    return NextResponse.json({ error: "Customer success sweep failed" }, { status: 500 })
  }
}

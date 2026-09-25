import { NextResponse } from "next/server"
import { dayOf } from "@/lib/partners/model"
import { settleCommissions } from "@/lib/partners/store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/** Spec29 (#172) — Daily partner commission settlement (idempotent per invoice). */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret ? process.env.NODE_ENV === "production" : request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  try {
    const result = await settleCommissions(dayOf(new Date())!, null)
    return NextResponse.json({ ok: true, settled: result.settled.length, skipped: result.skipped.length, failed: result.failed.length })
  } catch (error) {
    console.error("[partner-settlement] run failed", error)
    return NextResponse.json({ error: "Partner settlement failed" }, { status: 500 })
  }
}

import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { traceVoucher } from "@/lib/finance-journal-trace"

export const runtime = "nodejs"

/**
 * Phase 53 — traceability drill for one voucher.
 * GET /api/finance/journal-entries/trace?voucher=VCH-0001
 * Returns the Source → Journal → GL → Report chain (read-only).
 */
export async function GET(request: Request) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const voucher = new URL(request.url).searchParams.get("voucher") ?? ""
  if (!voucher.trim()) return NextResponse.json({ error: "voucher is required" }, { status: 400 })

  try {
    const trace = await traceVoucher(voucher)
    if (!trace) return NextResponse.json({ error: "Voucher not found" }, { status: 404 })
    return NextResponse.json({ trace })
  } catch (error) {
    console.log("[v0] journal trace failed:", (error as Error)?.message)
    return NextResponse.json({ error: "Failed to build trace" }, { status: 500 })
  }
}

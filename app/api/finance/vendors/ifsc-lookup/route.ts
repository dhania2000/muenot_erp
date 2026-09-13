import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { lookupIfsc, normalizeIfsc } from "@/lib/ifsc"

/**
 * Server-side IFSC → bank/branch resolution for the Vendor master banking block.
 * The browser sends the IFSC and receives a normalized bank name + branch it can
 * drop straight into the form. `autofill` is keyed generically (bank/branch) so
 * the client maps it onto whichever fields the module config points at.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const raw = req.nextUrl.searchParams.get("ifsc")
  if (!raw) return NextResponse.json({ error: "ifsc is required" }, { status: 400 })

  const result = await lookupIfsc(raw)

  const autofill: Record<string, string> = {}
  if (result.ok && result.data) {
    if (result.data.bank) autofill.bank = result.data.bank
    // Prefer the named branch; fall back to city so the field is never blank.
    const branch = result.data.branch || result.data.city
    if (branch) autofill.branch = branch
  }

  return NextResponse.json({
    result: {
      state: result.state,
      ok: result.ok,
      message: result.message ?? null,
      ifsc: result.ok ? normalizeIfsc(raw) : null,
      cached: result.cached ?? false,
    },
    data: result.data ?? null,
    autofill,
  })
}

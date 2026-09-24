import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { convert, getBaseCurrency, RateNotFoundError } from "@/lib/currency/model"

export const runtime = "nodejs"

/**
 * SPEC 159 — currency conversion.
 * GET /api/finance/currency/convert?amount=100&from=USD&to=INR&date=2026-01-31
 *   Resolves the QUOTE->BASE rate (direct / inverse / triangulated through the
 *   tenant base currency) effective on `date` and returns the rounded amount.
 *   `to` defaults to the tenant base currency.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const amount = Number(sp.get("amount"))
  const from = sp.get("from")
  const to = sp.get("to") || (await getBaseCurrency())
  const date = sp.get("date") || undefined

  if (!Number.isFinite(amount)) return NextResponse.json({ error: "amount is required" }, { status: 400 })
  if (!from) return NextResponse.json({ error: "from currency is required" }, { status: 400 })

  try {
    const result = await convert(amount, from, to, date)
    return NextResponse.json(result)
  } catch (error) {
    if (error instanceof RateNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 })
    }
    throw error
  }
}

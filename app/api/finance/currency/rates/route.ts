import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { listRates, upsertRate, getBaseCurrency, CurrencyValidationError } from "@/lib/currency/model"

export const runtime = "nodejs"

/**
 * SPEC 159 — exchange-rate history.
 * GET  : list stored rates (optional quote/base/from/to filters).
 * POST : upsert a rate for a (quote -> base, date) key.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const rates = await listRates({
    quoteCurrency: sp.get("quote") ?? undefined,
    baseCurrency: sp.get("base") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  })
  const baseCurrency = await getBaseCurrency()
  return NextResponse.json({ baseCurrency, rates })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  try {
    const rate = await upsertRate(
      {
        quoteCurrency: body?.quoteCurrency,
        baseCurrency: body?.baseCurrency,
        rate: Number(body?.rate),
        rateDate: body?.rateDate,
        source: body?.source,
        note: body?.note,
      },
      { userId: session.userId, name: session.name },
    )
    return NextResponse.json({ rate })
  } catch (error) {
    if (error instanceof CurrencyValidationError) {
      return NextResponse.json({ error: error.message }, { status: 400 })
    }
    throw error
  }
}

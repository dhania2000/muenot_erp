import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import {
  listTaxRates,
  listHsnSac,
  listProducts,
  createMaster,
  updateMaster,
  deleteMaster,
  masterTable,
} from "@/lib/finance-masters"

/**
 * CRUD for the three finance masters (tax rates, HSN/SAC, product/service).
 * The `type` query/body param selects which master. A GET with no type returns
 * all three at once, which is what the invoice dialog loads for its selects.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const p = req.nextUrl.searchParams
  const type = p.get("type")
  const search = p.get("search") || ""

  if (type === "tax") return NextResponse.json({ rows: await listTaxRates(false) })
  if (type === "hsn") return NextResponse.json({ rows: await listHsnSac(search, false) })
  if (type === "product") return NextResponse.json({ rows: await listProducts(search, false) })

  // Bundle for the invoice editor: only active rows.
  const [taxRates, hsnSac, products] = await Promise.all([listTaxRates(), listHsnSac(search), listProducts(search)])
  return NextResponse.json({ taxRates, hsnSac, products })
}

export async function POST(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json()
  const type = String(body.type || "")
  if (!masterTable(type)) return NextResponse.json({ error: "Unknown master type" }, { status: 400 })
  try {
    const id = await createMaster(type, body)
    return NextResponse.json({ ok: true, id }, { status: 201 })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const body = await req.json()
  const type = String(body.type || "")
  const id = Number(body.id)
  if (!masterTable(type)) return NextResponse.json({ error: "Unknown master type" }, { status: 400 })
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
  try {
    await updateMaster(type, id, body)
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const p = req.nextUrl.searchParams
  const type = String(p.get("type") || "")
  const id = Number(p.get("id"))
  if (!masterTable(type)) return NextResponse.json({ error: "Unknown master type" }, { status: 400 })
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
  await deleteMaster(type, id)
  return NextResponse.json({ ok: true })
}

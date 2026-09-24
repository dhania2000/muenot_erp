import { NextResponse } from "next/server"
import { getPortalSession } from "@/lib/portal/auth"
import { clientCanAccess } from "@/lib/portal/access"
import { createClientOrder, getPortalCatalogByIds, type PortalOrderLineItem } from "@/lib/portal/store"

// Sane guard rails so a client cannot request absurd quantities.
const MAX_LINE_QTY = 100000
const MAX_TOTAL_QTY = 1000000

/**
 * SPEC 117 / 118 — a CLIENT places an order from the portal.
 *
 * tenant_id and client_id are taken exclusively from the verified portal
 * session, never from request input. The client must have the `orders`
 * resource granted (fail-closed) before an order can be created.
 */
export async function POST(request: Request) {
  const session = await getPortalSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const allowed = await clientCanAccess(session.tenantId, session.clientId, "orders")
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json().catch(() => null)
  const description = body?.description != null ? String(body.description).trim() : null

  // ── Catalog-based order ────────────────────────────────────────────────────
  // When the client picks products, we IGNORE any client-supplied prices and
  // re-price every line from the product master server-side, then recompute the
  // total. Quantities are validated per line and in aggregate.
  const rawItems = Array.isArray(body?.items) ? body.items : []
  if (rawItems.length > 0) {
    const requested = new Map<number, number>()
    for (const raw of rawItems) {
      const productId = Number(raw?.productId ?? raw?.id)
      const quantity = Number(raw?.quantity)
      if (!Number.isInteger(productId) || productId <= 0) {
        return NextResponse.json({ error: "Invalid product in the order" }, { status: 400 })
      }
      if (!Number.isInteger(quantity) || quantity <= 0 || quantity > MAX_LINE_QTY) {
        return NextResponse.json({ error: "Each product needs a valid quantity" }, { status: 400 })
      }
      requested.set(productId, (requested.get(productId) ?? 0) + quantity)
    }

    const totalQty = Array.from(requested.values()).reduce((a, b) => a + b, 0)
    if (totalQty > MAX_TOTAL_QTY) {
      return NextResponse.json({ error: "That order is too large — please contact us directly" }, { status: 400 })
    }

    const products = await getPortalCatalogByIds(Array.from(requested.keys()))
    const byId = new Map(products.map((p) => [p.id, p]))
    if (byId.size !== requested.size) {
      return NextResponse.json(
        { error: "One or more products are no longer available. Please refresh and try again." },
        { status: 400 },
      )
    }

    const items: PortalOrderLineItem[] = []
    for (const [productId, quantity] of requested) {
      const product = byId.get(productId)!
      const unitPrice = Math.round(Number(product.selling_price) * 100) / 100
      items.push({
        productId,
        productCode: product.product_code,
        name: product.name,
        unit: product.unit,
        quantity,
        unitPrice,
        lineTotal: Math.round(unitPrice * quantity * 100) / 100,
      })
    }

    const distinct = items.length
    const title =
      distinct === 1
        ? `${items[0].name}${items[0].quantity > 1 ? ` × ${items[0].quantity}` : ""}`
        : `${distinct} products (${totalQty} items)`

    const id = await createClientOrder({
      tenantId: session.tenantId,
      clientId: session.clientId,
      portalUserId: session.portalUserId,
      authorName: session.name,
      title: title.slice(0, 200),
      description,
      currency: "INR",
      items,
    })

    return NextResponse.json({ ok: true, id }, { status: 201 })
  }

  // ── Free-text order (legacy fallback) ───────────────────────────────────────
  const title = String(body?.title ?? "").trim()
  const currency = body?.currency != null ? String(body.currency).trim().toUpperCase().slice(0, 10) : null

  let amount: number | null = null
  if (body?.amount != null && body.amount !== "") {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n < 0) {
      return NextResponse.json({ error: "Enter a valid amount" }, { status: 400 })
    }
    amount = Math.round(n * 100) / 100
  }

  if (!title) return NextResponse.json({ error: "A short order summary is required" }, { status: 400 })
  if (title.length > 200) return NextResponse.json({ error: "Summary is too long" }, { status: 400 })

  const id = await createClientOrder({
    tenantId: session.tenantId,
    clientId: session.clientId,
    portalUserId: session.portalUserId,
    authorName: session.name,
    title,
    description,
    amount,
    currency,
  })

  return NextResponse.json({ ok: true, id }, { status: 201 })
}

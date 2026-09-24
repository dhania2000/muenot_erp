import { NextResponse } from "next/server"
import { getVendorPortalSession } from "@/lib/vendor-portal/auth"
import { vendorCanAccess } from "@/lib/vendor-portal/access"
import { submitVendorInvoice } from "@/lib/vendor-portal/store"

export const runtime = "nodejs"

/**
 * SPEC 119 — Vendor Portal · invoice submission workflow (Phase 3).
 * The one place a vendor can CREATE a record. tenant + vendor + author always
 * come from the verified session; the amount is validated and clamped
 * server-side. The stored row is flagged meta.source='vendor_submission' with
 * status 'Submitted' so AP staff can review before approving.
 */
export async function POST(request: Request) {
  const session = await getVendorPortalSession()
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 })
  if (!(await vendorCanAccess(session.tenantId, session.vendorId, "invoices"))) {
    return NextResponse.json({ error: "Not permitted" }, { status: 403 })
  }

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid request" }, { status: 400 })

  const title = String(body.title ?? "").trim()
  if (!title) return NextResponse.json({ error: "An invoice number or title is required" }, { status: 400 })

  const reference = body.reference != null ? String(body.reference).trim().slice(0, 80) || null : null
  const description = body.description != null ? String(body.description).trim().slice(0, 2000) || null : null
  const currency = body.currency != null ? String(body.currency).trim().slice(0, 10) || null : "INR"

  // Server-side amount validation: positive, finite, sane upper bound.
  let amount: number | null = null
  if (body.amount != null && body.amount !== "") {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n <= 0) {
      return NextResponse.json({ error: "Amount must be a positive number" }, { status: 400 })
    }
    if (n > 1_000_000_000) {
      return NextResponse.json({ error: "Amount is too large" }, { status: 400 })
    }
    amount = Math.round(n * 100) / 100
  }

  const issueDate = normalizeDate(body.issueDate)
  const dueDate = normalizeDate(body.dueDate)

  const id = await submitVendorInvoice({
    tenantId: session.tenantId,
    vendorId: session.vendorId,
    portalUserId: session.portalUserId,
    authorName: session.name,
    reference,
    title: title.slice(0, 200),
    description,
    amount,
    currency,
    issueDate,
    dueDate,
  })

  return NextResponse.json({ id, ok: true }, { status: 201 })
}

/** Accept an ISO date (YYYY-MM-DD) or return null. */
function normalizeDate(value: unknown): string | null {
  if (!value) return null
  const s = String(value).trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : s
}

import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { query } from "@/lib/db"
import { logFinanceEvent } from "@/lib/finance-audit"
import {
  verifyGstin,
  normalizeGstin,
  panFromGstin,
  registrationTypeFromTaxpayer,
  verificationStatusLabel,
} from "@/lib/gstin"

/**
 * Server-side GSTIN verification for the Customer / Vendor master. The API key
 * stays on the server; the browser only ever sees the normalized result. The
 * response is split into:
 *   - `autofill`  visible vendor fields (name, PAN, address, state, ...) that
 *                 the form fills when empty and offers as a conflict when set.
 *   - `meta`      server-authoritative snapshot fields stored on the record.
 *   - `duplicate` an existing party already using the same GSTIN, if any.
 */
export async function GET(req: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const raw = req.nextUrl.searchParams.get("gstin")
  if (!raw) return NextResponse.json({ error: "gstin is required" }, { status: 400 })

  const gstin = normalizeGstin(raw)
  const excludeId = Number(req.nextUrl.searchParams.get("exclude_id")) || 0

  const result = await verifyGstin(gstin)

  // Duplicate check runs regardless of provider outcome so the user is warned
  // even while the network call is degraded.
  let duplicate: { id: number; party_id: string; customer_name: string } | null = null
  try {
    const rows = (await query(
      `SELECT id, party_id, customer_name FROM customers_vendors
        WHERE UPPER(gstin) = ? AND id <> ? LIMIT 1`,
      [gstin, excludeId],
    )) as any[]
    if (rows.length) {
      duplicate = {
        id: Number(rows[0].id),
        party_id: rows[0].party_id,
        customer_name: rows[0].customer_name,
      }
    }
  } catch {
    // Non-fatal: verification is still useful without the duplicate hint.
  }

  let autofill: Record<string, string> = {}
  let meta: Record<string, string> = {}
  let suggestedName: string | null = null

  if (result.ok && result.data) {
    const d = result.data
    suggestedName = d.tradeName || d.legalName || null
    const pan = panFromGstin(gstin)
    const regType = registrationTypeFromTaxpayer(d.taxpayerType)

    autofill = clean({
      legal_name: d.legalName,
      pan: pan,
      state: d.stateName,
      state_code: d.stateCode,
      city: d.city,
      pin_code: d.pincode,
      billing_address: d.address,
      gst_registration_type: regType,
    })

    meta = clean({
      gst_trade_name: d.tradeName,
      gst_status: d.status,
      gst_taxpayer_type: d.taxpayerType,
      business_constitution: d.businessConstitution,
      gst_registration_date: d.registrationDate,
      gst_cancellation_date: d.cancellationDate,
      gst_block_status: d.blockStatus,
      gst_verification_status: verificationStatusLabel(result),
      gst_verified_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      gst_verification_source: "gstinapi.in",
    })
  } else if (result.state === "invalid" || result.state === "not_found") {
    // Record the authoritative negative status so the badge reflects reality.
    meta = clean({
      gst_verification_status: verificationStatusLabel(result),
      gst_verified_at: new Date().toISOString().slice(0, 19).replace("T", " "),
      gst_verification_source: "gstinapi.in",
    })
  }

  // Best-effort audit trail; never blocks the response.
  void logFinanceEvent({
    entityType: "customer_vendor",
    entityPk: excludeId || null,
    entityRef: gstin,
    type: "override",
    summary: `GSTIN verification: ${verificationStatusLabel(result)}`,
    detail: { state: result.state, status: result.data?.status ?? null, cached: result.cached },
    actorId: session.userId,
  })

  return NextResponse.json({
    result: {
      state: result.state,
      ok: result.ok,
      message: result.message,
      gstin: result.gstin,
      status: result.data?.status ?? null,
      verificationStatus: verificationStatusLabel(result),
      creditsRemaining: result.creditsRemaining,
      cached: result.cached,
    },
    suggestedName,
    autofill,
    meta,
    duplicate,
  })
}

/** Drop null/empty values so the client only receives fillable strings. */
function clean(obj: Record<string, string | null | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null && v !== undefined && String(v).trim() !== "") out[k] = String(v)
  }
  return out
}

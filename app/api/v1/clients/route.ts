import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { authenticateApiKey, hasScope } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import { emitWebhookEvent } from "@/lib/webhooks/dispatcher"
import {
  ensureClientTables,
  isValidEmail,
  isValidGstin,
  isValidPan,
  normalizeEmail,
  normalizeGstin,
  normalizePan,
  panFromGstin,
  stateCodeFromGstin,
} from "@/lib/clients-db"

/**
 * SPEC 67 — Public API surface for third-party integrations.
 * ---------------------------------------------------------------------------
 * Authenticated with a Bearer API key (see lib/api-auth.ts) rather than the
 * browser session cookie used by app/api/clients/route.ts. Scoped strictly
 * by the key's granted scopes (`clients:read` / `clients:write`) — an admin
 * session role is not consulted here, only what the key itself was issued.
 * Tenant isolation is derived from the key's owning tenant, never from the
 * request body.
 */

const ALLOWED = new Set([
  "client_name","email","mobile","company_name","website","gst_number","address","city","state",
  "country","postal_code","category","currency","status","notes","client_type","payment_terms_days","credit_limit",
])

function unauthorized() {
  return NextResponse.json({ error: "Missing or invalid API key" }, { status: 401 })
}

export async function GET(request: Request) {
  const auth = await authenticateApiKey(request)
  if (!auth) return unauthorized()
  if (!hasScope(auth, "clients:read")) return NextResponse.json({ error: "Key lacks clients:read scope" }, { status: 403 })

  await ensureClientTables()
  const url = new URL(request.url)
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 50) || 50, 200)

  const clients = await query(
    `SELECT client_code, client_name, display_name, email, mobile, company_name, status, client_type, created_at
       FROM clients WHERE tenant_id = ? AND archived_at IS NULL ORDER BY created_at DESC LIMIT ?`,
    [auth.tenantId, limit],
  )
  return NextResponse.json({ clients })
}

function validate(body: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!String(body.client_name ?? "").trim()) errors.client_name = "client_name is required"
  if (!String(body.email ?? "").trim()) errors.email = "email is required"
  else if (!isValidEmail(body.email)) errors.email = "email is invalid"
  if (body.gst_number && !isValidGstin(body.gst_number)) errors.gst_number = "gst_number is invalid"
  if (body.pan && !isValidPan(body.pan)) errors.pan = "pan is invalid"
  return errors
}

export async function POST(request: Request) {
  const auth = await authenticateApiKey(request)
  if (!auth) return unauthorized()
  if (!hasScope(auth, "clients:write")) return NextResponse.json({ error: "Key lacks clients:write scope" }, { status: 403 })

  await ensureClientTables()
  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })

  const errors = validate(body)
  if (Object.keys(errors).length > 0) return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })

  const gstin = normalizeGstin(body.gst_number)
  const pan = normalizePan(body.pan) || panFromGstin(gstin)
  const email = normalizeEmail(body.email)
  const companyName = String(body.company_name ?? "").trim() || null
  const clientName = String(body.client_name ?? "").trim()
  const clientType = body.client_type === "Individual" || (!companyName && !body.client_type) ? "Individual" : "Company"

  const payload: Record<string, any> = {}
  for (const key of Object.keys(body)) {
    if (ALLOWED.has(key)) payload[key] = body[key] === "" ? null : body[key]
  }
  payload.gst_number = gstin
  payload.pan = pan
  payload.email = email
  payload.display_name = companyName || clientName
  payload.legal_name = companyName
  payload.client_type = clientType
  payload.state_code = stateCodeFromGstin(gstin)

  const clientCode = await nextRecordId("CLI")
  const fields = ["client_code", ...Object.keys(payload)]
  const values = [clientCode, ...Object.keys(payload).map((k) => payload[k])]

  await query(
    `INSERT INTO clients (${fields.join(",")},tenant_id) VALUES (${fields.map(() => "?").join(",")},?)`,
    [...values, auth.tenantId],
  )

  await recordAudit(null, {
    entityType: "client",
    entityId: clientCode,
    action: "created",
    summary: `Client ${payload.display_name} created via API`,
    meta: { source: "public_api", apiKeyId: auth.keyId },
    actorId: null,
  })

  void emitWebhookEvent(auth.tenantId, "client.created", {
    client_code: clientCode,
    client_name: clientName,
    email,
    company_name: companyName,
  })

  return NextResponse.json({ ok: true, client_code: clientCode }, { status: 201 })
}

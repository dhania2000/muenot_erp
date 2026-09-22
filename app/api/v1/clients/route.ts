import { query } from "@/lib/db"
import { nextRecordId } from "@/lib/record-ids"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import { emitWebhookEvent } from "@/lib/webhooks/dispatcher"
import { withApiV1 } from "@/lib/api-platform/handler"
import { jsonOk } from "@/lib/api-platform/response"
import { validationError } from "@/lib/api-platform/errors"
import { parseListQuery, buildWhere, buildOrderBy } from "@/lib/api-platform/query"
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
 * SPEC 67 + SPEC 51 — Public API surface for third-party integrations.
 * ---------------------------------------------------------------------------
 * Runs through the shared `withApiV1` pipeline (lib/api-platform/handler.ts),
 * which applies versioning, Bearer API-key auth, per-key IP restrictions,
 * scope authorization, rate limiting, idempotency, request IDs, standardized
 * errors, and audit logging BEFORE this handler ever runs. Tenant isolation is
 * derived from the key's owning tenant (ctx.auth.tenantId), never from request
 * input. This route only expresses its own business logic + validation.
 */

const ALLOWED = new Set([
  "client_name", "email", "mobile", "company_name", "website", "gst_number", "address", "city", "state",
  "country", "postal_code", "category", "currency", "status", "notes", "client_type", "payment_terms_days", "credit_limit",
])

const SORTABLE = ["created_at", "client_name", "status", "client_type"] as const
const FILTERABLE = ["status", "client_type", "category"] as const

export const GET = withApiV1({ scopes: "clients:read" }, async (ctx) => {
  await ensureClientTables()

  const { pagination, sort, filters } = parseListQuery(ctx.url, {
    sortable: SORTABLE,
    filterable: FILTERABLE,
    defaultSort: "-created_at",
  })

  const where = buildWhere(filters)
  const whereClause = ["tenant_id = ?", "archived_at IS NULL", where.clause].filter(Boolean).join(" AND ")
  const orderBy = buildOrderBy(sort)

  const rows = await query<any[]>(
    `SELECT client_code, client_name, display_name, email, mobile, company_name, status, client_type, created_at
       FROM clients
      WHERE ${whereClause}
      ${orderBy}
      LIMIT ? OFFSET ?`,
    [ctx.auth.tenantId, ...where.params, pagination.limit, pagination.offset],
  )

  const [countRow] = await query<any[]>(
    `SELECT COUNT(*) AS total FROM clients WHERE ${whereClause}`,
    [ctx.auth.tenantId, ...where.params],
  )
  const total = Number(countRow?.total ?? 0)

  return jsonOk(rows, {
    requestId: ctx.requestId,
    meta: {
      page: pagination.page,
      per_page: pagination.perPage,
      total,
      total_pages: Math.max(1, Math.ceil(total / pagination.perPage)),
      sort: sort.raw ?? undefined,
    },
  })
})

function validate(body: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!String(body.client_name ?? "").trim()) errors.client_name = "client_name is required"
  if (!String(body.email ?? "").trim()) errors.email = "email is required"
  else if (!isValidEmail(body.email)) errors.email = "email is invalid"
  if (body.gst_number && !isValidGstin(body.gst_number)) errors.gst_number = "gst_number is invalid"
  if (body.pan && !isValidPan(body.pan)) errors.pan = "pan is invalid"
  return errors
}

export const POST = withApiV1({ scopes: "clients:write", idempotency: true }, async (ctx) => {
  await ensureClientTables()
  const body = await ctx.json<Record<string, any>>()

  const errors = validate(body)
  if (Object.keys(errors).length > 0) throw validationError(errors)

  const gstin = normalizeGstin(body.gst_number)
  const pan = normalizePan(body.pan) || panFromGstin(gstin)
  const email = normalizeEmail(body.email)
  const companyName = String(body.company_name ?? "").trim() || null
  const clientName = String(body.client_name ?? "").trim()
  const clientType =
    body.client_type === "Individual" || (!companyName && !body.client_type) ? "Individual" : "Company"

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
    [...values, ctx.auth.tenantId],
  )

  await recordAudit(null, {
    entityType: "client",
    entityId: clientCode,
    action: "created",
    summary: `Client ${payload.display_name} created via API`,
    meta: { source: "public_api", apiKeyId: ctx.auth.keyId },
    actorId: null,
  })

  void emitWebhookEvent(ctx.auth.tenantId, "client.created", {
    client_code: clientCode,
    client_name: clientName,
    email,
    company_name: companyName,
  })

  return jsonOk({ client_code: clientCode }, { requestId: ctx.requestId, status: 201 })
})

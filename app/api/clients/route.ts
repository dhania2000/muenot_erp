import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import { requireFeature } from "@/lib/api-auth"
import { nextRecordId } from "@/lib/record-ids"
import { recordAudit } from "@/lib/sales/lead-lifecycle"
import { scopeWhereForModule, mergeScopeIntoWhere, canCreateInModule } from "@/lib/permission-enforce"
import { currentTenantId } from "@/lib/tenant-scope"
import { ensureTenantIsolation } from "@/lib/tenant-ensure"
import {
  likePattern,
  orderByClause,
  pageMeta,
  parseTableQuery,
  TableQueryError,
  type TableQueryOptions,
} from "@/lib/table-query"
import {
  ensureClientTables,
  findClientDuplicates,
  resolveFinanceParty,
  isValidEmail,
  isValidGstin,
  isValidPan,
  normalizeEmail,
  normalizeGstin,
  normalizePan,
  panFromGstin,
  stateCodeFromGstin,
} from "@/lib/clients-db"

// Columns a client request is allowed to set directly. Derived / server-owned
// fields (client_code, display_name, legal_name, state_code, pan, row_version,
// archived_*) are computed here and must never be trusted from the body.
const ALLOWED = new Set([
  "salutation","client_name","email","login_allowed","email_notifications","gender","language",
  "mobile","company_name","website","tax_name","gst_number","office_phone","address","city","state",
  "country","postal_code","category","sub_category","currency","status","notes",
  "client_type","company_id","primary_contact_id","finance_party_id","account_manager_id",
  "payment_terms_days","credit_limit","legal_name",
])

/** Public sort keys → trusted SQL. Keys mirror the list UI's column keys. */
export const CLIENT_TABLE_QUERY: TableQueryOptions = {
  sortable: {
    client: "c.client_name",
    company: "c.company_name",
    location: "c.city",
    login: "c.login_allowed",
    status: "c.status",
    created_at: "c.created_at",
  },
  filters: { status: ["Active", "Inactive"], login: ["Yes", "No"] },
  defaultPageSize: 25,
}

export async function GET(request: Request) {
  await ensureClientTables()
  await ensureTenantIsolation()
  const session = await requireFeature("clients.view_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const url = new URL(request.url)
  const includeArchived = url.searchParams.get("includeArchived") === "1"

  // Record-level scope by the clients matrix (owned = account_manager_id).
  const scoped = await scopeWhereForModule(session, "clients.clients", "view", "clients", "c")
  // Tenant isolation ALWAYS constrains the query first; the permission scope is
  // ANDed on top. Derived server-side — never from request input.
  const tenantId = currentTenantId()
  const baseWhere = includeArchived
    ? "WHERE c.tenant_id = ?"
    : "WHERE c.tenant_id = ? AND c.archived_at IS NULL"
  const { where, args } = mergeScopeIntoWhere(baseWhere, [tenantId], scoped)

  // Paged mode (Spec34): the list UI requests one page at a time so large
  // tenants never ship their whole client book to the browser.
  if (url.searchParams.has("page")) {
    const started = performance.now()
    let q
    try {
      q = parseTableQuery(url.searchParams, CLIENT_TABLE_QUERY)
    } catch (err) {
      if (err instanceof TableQueryError) return NextResponse.json({ error: err.message }, { status: 400 })
      throw err
    }
    const extra: string[] = []
    const extraArgs: unknown[] = []
    if (q.search) {
      const like = likePattern(q.search)
      extra.push(
        `(c.client_code LIKE ? OR c.client_name LIKE ? OR c.email LIKE ? OR c.company_name LIKE ?
          OR c.gst_number LIKE ? OR c.pan LIKE ? OR c.city LIKE ? OR c.country LIKE ?)`,
      )
      extraArgs.push(like, like, like, like, like, like, like, like)
    }
    if (q.filters.status) {
      extra.push("c.status = ?")
      extraArgs.push(q.filters.status)
    }
    if (q.filters.login) {
      extra.push("c.login_allowed = ?")
      extraArgs.push(q.filters.login)
    }
    const pagedWhere = extra.length ? `${where} AND ${extra.join(" AND ")}` : where
    const pagedArgs = [...args, ...extraArgs]
    const order = orderByClause(q, CLIENT_TABLE_QUERY, "c.created_at DESC", "c.id DESC")

    const [countRows, rows] = await Promise.all([
      query<any[]>(`SELECT COUNT(*) AS total FROM clients c ${pagedWhere}`, pagedArgs),
      query<any[]>(
        `SELECT c.*,
                sc.company_code, sc.company_name AS linked_company_name,
                cv.customer_name AS finance_party_name,
                am.name AS account_manager_name
           FROM clients c
           LEFT JOIN sales_companies sc ON sc.id = c.company_id
           LEFT JOIN customers_vendors cv ON cv.party_id = c.finance_party_id
           LEFT JOIN users am ON am.id = c.account_manager_id
           ${pagedWhere}
           ${order}
           LIMIT ${q.pageSize} OFFSET ${q.offset}`,
        pagedArgs,
      ),
    ])
    const durationMs = Math.round((performance.now() - started) * 10) / 10
    return NextResponse.json(
      { clients: rows, ...pageMeta(q, Number(countRows[0]?.total ?? 0)), durationMs },
      { headers: { "Server-Timing": `db;dur=${durationMs}` } },
    )
  }

  const clients = await query(
    `SELECT c.*,
            sc.company_code, sc.company_name AS linked_company_name,
            cv.customer_name AS finance_party_name,
            am.name AS account_manager_name
       FROM clients c
       LEFT JOIN sales_companies sc ON sc.id = c.company_id
       LEFT JOIN customers_vendors cv ON cv.party_id = c.finance_party_id
       LEFT JOIN users am ON am.id = c.account_manager_id
       ${where}
       ORDER BY c.created_at DESC`,
    args,
  )
  return NextResponse.json({ clients })
}

/** Normalize + derive server-owned identity/tax fields from a request body. */
function deriveFields(body: Record<string, any>) {
  const gstin = normalizeGstin(body.gst_number)
  const pan = normalizePan(body.pan) || panFromGstin(gstin)
  const email = normalizeEmail(body.email)
  const companyName = String(body.company_name ?? "").trim() || null
  const clientName = String(body.client_name ?? "").trim()
  const clientType = body.client_type === "Individual" || (!companyName && !body.client_type) ? "Individual" : "Company"
  return {
    gstin,
    pan,
    email,
    display_name: String(body.display_name ?? "").trim() || companyName || clientName || null,
    legal_name: String(body.legal_name ?? "").trim() || companyName || null,
    client_type: clientType,
    state_code: String(body.state_code ?? "").trim() || stateCodeFromGstin(gstin) || null,
  }
}

/** Validate a client payload, returning a map of field -> message. */
function validate(body: Record<string, any>): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!String(body.client_name ?? "").trim()) errors.client_name = "Client name is required"
  if (!String(body.email ?? "").trim()) errors.email = "Email is required"
  else if (!isValidEmail(body.email)) errors.email = "Enter a valid email address"
  if (body.gst_number && !isValidGstin(body.gst_number)) errors.gst_number = "Enter a valid 15-character GSTIN"
  if (body.pan && !isValidPan(body.pan)) errors.pan = "Enter a valid 10-character PAN"
  return errors
}

export async function POST(request: Request) {
  await ensureClientTables()
  const session = await requireFeature("clients.manage_clients")
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = await request.json()

  const errors = validate(body)
  if (Object.keys(errors).length > 0) {
    return NextResponse.json({ error: "Validation failed", fields: errors }, { status: 400 })
  }

  const derived = deriveFields(body)

  // Duplicate detection — the client may override with { force: true } after
  // reviewing the surfaced matches.
  if (!body.force) {
    const duplicates = await findClientDuplicates({
      client_name: body.client_name,
      company_name: body.company_name,
      email: derived.email,
      gst_number: derived.gstin,
      pan: derived.pan,
    })
    if (duplicates.length > 0) {
      return NextResponse.json({ error: "Possible duplicate client", duplicates }, { status: 409 })
    }
  }

  // Finance party: link an existing, unambiguous customers_vendors record.
  // Never auto-create — the UI offers "Create Finance Profile" instead.
  let financePartyId: string | null = String(body.finance_party_id ?? "").trim() || null
  let financeMatches: unknown[] = []
  if (body.status === "Active" || !financePartyId) {
    const resolved = await resolveFinanceParty({
      finance_party_id: financePartyId,
      gst_number: derived.gstin,
      pan: derived.pan,
      company_name: body.company_name,
      client_name: body.client_name,
    })
    financePartyId = resolved.party_id
    financeMatches = resolved.matches
  }

  const clientCode = await nextRecordId("CLI")

  const payload: Record<string, any> = {}
  for (const key of Object.keys(body)) {
    if (ALLOWED.has(key)) payload[key] = body[key] === "" ? null : body[key]
  }
  // Apply derived / normalized server-owned values.
  payload.gst_number = derived.gstin
  payload.pan = derived.pan
  payload.email = derived.email
  payload.display_name = derived.display_name
  payload.legal_name = derived.legal_name
  payload.client_type = derived.client_type
  payload.state_code = derived.state_code
  payload.finance_party_id = financePartyId

  const fields = ["client_code", ...Object.keys(payload)]
  const values = [clientCode, ...Object.keys(payload).map((k) => payload[k])]

  // Stamp the acting tenant (server-derived) so the new row is owned by, and
  // only visible to, the caller's tenant.
  await query(
    `INSERT INTO clients (${fields.join(",")},created_by,tenant_id) VALUES (${fields.map(() => "?").join(",")},?,?)`,
    [...values, session.userId, currentTenantId()],
  )

  await recordAudit(null, {
    entityType: "client",
    entityId: clientCode,
    action: "created",
    summary: `Client ${derived.display_name || body.client_name} created`,
    meta: { finance_party_id: financePartyId, company_id: payload.company_id ?? null },
    actorId: session.userId,
  })

  return NextResponse.json(
    { ok: true, client_code: clientCode, finance_party_id: financePartyId, finance_matches: financeMatches },
    { status: 201 },
  )
}

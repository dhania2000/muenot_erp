import "server-only"
import { query, tableColumns } from "@/lib/db"
import {
  ANCHORS,
  SECTIONS,
  applyProfileMasks,
  firstPresent,
  normalizeIdentity,
  usableLinks,
  type IdentityKind,
  type PartyKind,
  type SectionResult,
  type SectionSpec,
  type ViewScope,
} from "@/lib/party-360/model"

/**
 * Spec39 — cross-module 360 read model. Every query is bounded to the acting
 * tenant; the anchor record must carry tenant_id (fail closed otherwise), and
 * child sections join by stable ids. A missing module or column degrades the
 * affected section only — it never fails the whole 360.
 */

export class Party360Error extends Error {
  constructor(
    public code: "setup_required" | "module_unavailable",
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

const SECTION_LIMIT = 25
const MISSING_CODES = new Set(["ER_NO_SUCH_TABLE", "ER_BAD_FIELD_ERROR"])

const q = (id: string) => `\`${id.replace(/`/g, "")}\``

function isMissing(err: unknown) {
  return MISSING_CODES.has(String((err as { code?: string })?.code ?? ""))
}

async function columnsOf(table: string): Promise<Set<string>> {
  try {
    return await tableColumns(table)
  } catch (err) {
    if (isMissing(err)) return new Set()
    throw err
  }
}

type AnchorValues = Record<"id" | "code" | "name" | "clientIds" | "financePartyIds", string[]>

type AnchorContext = { kind: PartyKind; tenantId: number; cols: Set<string> }

async function anchorContext(kind: PartyKind, tenantId: number): Promise<AnchorContext> {
  const spec = ANCHORS[kind]
  const cols = await columnsOf(spec.table)
  if (cols.size === 0) {
    throw new Party360Error("module_unavailable", 404, `${spec.label} module is not installed for this workspace.`)
  }
  if (!cols.has("tenant_id")) {
    throw new Party360Error(
      "setup_required",
      503,
      `${spec.table} is missing tenant_id. Apply database/migrations/2027-02-10-spec39-party-360.sql.`,
    )
  }
  return { kind, tenantId, cols }
}

function anchorFilterSql(ctx: AnchorContext): { sql: string; params: unknown[] } {
  const f = ANCHORS[ctx.kind].anchorFilter
  if (!f || !ctx.cols.has(f.requiresColumn)) return { sql: "", params: [] }
  return { sql: ` AND ${f.sql}`, params: f.params }
}

function escapeLike(s: string) {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`)
}

export type PartySummary = { id: number; name: string; code: string | null; status: string | null; href: string }

export async function listParties(
  kind: PartyKind,
  tenantId: number,
  opts: { search: string | null; scope: ViewScope; viewerUserId: number },
): Promise<PartySummary[]> {
  const spec = ANCHORS[kind]
  const ctx = await anchorContext(kind, tenantId)
  const statusCol = ["status", "employment_status"].find((c) => ctx.cols.has(c))
  const codeCol = ctx.cols.has(spec.codeColumn) ? spec.codeColumn : null
  const select = ["id", spec.nameColumn, codeCol, statusCol].filter(Boolean).map((c) => q(c as string)).join(", ")
  const params: unknown[] = [tenantId]
  let sql = `SELECT ${select} FROM ${q(spec.table)} WHERE tenant_id = ?`
  const filter = anchorFilterSql(ctx)
  sql += filter.sql
  params.push(...filter.params)
  if (opts.scope === "self") {
    if (!ctx.cols.has("user_id")) return []
    sql += " AND user_id = ?"
    params.push(opts.viewerUserId)
  }
  if (opts.search) {
    const like = `%${escapeLike(opts.search)}%`
    sql += codeCol ? ` AND (${q(spec.nameColumn)} LIKE ? OR ${q(codeCol)} LIKE ?)` : ` AND ${q(spec.nameColumn)} LIKE ?`
    params.push(like)
    if (codeCol) params.push(like)
  }
  sql += ` ORDER BY ${q(spec.nameColumn)} ASC LIMIT 25`
  const rows = await query<Record<string, unknown>[]>(sql, params)
  return rows.map((r) => ({
    id: Number(r.id),
    name: String(r[spec.nameColumn] ?? `#${r.id}`),
    code: codeCol && r[codeCol] != null ? String(r[codeCol]) : null,
    status: statusCol && r[statusCol] != null ? String(r[statusCol]) : null,
    href: `${spec.pageHref}?id=${r.id}`,
  }))
}

/** Loads the anchor row only if it belongs to the tenant. Cross-tenant → null (404, no existence leak). */
export async function loadAnchorRow(kind: PartyKind, tenantId: number, id: number) {
  const spec = ANCHORS[kind]
  const ctx = await anchorContext(kind, tenantId)
  const cols = spec.profileColumns.filter((c) => ctx.cols.has(c))
  if (!cols.includes("id")) cols.unshift("id")
  const filter = anchorFilterSql(ctx)
  const rows = await query<Record<string, unknown>[]>(
    `SELECT ${cols.map(q).join(", ")} FROM ${q(spec.table)} WHERE id = ? AND tenant_id = ?${filter.sql} LIMIT 1`,
    [id, tenantId, ...filter.params],
  )
  return { ctx, row: rows[0] ?? null }
}

async function deriveCustomerLinks(tenantId: number, companyId: number) {
  const out = { clientIds: [] as string[], financePartyIds: [] as string[] }
  const cols = await columnsOf("clients")
  if (!cols.has("company_id") || !cols.has("tenant_id")) return out
  const select = cols.has("finance_party_id") ? "id, finance_party_id" : "id"
  const rows = await query<{ id: number; finance_party_id?: unknown }[]>(
    `SELECT ${select} FROM clients WHERE company_id = ? AND tenant_id = ? LIMIT 100`,
    [companyId, tenantId],
  )
  out.clientIds = rows.map((r) => String(r.id))
  const partyPks = rows.map((r) => r.finance_party_id).filter((v) => v != null).map(String)
  if (partyPks.length) {
    out.financePartyIds.push(...partyPks)
    const cv = await columnsOf("customers_vendors")
    if (cv.has("party_id") && cv.has("tenant_id")) {
      const codes = await query<{ party_id: string }[]>(
        `SELECT party_id FROM customers_vendors WHERE id IN (${partyPks.map(() => "?").join(",")}) AND tenant_id = ?`,
        [...partyPks, tenantId],
      )
      out.financePartyIds.push(...codes.map((c) => String(c.party_id)).filter(Boolean))
    }
  }
  return out
}

export async function loadSection(
  spec: SectionSpec,
  values: AnchorValues,
  tenantId: number,
  canSee: boolean,
): Promise<SectionResult> {
  const base = { key: spec.key, label: spec.label, group: spec.group, moduleHref: spec.moduleHref, count: 0, items: [] }
  if (!canSee) return { ...base, status: "forbidden" }
  try {
    const cols = await columnsOf(spec.table)
    if (cols.size === 0) return { ...base, status: "missing_module" }
    const hasTenant = cols.has("tenant_id")
    const { links, droppedUnscoped } = usableLinks(spec.links, cols, hasTenant)

    const conds: string[] = []
    const params: unknown[] = []
    for (const link of links) {
      const vals = [...new Set(values[link.from].filter((v) => v !== ""))]
      if (!vals.length) continue
      conds.push(`${q(link.column)} IN (${vals.map(() => "?").join(",")})`)
      params.push(...vals)
    }
    if (!conds.length) return { ...base, status: droppedUnscoped ? "unscoped" : "not_linked" }

    let where = `(${conds.join(" OR ")})`
    for (const w of spec.where ?? []) {
      if (!cols.has(w.column)) return { ...base, status: "not_linked" }
      where += ` AND ${q(w.column)} IN (${w.values.map(() => "?").join(",")})`
      params.push(...w.values)
    }
    if (hasTenant) {
      where += " AND tenant_id = ?"
      params.push(tenantId)
    }

    const pick = (list?: string[]) => (list ?? []).filter((c) => cols.has(c))
    const selected = [
      ...new Set(["id", ...pick(spec.titleColumns), ...pick(spec.subtitleColumns), ...pick(spec.statusColumns), ...pick(spec.dateColumns), ...pick(spec.amountColumns)]),
    ].filter((c) => cols.has(c))
    const dateCol = pick(spec.dateColumns)[0]
    const order = dateCol ? `${q(dateCol)} DESC, ` : ""

    const [countRows, rows] = await Promise.all([
      query<{ n: number }[]>(`SELECT COUNT(*) AS n FROM ${q(spec.table)} WHERE ${where}`, params),
      query<Record<string, unknown>[]>(
        `SELECT ${selected.map(q).join(", ")} FROM ${q(spec.table)} WHERE ${where} ORDER BY ${order}${q("id")} DESC LIMIT ${SECTION_LIMIT}`,
        params,
      ),
    ])

    const items = rows.map((r) => {
      const title = firstPresent(r, spec.titleColumns)
      const subtitle = firstPresent(
        r,
        (spec.subtitleColumns ?? []).filter((c) => r[c] !== title),
      )
      const date = firstPresent(r, spec.dateColumns)
      const amount = firstPresent(r, spec.amountColumns)
      const refValue = r[spec.titleColumns[0]] ?? r.id
      return {
        id: String(r.id),
        title: title != null ? String(title) : `#${r.id}`,
        subtitle: subtitle != null ? String(subtitle) : null,
        status: firstPresent(r, spec.statusColumns) != null ? String(firstPresent(r, spec.statusColumns)) : null,
        date: date instanceof Date ? date.toISOString() : date != null ? String(date) : null,
        amount: amount != null && Number.isFinite(Number(amount)) ? Number(amount) : null,
        href: spec.rowHref({ id: r.id, ref: refValue }),
      }
    })
    return { ...base, status: "ok", count: Number(countRows[0]?.n ?? items.length), items }
  } catch (err) {
    if (isMissing(err)) return { ...base, status: "missing_module" }
    console.error(`[party-360] section ${spec.table} failed:`, (err as Error).message)
    return { ...base, status: "error" }
  }
}

const LIKE_FRAGMENT: Record<IdentityKind, (n: string) => string> = {
  email: (n) => n,
  tax_id: (n) => n.toLowerCase(),
  phone: (n) => n.slice(-7),
  domain: (n) => n,
  name: (n) => n.split(" ")[0],
}

export type DuplicateCandidate = { id: number; name: string; code: string | null; matchedOn: IdentityKind[]; href: string }

/** Same-tenant records that share a normalised identity key with the anchor. */
export async function findDuplicates(
  kind: PartyKind,
  ctx: AnchorContext,
  row: Record<string, unknown>,
): Promise<DuplicateCandidate[]> {
  const spec = ANCHORS[kind]
  const found = new Map<number, DuplicateCandidate>()
  const filter = anchorFilterSql(ctx)
  const codeCol = ctx.cols.has(spec.codeColumn) ? spec.codeColumn : null
  for (const ident of spec.identityColumns) {
    if (!ctx.cols.has(ident.column)) continue
    const norm = normalizeIdentity(ident.kind, row[ident.column])
    if (!norm) continue
    const select = ["id", spec.nameColumn, ident.column, codeCol].filter(Boolean).map((c) => q(c as string)).join(", ")
    const candidates = await query<Record<string, unknown>[]>(
      `SELECT ${select} FROM ${q(spec.table)}
        WHERE tenant_id = ? AND id <> ? AND LOWER(${q(ident.column)}) LIKE ?${filter.sql} LIMIT 50`,
      [ctx.tenantId, row.id, `%${escapeLike(LIKE_FRAGMENT[ident.kind](norm))}%`, ...filter.params],
    )
    for (const c of candidates) {
      if (normalizeIdentity(ident.kind, c[ident.column]) !== norm) continue
      const id = Number(c.id)
      const existing = found.get(id)
      if (existing) {
        if (!existing.matchedOn.includes(ident.kind)) existing.matchedOn.push(ident.kind)
      } else {
        found.set(id, {
          id,
          name: String(c[spec.nameColumn] ?? `#${id}`),
          code: codeCol && c[codeCol] != null ? String(c[codeCol]) : null,
          matchedOn: [ident.kind],
          href: `${spec.pageHref}?id=${id}`,
        })
      }
    }
  }
  return [...found.values()].slice(0, 10)
}

export type Party360 = {
  kind: PartyKind
  id: number
  name: string
  code: string | null
  scope: ViewScope
  profile: Record<string, unknown>
  maskedFields: string[]
  recordHref: string
  sections: SectionResult[]
  duplicates: DuplicateCandidate[]
  links: { hasLoginAccount?: boolean }
}

export async function buildParty360(input: {
  kind: PartyKind
  tenantId: number
  row: Record<string, unknown>
  ctx: AnchorContext
  scope: ViewScope
  can: (feature: string) => boolean
}): Promise<Party360> {
  const { kind, tenantId, row, ctx, scope, can } = input
  const spec = ANCHORS[kind]
  const id = Number(row.id)
  const values: AnchorValues = {
    id: [String(id)],
    code: row[spec.codeColumn] != null ? [String(row[spec.codeColumn])] : [],
    name: row[spec.nameColumn] != null ? [String(row[spec.nameColumn])] : [],
    clientIds: [],
    financePartyIds: [],
  }
  if (kind === "customer") {
    try {
      Object.assign(values, await deriveCustomerLinks(tenantId, id))
    } catch (err) {
      if (!isMissing(err)) console.error("[party-360] customer link derivation failed:", (err as Error).message)
    }
  }
  if (kind === "vendor") values.financePartyIds = [...values.id, ...values.code]

  // Self-scope viewers (an employee on their own record) see only HR-owned
  // sections; audit activity and other people's modules stay hidden.
  const sectionVisible = (s: SectionSpec) =>
    scope === "self" ? ["documents", "assets", "leave", "tickets"].includes(s.key) : s.features.some(can)

  const sections = await Promise.all(SECTIONS[kind].map((s) => loadSection(s, values, tenantId, sectionVisible(s))))
  const { profile, masked } = applyProfileMasks(kind, row, can)
  const duplicates = scope === "full" ? await findDuplicates(kind, ctx, row).catch(() => []) : []

  return {
    kind,
    id,
    name: String(row[spec.nameColumn] ?? `#${id}`),
    code: row[spec.codeColumn] != null ? String(row[spec.codeColumn]) : null,
    scope,
    profile,
    maskedFields: masked,
    recordHref: spec.recordHref(id),
    sections,
    duplicates,
    links: kind === "employee" ? { hasLoginAccount: row.user_id != null } : {},
  }
}

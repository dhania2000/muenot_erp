import "server-only"
/**
 * SPEC 85 — resource registry.
 *
 * A module gains bulk actions by registering a `BulkResourceDef` here. Each
 * resource owns three concerns the engine delegates: loading records already
 * scoped to what the actor may SEE, per-record permission verdicts, and the
 * apply implementation for each action. Keeping every resource in one registry
 * lets the generic API route (`/api/bulk/[resource]`) dispatch by key.
 *
 * The first resource is Sales Companies; adding more (contacts, leads, HR
 * employees, ...) is a matter of registering another definition — no route,
 * engine, or UI change required.
 */
import { query } from "@/lib/db"
import { canActOnRecord, scopeWhereForModule, mergeScopeIntoWhere } from "@/lib/permission-enforce"
import {
  COMPANY_PRIORITIES,
  COMPANY_STATUSES,
  archiveCompany,
  restoreCompany,
  updateCompany,
} from "@/lib/sales/company-master"
import type { BulkResourceDef } from "./types"

type CompanyRow = {
  id: number
  company_code: string | null
  company_name: string
  status: string | null
  priority: string | null
  assigned_to: number | null
  created_by: number | null
  company_email: string | null
  phone: string | null
  city: string | null
  country: string | null
  archived_at: string | null
}

const PERMISSION_KEY = "sales.companies"

const companies: BulkResourceDef<CompanyRow> = {
  key: "sales.companies",
  label: "Companies",
  singular: "company",
  plural: "companies",
  feature: "sales.manage_companies",

  async load(ids, ctx) {
    if (ids.length === 0) return []
    // Scope to rows the actor may VIEW (tenant is applied by the data layer via
    // tenant context; record-level scope via the permission model).
    const placeholders = ids.map(() => "?").join(",")
    let where = `WHERE c.id IN (${placeholders})`
    let args: any[] = [...ids]
    const scoped = await scopeWhereForModule(ctx.session, PERMISSION_KEY, "view", "sales_companies", "c")
    ;({ where, args } = mergeScopeIntoWhere(where, args, scoped))
    const rows = await query<CompanyRow[]>(
      `SELECT c.id, c.company_code, c.company_name, c.status, c.priority, c.assigned_to,
              c.created_by, c.company_email, c.phone, c.city, c.country, c.archived_at
         FROM sales_companies c
         ${where}`,
      args,
    )
    return rows
  },

  idOf: (r) => r.id,
  labelOf: (r) => r.company_name || r.company_code || `#${r.id}`,

  actions: {
    set_status: {
      kind: "set_status",
      label: "Change status",
      requiresValue: true,
      parseValue(raw) {
        const status = (raw as any)?.status
        if (!COMPANY_STATUSES.includes(status)) {
          throw new Error(`Status must be one of: ${COMPANY_STATUSES.join(", ")}`)
        }
        return { status }
      },
      permit: (record, ctx) => canActOnRecord(ctx.session, PERMISSION_KEY, "update", record).then((ok) => (ok ? true : "No permission to edit this company")),
      apply: (record, ctx, value) => updateCompany(record.id, { status: value.status }, ctx.session.userId),
    },

    assign: {
      kind: "assign",
      label: "Assign owner",
      requiresValue: true,
      parseValue(raw) {
        const assignee = (raw as any)?.assignee
        // null clears the owner; otherwise a positive user id.
        if (assignee === null) return { assignee: null }
        const n = Number(assignee)
        if (!Number.isInteger(n) || n <= 0) throw new Error("Assignee must be a valid user id or null")
        return { assignee: n }
      },
      permit: (record, ctx) => canActOnRecord(ctx.session, PERMISSION_KEY, "update", record).then((ok) => (ok ? true : "No permission to reassign this company")),
      apply: (record, ctx, value) => updateCompany(record.id, { assigned_to: value.assignee }, ctx.session.userId),
    },

    archive: {
      kind: "archive",
      label: "Archive",
      destructive: true,
      permit: (record, ctx) => {
        if (record.archived_at) return "Already archived"
        return canActOnRecord(ctx.session, PERMISSION_KEY, "delete", record).then((ok) => (ok ? true : "No permission to archive this company"))
      },
      apply: (record, ctx) => archiveCompany(record.id, ctx.session.userId),
    },

    restore: {
      kind: "restore",
      label: "Restore",
      permit: (record, ctx) => {
        if (!record.archived_at) return "Not archived"
        return canActOnRecord(ctx.session, PERMISSION_KEY, "delete", record).then((ok) => (ok ? true : "No permission to restore this company"))
      },
      apply: (record, ctx) => restoreCompany(record.id, ctx.session.userId),
    },

    delete: {
      kind: "delete",
      label: "Delete",
      destructive: true,
      // Sales never hard-deletes companies — a bulk "delete" archives them, so
      // the operation is reversible via restore.
      permit: (record, ctx) => {
        if (record.archived_at) return "Already archived"
        return canActOnRecord(ctx.session, PERMISSION_KEY, "delete", record).then((ok) => (ok ? true : "No permission to delete this company"))
      },
      apply: (record, ctx) => archiveCompany(record.id, ctx.session.userId),
    },

    export: {
      kind: "export",
      label: "Export CSV",
      permit: () => true,
      apply: async () => {},
      toExportRow: (r) => ({
        id: r.id,
        code: r.company_code,
        name: r.company_name,
        status: r.status,
        priority: r.priority,
        email: r.company_email,
        phone: r.phone,
        city: r.city,
        country: r.country,
        archived: r.archived_at ? "yes" : "no",
      }),
    },
  },
}

const REGISTRY: Record<string, BulkResourceDef<any>> = {
  [companies.key]: companies,
}

export function getResource(key: string): BulkResourceDef<any> | null {
  return REGISTRY[key] ?? null
}

/** Public catalog for UI discovery (labels + supported actions). */
export function listResources() {
  return Object.values(REGISTRY).map((r) => ({
    key: r.key,
    label: r.label,
    singular: r.singular,
    plural: r.plural,
    actions: Object.values(r.actions)
      .filter(Boolean)
      .map((a) => ({ kind: a!.kind, label: a!.label, destructive: !!a!.destructive, requiresValue: !!a!.requiresValue })),
  }))
}

/** Priorities/statuses exported for the client action forms. */
export const COMPANY_ACTION_OPTIONS = {
  statuses: COMPANY_STATUSES,
  priorities: COMPANY_PRIORITIES,
}

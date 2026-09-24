import "server-only"

/**
 * Expiry source registry (SPEC 88, Phase 1 + 2).
 *
 * Each source knows how to pull its expiry-bearing rows out of the DB and
 * normalise them into a common {@link ExpirySourceRow} shape. The service layer
 * (lib/expiry/service.ts) is the only consumer — it classifies, aggregates and
 * notifies. Adding a new expiry-sensitive record type means adding one entry
 * here; nothing else changes.
 *
 * Sources flagged `notifiesElsewhere` already have their own reminder scheduler
 * (e.g. legal contracts via lib/legal-contracts-scheduler.ts). They are surfaced
 * in the unified dashboard for visibility but skipped by this service's sweep so
 * users never receive duplicate notifications.
 */
import { query } from "@/lib/db"
import { categorizeDocumentType, type ExpirySourceRow } from "@/lib/expiry/model"
import { DEFAULT_EXPIRY_WARN_DAYS, toISODate } from "@/lib/expiry/date"

export type ExpirySource = {
  id: string
  label: string
  /** When true, dashboard-only: another scheduler owns notifications. */
  notifiesElsewhere?: boolean
  fetch: () => Promise<ExpirySourceRow[]>
}

function fullName(name: string | null | undefined, id: number | string): string {
  const n = (name ?? "").trim()
  return n || `Employee #${id}`
}

/** HR employee documents (certifications, licenses, insurance, IDs, …). */
const employeeDocuments: ExpirySource = {
  id: "hr_employee_documents",
  label: "Employee Documents",
  async fetch() {
    const rows = await query<
      {
        id: number
        employee_id: number
        employee_name: string | null
        user_id: number | null
        document_type: string | null
        document_number: string | null
        issue_date: Date | string | null
        expiry_date: Date | string | null
        expiry_warn_days: number | null
      }[]
    >(
      `SELECT d.id, d.employee_id, e.employee_name, e.user_id,
              d.document_type, d.document_number, d.issue_date, d.expiry_date,
              t.expiry_warn_days
         FROM hr_employee_documents d
         JOIN hr_employees e ON e.id = d.employee_id
         LEFT JOIN hr_document_types t ON t.type_name = d.document_type
        WHERE d.expiry_date IS NOT NULL
          AND (d.is_current = 1 OR d.is_current IS NULL)
          AND d.archived_at IS NULL`,
    ).catch(() => [])

    return rows.flatMap((r) => {
      const expiryDate = toISODate(r.expiry_date)
      if (!expiryDate) return []
      const typeName = r.document_type || "Document"
      return [
        {
          sourceId: this.id,
          sourceLabel: this.label,
          category: categorizeDocumentType(typeName),
          entityId: String(r.id),
          title: `${typeName} — ${fullName(r.employee_name, r.employee_id)}`,
          subtitle: fullName(r.employee_name, r.employee_id),
          expiryDate,
          issueDate: toISODate(r.issue_date),
          documentNumber: r.document_number,
          warnDays: Number(r.expiry_warn_days ?? DEFAULT_EXPIRY_WARN_DAYS) || DEFAULT_EXPIRY_WARN_DAYS,
          link: "/modules/hr/employee-documents",
          ownerUserId: r.user_id != null ? Number(r.user_id) : null,
        } satisfies ExpirySourceRow,
      ]
    })
  },
}

/** HR passport & visa records — one row can yield two expiry items. */
const passportVisa: ExpirySource = {
  id: "hr_passport_visa",
  label: "Passport & Visa",
  async fetch() {
    const rows = await query<
      {
        record_id: number
        employee_id: number
        employee_name: string | null
        user_id: number | null
        passport_number: string | null
        passport_issue_date: Date | string | null
        passport_expiry_date: Date | string | null
        visa_type: string | null
        visa_number: string | null
        visa_issue_date: Date | string | null
        visa_expiry_date: Date | string | null
      }[]
    >(
      `SELECT pv.record_id, pv.employee_id, e.employee_name, e.user_id,
              pv.passport_number, pv.passport_issue_date, pv.passport_expiry_date,
              pv.visa_type, pv.visa_number, pv.visa_issue_date, pv.visa_expiry_date
         FROM hr_passport_visa pv
         JOIN hr_employees e ON e.id = pv.employee_id
        WHERE COALESCE(pv.status, 'Active') <> 'Inactive'
          AND (pv.passport_expiry_date IS NOT NULL OR pv.visa_expiry_date IS NOT NULL)`,
    ).catch(() => [])

    const out: ExpirySourceRow[] = []
    for (const r of rows) {
      const who = fullName(r.employee_name, r.employee_id)
      const passportExpiry = toISODate(r.passport_expiry_date)
      if (passportExpiry) {
        out.push({
          sourceId: this.id,
          sourceLabel: this.label,
          category: "Identity",
          entityId: `${r.record_id}:passport`,
          title: `Passport — ${who}`,
          subtitle: who,
          expiryDate: passportExpiry,
          issueDate: toISODate(r.passport_issue_date),
          documentNumber: r.passport_number,
          warnDays: 90,
          link: "/modules/hr/master-data",
          ownerUserId: r.user_id != null ? Number(r.user_id) : null,
        })
      }
      const visaExpiry = toISODate(r.visa_expiry_date)
      if (visaExpiry) {
        out.push({
          sourceId: this.id,
          sourceLabel: this.label,
          category: "Identity",
          entityId: `${r.record_id}:visa`,
          title: `${r.visa_type ? `${r.visa_type} ` : ""}Visa — ${who}`,
          subtitle: who,
          expiryDate: visaExpiry,
          issueDate: toISODate(r.visa_issue_date),
          documentNumber: r.visa_number,
          warnDays: 90,
          link: "/modules/hr/master-data",
          ownerUserId: r.user_id != null ? Number(r.user_id) : null,
        })
      }
    }
    return out
  },
}

/**
 * Legal generated contracts — dashboard-only. The legal contracts scheduler
 * (lib/legal-contracts-scheduler.ts) already handles expiry/renewal reminders
 * and auto-expiry, so we surface these for the unified view but never re-notify.
 */
const legalContracts: ExpirySource = {
  id: "legal_generated_contracts",
  label: "Legal Contracts",
  notifiesElsewhere: true,
  async fetch() {
    const rows = await query<
      {
        id: number
        contract_uid: string | null
        reference_no: string | null
        title: string | null
        end_date: Date | string | null
        status: string | null
      }[]
    >(
      `SELECT id, contract_uid, reference_no, title, end_date, status
         FROM legal_generated_contracts
        WHERE end_date IS NOT NULL
          AND status NOT IN ('Terminated','Cancelled')`,
    ).catch(() => [])

    return rows.flatMap((r) => {
      const expiryDate = toISODate(r.end_date)
      if (!expiryDate) return []
      const ref = r.reference_no || r.contract_uid || `#${r.id}`
      return [
        {
          sourceId: this.id,
          sourceLabel: this.label,
          category: "Contract",
          entityId: String(r.id),
          title: r.title ? `${r.title}` : `Contract ${ref}`,
          subtitle: ref,
          expiryDate,
          issueDate: null,
          documentNumber: ref,
          warnDays: DEFAULT_EXPIRY_WARN_DAYS,
          link: "/modules/legal/contracts",
          ownerUserId: null,
        } satisfies ExpirySourceRow,
      ]
    })
  },
}

export const EXPIRY_SOURCES: readonly ExpirySource[] = [employeeDocuments, passportVisa, legalContracts]

/** Fetch and normalise every source row (unclassified). */
export async function fetchAllExpiryRows(): Promise<ExpirySourceRow[]> {
  const results = await Promise.all(
    EXPIRY_SOURCES.map((s) =>
      s.fetch().catch((err) => {
        console.log(`[v0] expiry source ${s.id} failed:`, err instanceof Error ? err.message : err)
        return [] as ExpirySourceRow[]
      }),
    ),
  )
  return results.flat()
}

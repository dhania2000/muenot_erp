import "server-only"
import { query } from "@/lib/db"
import { getCompanySettings } from "@/lib/hr-letters-db"
import { buildCertificatePdf, type CertificateData } from "@/lib/hr-certificate-pdf"

// The two recognition tables that can produce a certificate. employee_id on
// both is the numeric hr_employees.id (see the HR master-features migration).
const CONFIGS = {
  awards: { table: "hr_awards", id: "award_id", prefix: "AWD", kind: "award" as const },
  appreciations: { table: "hr_appreciations", id: "appreciation_id", prefix: "APR", kind: "appreciation" as const },
}

export type CertificateKind = keyof typeof CONFIGS
export function isCertificateKind(v: string): v is CertificateKind {
  return v === "awards" || v === "appreciations"
}

export type LoadedCertificate = {
  data: CertificateData
  recordId: number
  employeeId: number | null
  recipientName: string
  recipientEmail: string | null
  refNumber: string
  fileName: string
}

/**
 * Load a recognition record + its employee + company settings and shape it into
 * the certificate payload. Returns null when the record does not exist.
 */
export async function loadCertificate(
  kind: CertificateKind,
  id: number | string,
): Promise<LoadedCertificate | null> {
  const cfg = CONFIGS[kind]
  const rows = await query<any[]>(`SELECT * FROM ${cfg.table} WHERE ${cfg.id} = ? LIMIT 1`, [id])
  const rec = rows[0]
  if (!rec) return null

  const emps = await query<any[]>("SELECT * FROM hr_employees WHERE id = ? LIMIT 1", [rec.employee_id])
  const emp = emps[0] ?? null

  const c = await getCompanySettings()
  const company = {
    name: c["company.name"] || "Company",
    email: c["company.email"] || undefined,
    phone: c["company.phone"] || undefined,
    addressLines: [
      c["address.line"],
      [c["address.city"], c["address.state"], c["address.country"]].filter(Boolean).join(", "),
    ].filter(Boolean),
  }

  const recordId = Number(rec[cfg.id])
  const refNumber = `${cfg.prefix}-${String(recordId).padStart(4, "0")}`
  const recipientName = emp?.employee_name || `Employee #${rec.employee_id}`
  const recipientRole = [emp?.designation, emp?.department].filter(Boolean).join(", ") || undefined

  const data: CertificateData =
    kind === "awards"
      ? {
          kind: "award",
          recipientName,
          recipientRole,
          title: rec.award_name,
          description: rec.description || undefined,
          date: rec.award_date,
          givenBy: rec.given_by || undefined,
          refNumber,
          company,
        }
      : {
          kind: "appreciation",
          recipientName,
          recipientRole,
          title: rec.title,
          description: rec.message || undefined,
          date: rec.appreciation_date,
          givenBy: rec.given_by || undefined,
          category: rec.category || undefined,
          refNumber,
          company,
        }

  return {
    data,
    recordId,
    employeeId: emp?.id ?? null,
    recipientName,
    recipientEmail: emp?.official_email || emp?.personal_email || null,
    refNumber,
    fileName: `${refNumber}-${recipientName.replace(/[^a-z0-9]+/gi, "-")}.pdf`,
  }
}

export function renderCertificatePdf(data: CertificateData): Buffer {
  return buildCertificatePdf(data)
}

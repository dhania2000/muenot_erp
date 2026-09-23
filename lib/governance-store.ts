"use client"

// SPECS 70–72 — frontend-only governance data stores. There is no backend
// enforcement yet: field security, retention, and legal hold decisions here
// do not actually affect API responses, exports, or scheduled jobs (see
// lib/platform-guard.ts for the real, server-enforced role guard). These
// stores only drive the governance UI so every screen is fully exercisable —
// create, edit, release/pause — without a backend. Codex will replace this
// with real, server-enforced policies and jobs.
//
// SPEC 69 (Data Classification) has already been replaced with a real,
// server-enforced, tenant-scoped, audited model: see lib/data-classification.ts
// (+ lib/data-classification-model.ts) and app/api/admin/governance/classification.
// The classification store previously here is gone; do not reintroduce a
// localStorage classification store.

const EVENT = "muenot:governance-changed"

function read<T>(key: string, fallback: T[]): T[] {
  if (typeof window === "undefined") return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : fallback
  } catch {
    return fallback
  }
}

function write<T>(key: string, records: T[]) {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(key, JSON.stringify(records))
    window.dispatchEvent(new Event(EVENT))
  } catch {
    /* storage unavailable — state is best-effort only */
  }
}

export function subscribeGovernance(callback: () => void) {
  if (typeof window === "undefined") return () => {}
  window.addEventListener(EVENT, callback)
  window.addEventListener("storage", callback)
  return () => {
    window.removeEventListener(EVENT, callback)
    window.removeEventListener("storage", callback)
  }
}

// ---------------------------------------------------------------------------
// Field security policies (Spec 70)
// ---------------------------------------------------------------------------

export type FieldEffect = "Visible" | "Read Only" | "Masked" | "Hidden"

export type FieldSecurityPolicy = {
  id: string
  module: string
  entity: string
  field: string
  scope: string
  effect: FieldEffect
  createdAt: number
}

const FIELD_SECURITY_KEY = "muenot.governance.field-security.v1"
const FIELD_SECURITY_SEED: FieldSecurityPolicy[] = [
  { id: "fs-1", module: "HR", entity: "Employee", field: "Salary (CTC)", scope: "Role: Manager", effect: "Masked", createdAt: 0 },
  { id: "fs-2", module: "HR", entity: "Employee", field: "Bank account number", scope: "Role: Employee", effect: "Hidden", createdAt: 0 },
  { id: "fs-3", module: "HR", entity: "Employee", field: "PAN", scope: "Department: Finance", effect: "Visible", createdAt: 0 },
  { id: "fs-4", module: "Finance", entity: "Payment", field: "Bank routing details", scope: "Permission group: AP Clerk", effect: "Read Only", createdAt: 0 },
  { id: "fs-5", module: "CRM", entity: "Customer", field: "Contact phone", scope: "Legal entity: EU", effect: "Masked", createdAt: 0 },
]

export function listFieldSecurityPolicies(): FieldSecurityPolicy[] {
  const records = read(FIELD_SECURITY_KEY, FIELD_SECURITY_SEED)
  if (typeof window !== "undefined" && !window.localStorage.getItem(FIELD_SECURITY_KEY)) {
    write(FIELD_SECURITY_KEY, records)
  }
  return records
}

export function upsertFieldSecurityPolicy(input: Omit<FieldSecurityPolicy, "id" | "createdAt"> & { id?: string }) {
  const records = listFieldSecurityPolicies()
  if (input.id) {
    write(
      FIELD_SECURITY_KEY,
      records.map((r) => (r.id === input.id ? { ...r, ...input } : r)),
    )
  } else {
    const record: FieldSecurityPolicy = { ...input, id: `fs-${Date.now().toString(36)}`, createdAt: Date.now() }
    write(FIELD_SECURITY_KEY, [record, ...records])
  }
}

export function deleteFieldSecurityPolicy(id: string) {
  write(FIELD_SECURITY_KEY, listFieldSecurityPolicies().filter((r) => r.id !== id))
}

// ---------------------------------------------------------------------------
// Retention policies (Spec 71)
// ---------------------------------------------------------------------------

export type RetentionAction = "Archive" | "Delete"
export type RetentionStatus = "Active" | "Paused" | "Held (legal hold)"

export type RetentionPolicy = {
  id: string
  module: string
  recordType: string
  period: string
  action: RetentionAction
  nextRun: string
  lastRun: string
  affected: number
  status: RetentionStatus
  legalHold: boolean
  createdAt: number
}

const RETENTION_KEY = "muenot.governance.retention.v1"
const RETENTION_SEED: RetentionPolicy[] = [
  { id: "rp-1", module: "HR", recordType: "Terminated employee records", period: "7 years", action: "Archive", nextRun: "2026-10-01", lastRun: "2026-09-01", affected: 0, status: "Active", legalHold: false, createdAt: 0 },
  { id: "rp-2", module: "Finance", recordType: "Closed invoices", period: "10 years", action: "Archive", nextRun: "2026-10-01", lastRun: "2026-09-01", affected: 214, status: "Active", legalHold: false, createdAt: 0 },
  { id: "rp-3", module: "CRM", recordType: "Lost leads", period: "2 years", action: "Delete", nextRun: "2026-10-15", lastRun: "—", affected: 0, status: "Active", legalHold: false, createdAt: 0 },
  { id: "rp-4", module: "Projects", recordType: "Completed project files", period: "5 years", action: "Archive", nextRun: "Paused", lastRun: "2026-08-14", affected: 3, status: "Held (legal hold)", legalHold: true, createdAt: 0 },
]

export function listRetentionPolicies(): RetentionPolicy[] {
  const records = read(RETENTION_KEY, RETENTION_SEED)
  if (typeof window !== "undefined" && !window.localStorage.getItem(RETENTION_KEY)) {
    write(RETENTION_KEY, records)
  }
  return records
}

export function upsertRetentionPolicy(
  input: Omit<RetentionPolicy, "id" | "createdAt" | "nextRun" | "lastRun" | "affected" | "status" | "legalHold"> & {
    id?: string
  },
) {
  const records = listRetentionPolicies()
  if (input.id) {
    write(
      RETENTION_KEY,
      records.map((r) => (r.id === input.id ? { ...r, ...input } : r)),
    )
  } else {
    const record: RetentionPolicy = {
      ...input,
      id: `rp-${Date.now().toString(36)}`,
      nextRun: "Scheduling…",
      lastRun: "—",
      affected: 0,
      status: "Active",
      legalHold: false,
      createdAt: Date.now(),
    }
    write(RETENTION_KEY, [record, ...records])
  }
}

export function toggleRetentionPause(id: string) {
  write(
    RETENTION_KEY,
    listRetentionPolicies().map((r) =>
      r.id === id && !r.legalHold
        ? { ...r, status: r.status === "Paused" ? "Active" : ("Paused" as RetentionStatus), nextRun: r.status === "Paused" ? "Scheduling…" : "Paused" }
        : r,
    ),
  )
}

export function runRetentionNow(id: string) {
  const today = new Date().toISOString().slice(0, 10)
  write(
    RETENTION_KEY,
    listRetentionPolicies().map((r) =>
      r.id === id && !r.legalHold ? { ...r, lastRun: today, affected: r.affected + Math.floor(Math.random() * 5) } : r,
    ),
  )
}

export function deleteRetentionPolicy(id: string) {
  write(RETENTION_KEY, listRetentionPolicies().filter((r) => r.id !== id))
}

// ---------------------------------------------------------------------------
// Legal holds (Spec 72)
// ---------------------------------------------------------------------------

export type LegalHoldStatus = "Active" | "Released"

export type LegalHold = {
  id: string
  name: string
  scope: string
  records: string
  createdBy: string
  start: string
  status: LegalHoldStatus
  releasedBy: string | null
  createdAt: number
}

const LEGAL_HOLDS_KEY = "muenot.governance.legal-holds.v1"
const LEGAL_HOLDS_SEED: LegalHold[] = [
  {
    id: "lh-1",
    name: "Litigation — Vendor dispute #2291",
    scope: "Finance",
    records: "Vendor VEN-0044, all POs & invoices 2024–2026",
    createdBy: "legal.counsel@acme.com",
    start: "2026-07-12",
    status: "Active",
    releasedBy: null,
    createdAt: 0,
  },
  {
    id: "lh-2",
    name: "Regulatory inquiry — Payroll audit",
    scope: "HR",
    records: "Filter: department = Finance, period = FY2025",
    createdBy: "compliance@acme.com",
    start: "2026-08-01",
    status: "Active",
    releasedBy: null,
    createdAt: 0,
  },
  {
    id: "lh-3",
    name: "Contract dispute — Client X",
    scope: "Projects",
    records: "Project PRJ-2201, all deliverables & documents",
    createdBy: "legal.counsel@acme.com",
    start: "2026-05-20",
    status: "Released",
    releasedBy: "legal.counsel@acme.com (2026-08-30, dispute settled)",
    createdAt: 0,
  },
]

export function listLegalHolds(): LegalHold[] {
  const records = read(LEGAL_HOLDS_KEY, LEGAL_HOLDS_SEED)
  if (typeof window !== "undefined" && !window.localStorage.getItem(LEGAL_HOLDS_KEY)) {
    write(LEGAL_HOLDS_KEY, records)
  }
  return records
}

export function createLegalHold(input: { name: string; scope: string; records: string; createdBy: string }) {
  const record: LegalHold = {
    ...input,
    id: `lh-${Date.now().toString(36)}`,
    start: new Date().toISOString().slice(0, 10),
    status: "Active",
    releasedBy: null,
    createdAt: Date.now(),
  }
  write(LEGAL_HOLDS_KEY, [record, ...listLegalHolds()])
}

export function releaseLegalHold(id: string, releasedBy: string, reason: string) {
  const today = new Date().toISOString().slice(0, 10)
  write(
    LEGAL_HOLDS_KEY,
    listLegalHolds().map((h) =>
      h.id === id
        ? { ...h, status: "Released" as LegalHoldStatus, releasedBy: `${releasedBy} (${today}, ${reason})` }
        : h,
    ),
  )
}

// ---------------------------------------------------------------------------
// Export jobs (Spec 73)
// ---------------------------------------------------------------------------

export type ExportJobStatus = "Queued" | "Running" | "Completed" | "Expired"

export type ExportJob = {
  id: string
  module: string
  format: string
  requestedBy: string
  status: ExportJobStatus
  progress: number
  created: string
  expires: string
  file: string | null
  recurring: boolean
}

const EXPORT_JOBS_KEY = "muenot.governance.export-jobs.v1"
const EXPORT_JOBS_SEED: ExportJob[] = [
  { id: "exp_5521", module: "Employees (HR)", format: "Excel", requestedBy: "priya.sharma@acme.com", status: "Completed", progress: 100, created: "2026-09-19 08:02", expires: "2026-09-26", file: "employees_2026-09-19.xlsx", recurring: false },
  { id: "exp_5520", module: "Full tenant export", format: "JSON", requestedBy: "rahul.verma@acme.com", status: "Running", progress: 64, created: "2026-09-19 07:40", expires: "—", file: null, recurring: false },
  { id: "exp_5519", module: "Invoices (Finance)", format: "CSV", requestedBy: "anita.rao@acme.com", status: "Expired", progress: 100, created: "2026-08-30 11:15", expires: "2026-09-06", file: null, recurring: false },
]

export function listExportJobs(): ExportJob[] {
  const records = read(EXPORT_JOBS_KEY, EXPORT_JOBS_SEED)
  if (typeof window !== "undefined" && !window.localStorage.getItem(EXPORT_JOBS_KEY)) {
    write(EXPORT_JOBS_KEY, records)
  }
  return records
}

export function startExportJob(input: { module: string; format: string; recurring: boolean }) {
  const now = new Date()
  const created = now.toISOString().slice(0, 16).replace("T", " ")
  const record: ExportJob = {
    id: `exp_${Date.now().toString(36)}`,
    module: input.module,
    format: input.format,
    requestedBy: "current.user@acme.com",
    status: "Running",
    progress: 0,
    created,
    expires: "—",
    file: null,
    recurring: input.recurring,
  }
  write(EXPORT_JOBS_KEY, [record, ...listExportJobs()])

  // Simulate background job progress purely for UI demonstration purposes.
  if (typeof window !== "undefined") {
    let progress = 0
    const tick = () => {
      progress = Math.min(100, progress + 20 + Math.floor(Math.random() * 20))
      const jobs = listExportJobs()
      if (progress >= 100) {
        const expiresDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
        write(
          EXPORT_JOBS_KEY,
          jobs.map((j) =>
            j.id === record.id
              ? {
                  ...j,
                  status: "Completed" as ExportJobStatus,
                  progress: 100,
                  expires: expiresDate,
                  file: `${input.module.split(" ")[0].toLowerCase()}_${created.slice(0, 10)}.${input.format.toLowerCase() === "excel" ? "xlsx" : input.format.toLowerCase()}`,
                }
              : j,
          ),
        )
      } else {
        write(EXPORT_JOBS_KEY, jobs.map((j) => (j.id === record.id ? { ...j, progress } : j)))
        window.setTimeout(tick, 900)
      }
    }
    window.setTimeout(tick, 900)
  }

  return record
}

// ---------------------------------------------------------------------------
// Import jobs (Spec 74)
// ---------------------------------------------------------------------------

export type ImportJobStatus = "Completed" | "Completed with errors" | "Failed — invalid headers"

export type ImportJob = {
  id: string
  module: string
  file: string
  success: number
  failed: number
  skipped: number
  status: ImportJobStatus
  when: string
}

const IMPORT_JOBS_KEY = "muenot.governance.import-jobs.v1"
const IMPORT_JOBS_SEED: ImportJob[] = [
  { id: "imp_1042", module: "Employees (HR)", file: "hr_employees_sep.csv", success: 118, failed: 3, skipped: 2, status: "Completed with errors", when: "2026-09-18 09:12" },
  { id: "imp_1041", module: "Chart of accounts (Finance)", file: "coa_v3.xlsx", success: 86, failed: 0, skipped: 0, status: "Completed", when: "2026-09-16 14:40" },
  { id: "imp_1040", module: "Leads (Sales)", file: "leads_q3.csv", success: 0, failed: 0, skipped: 0, status: "Failed — invalid headers", when: "2026-09-14 11:03" },
]

export function listImportJobs(): ImportJob[] {
  const records = read(IMPORT_JOBS_KEY, IMPORT_JOBS_SEED)
  if (typeof window !== "undefined" && !window.localStorage.getItem(IMPORT_JOBS_KEY)) {
    write(IMPORT_JOBS_KEY, records)
  }
  return records
}

export function completeImportJob(input: { module: string; file: string; rowCount: number }) {
  const failed = Math.floor(input.rowCount * 0.02)
  const skipped = Math.floor(input.rowCount * 0.01)
  const success = Math.max(0, input.rowCount - failed - skipped)
  const record: ImportJob = {
    id: `imp_${Date.now().toString(36)}`,
    module: input.module,
    file: input.file,
    success,
    failed,
    skipped,
    status: failed > 0 ? "Completed with errors" : "Completed",
    when: new Date().toISOString().slice(0, 16).replace("T", " "),
  }
  write(IMPORT_JOBS_KEY, [record, ...listImportJobs()])
  return record
}

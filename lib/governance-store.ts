"use client"

// SPECS 69–72 — frontend-only governance data stores. There is no backend
// enforcement yet: classification, field security, retention, and legal
// hold decisions here do not actually affect API responses, exports, or
// scheduled jobs (see lib/platform-guard.ts for the real, server-enforced
// role guard). These stores only drive the governance UI so every screen
// is fully exercisable — create, edit, release/pause — without a backend.
// Codex will replace this with real, server-enforced policies and jobs.

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
// Classification mappings (Spec 69)
// ---------------------------------------------------------------------------

export type ClassificationLevel = "Public" | "Internal" | "Confidential" | "Restricted" | "Highly Restricted"

export type ClassificationMapping = {
  id: string
  module: string
  entity: string
  field: string
  level: ClassificationLevel
  createdAt: number
}

const CLASSIFICATION_KEY = "muenot.governance.classification.v1"
const CLASSIFICATION_SEED: ClassificationMapping[] = [
  { id: "cm-1", module: "HR", entity: "Employee", field: "Bank account number", level: "Highly Restricted", createdAt: 0 },
  { id: "cm-2", module: "HR", entity: "Employee", field: "PAN / tax ID", level: "Restricted", createdAt: 0 },
  { id: "cm-3", module: "HR", entity: "Employee", field: "Salary (CTC)", level: "Restricted", createdAt: 0 },
  { id: "cm-4", module: "Finance", entity: "Invoice", field: "Line-item pricing", level: "Confidential", createdAt: 0 },
  { id: "cm-5", module: "CRM", entity: "Customer", field: "Contact email", level: "Internal", createdAt: 0 },
  { id: "cm-6", module: "Sales", entity: "Deal", field: "Deal value", level: "Confidential", createdAt: 0 },
  { id: "cm-7", module: "Storage", entity: "File", field: "Entire record", level: "Public", createdAt: 0 },
]

export function listClassificationMappings(): ClassificationMapping[] {
  const records = read(CLASSIFICATION_KEY, CLASSIFICATION_SEED)
  if (typeof window !== "undefined" && !window.localStorage.getItem(CLASSIFICATION_KEY)) {
    write(CLASSIFICATION_KEY, records)
  }
  return records
}

export function upsertClassificationMapping(input: Omit<ClassificationMapping, "id" | "createdAt"> & { id?: string }) {
  const records = listClassificationMappings()
  if (input.id) {
    write(
      CLASSIFICATION_KEY,
      records.map((r) => (r.id === input.id ? { ...r, ...input } : r)),
    )
  } else {
    const record: ClassificationMapping = { ...input, id: `cm-${Date.now().toString(36)}`, createdAt: Date.now() }
    write(CLASSIFICATION_KEY, [record, ...records])
  }
}

export function deleteClassificationMapping(id: string) {
  write(CLASSIFICATION_KEY, listClassificationMappings().filter((r) => r.id !== id))
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

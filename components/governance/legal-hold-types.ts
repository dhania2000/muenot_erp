// client-facing shapes for the Legal Hold admin UI. These mirror the
// server types in lib/legal-hold-store.ts but stay import-light for the client.

export type LegalHoldScope = "module" | "record_type" | "record" | "criteria" | "file"
export type LegalHoldStatus = "active" | "released"

export type LegalHoldItem = {
  id: number
  holdId: number
  scope: LegalHoldScope
  module: string | null
  catalogKey: string | null
  recordType: string | null
  recordRef: string | null
  matchField: string | null
  matchValue: string | null
  fileId: number | null
  note: string | null
  label: string
  createdByName: string | null
  createdAt: string
}

export type LegalHold = {
  id: number
  tenantId: number | null
  name: string
  reason: string | null
  status: LegalHoldStatus
  createdByName: string | null
  createdAt: string
  updatedAt: string
  releasedByName: string | null
  releasedReason: string | null
  releasedAt: string | null
  itemCount: number
  items?: LegalHoldItem[]
}

export type LegalHoldCatalogItem = {
  key: string
  module: string
  recordType: string
  description: string
}

export const SCOPE_LABELS: Record<LegalHoldScope, string> = {
  module: "Entire module",
  record_type: "Record type",
  record: "Single record",
  criteria: "Field / value match",
  file: "Storage file",
}

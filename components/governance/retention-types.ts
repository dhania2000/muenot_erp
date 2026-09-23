// client-side shape of the retention engine's API responses. These
// mirror the server types in lib/retention-engine.ts but carry no server-only
// import so they can be shared freely across the governance UI.

export type RetentionAction = "archive" | "delete"
export type RetentionStatus = "active" | "paused"
export type RetentionRunState = "active" | "paused" | "held"
export type RetentionExceptionType = "record" | "criteria"

export type RetentionPolicy = {
  id: number
  tenantId: number | null
  catalogKey: string | null
  module: string
  recordType: string
  retentionDays: number
  retentionLabel: string
  action: RetentionAction
  purgeAfterArchive: boolean
  status: RetentionStatus
  legalHold: boolean
  legalHoldReason: string | null
  runState: RetentionRunState
  lastRunAt: string | null
  lastRunAffected: number
  nextRunAt: string | null
  createdByName: string | null
  createdAt: string
  updatedAt: string
  exceptionCount: number
}

export type RetentionException = {
  id: number
  policyId: number
  type: RetentionExceptionType
  recordRef: string | null
  matchField: string | null
  matchValue: string | null
  reason: string | null
  createdByName: string | null
  createdAt: string
}

export type RetentionRun = {
  id: number
  policyId: number
  triggerSource: "scheduler" | "manual"
  status: "success" | "skipped" | "failed"
  action: RetentionAction
  evaluated: number
  archived: number
  deleted: number
  skippedExempt: number
  reason: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
  actorName: string | null
}

export type RetentionCatalogItem = {
  key: string
  module: string
  recordType: string
  description: string
  allowDelete: boolean
  suggestedDays: number
}

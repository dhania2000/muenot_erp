/** Client-side mirrors of the SPEC 98 scheduler API shapes. */

export type ReportSchedule = {
  id: number
  reportId: number
  reportName: string
  frequency: "daily" | "weekly" | "monthly" | "custom"
  cronExpression: string
  timezone: string
  format: "pdf" | "xlsx" | "csv"
  channel: "email" | "storage"
  recipients: string[]
  status: "active" | "paused"
  description: string
  lastRunAt: string | null
  lastStatus: string | null
  createdByName: string | null
  createdAt: string
}

export type ReportScheduleRun = {
  id: number
  scheduleId: number
  status: "success" | "failed" | "skipped"
  format: "pdf" | "xlsx" | "csv"
  channel: "email" | "storage"
  rowCount: number
  byteSize: number
  recipientsCount: number
  fileName: string | null
  error: string | null
  triggerSource: "scheduler" | "manual"
  downloadUrl: string | null
  startedAt: string
  finishedAt: string | null
}

export type SchedulerOption = { value: string; label: string }

export type SchedulerMetadata = {
  frequencies: SchedulerOption[]
  formats: SchedulerOption[]
  channels: SchedulerOption[]
  caps: {
    maxRecipients: number
    maxArtifactBytes: number
    downloadTtlMs: number
    maxRunHistory: number
  }
}

export type ScheduledJob = {
  id: number
  tenantId: number
  name: string
  actionKey: string
  actionParams: Record<string, unknown>
  presetKey: string
  cronExpression: string
  timezone: string
  startAt: string | null
  endAt: string | null
  enabled: boolean
  maxAttempts: number
  notifyOnFailure: boolean
  notifyOnSuccess: boolean
  notifyEmails: string[]
  nextRunAt: string | null
  lastRunAt: string | null
  lastStatus: string | null
  version: number
  ownerUserId: number
  createdAt: string
  updatedAt: string
}

export type ScheduledJobRun = {
  id: number
  scheduleId: number
  triggerSource: "scheduler" | "manual"
  scheduledFor: string
  status: string
  skipReason: string | null
  attempts: number
  maxAttempts: number
  backgroundJobId: number | null
  nextRetryAt: string | null
  errorMessage: string | null
  result: Record<string, unknown> | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export type JobActionMeta = {
  key: string
  label: string
  description: string
  retrySafe: boolean
}

export type JobPreset = { key: string; label: string; expression: string | null }

export type JobMetadata = {
  actions: JobActionMeta[]
  presets: JobPreset[]
  limits: {
    maxSchedulesPerTenant: number
    concurrencyPerTenant: number
    dispatchPerTenantPerTick: number
    minIntervalMinutes: number
    maxAttempts: number
    maxNotifyEmails: number
  }
  formats: { value: string; label: string }[]
  datasets: { key: string; label: string; module: string }[]
  reportSchedules: { id: number; label: string }[]
}

export type ListResponse = {
  jobs: ScheduledJob[]
  overview: Record<string, number>
  metadata: JobMetadata
}

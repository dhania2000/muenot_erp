/** Optional provider contract. No Hostinger adapter is enabled without a supported API. */
export type ExternalLogEntry = {
  timestamp: string
  severity: "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL"
  service: string
  safeMessage: string
  referenceId?: string
}

export interface ExternalLogProvider {
  readonly id: string
  isAvailable(): Promise<boolean>
  fetchLogs(input: { since: Date; limit: number }): Promise<unknown[]>
  normalizeLogs(entries: unknown[]): ExternalLogEntry[]
}

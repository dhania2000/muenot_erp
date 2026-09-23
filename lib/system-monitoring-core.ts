import { createHash, randomUUID } from "node:crypto"

export type MonitorSeverity = "DEBUG" | "INFO" | "NOTICE" | "WARNING" | "ERROR" | "CRITICAL"
export const SEVERITIES: MonitorSeverity[] = ["DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL"]
const SECRET_KEY = /(?:password|passwd|pwd|secret|token|authorization|cookie|api[_-]?key|otp|pin|cvv|cvc|card[_-]?number|private[_-]?key|credential|signature|auth[_-]?code|session[_-]?state|headers?|raw[_-]?(?:body|payload|sql)|sql|query|payload)/i
const SAFE_ID = /^[a-zA-Z0-9_.:-]{1,100}$/

export function requestReference(value?: string | null): string {
  return value && SAFE_ID.test(value) ? value : `req_${randomUUID()}`
}

export function redactString(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/gi, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,'"}]+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:accessToken|refreshToken|clientSecret|appSecret|apiKey|password|authorization|cookie|otp)["']?\s*[:=]\s*["'])[^"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret|api[_-]?key|password|passwd|authorization|cookie|code|otp|cvv)\b\s*[=:]\s*[^\s,&;'"}]+/gi, (match) => `${match.split(/[=:]/)[0]}=[REDACTED]`)
    .replace(/([?&](?:token|code|secret|key|signature|password|access_token|refresh_token)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(?:\d[ -]*?){13,19}\b/g, "[REDACTED]")
    .slice(0, 4096)
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[TRUNCATED]"
  if (typeof value === "string") return redactString(value)
  if (typeof value === "number" || typeof value === "boolean" || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redact(item, depth + 1))
  if (value instanceof Error) return { name: value.name, message: redactString(value.message), stack: redactString(value.stack || "").slice(0, 2000) }
  if (typeof value !== "object") return "[UNSUPPORTED]"
  return Object.fromEntries(Object.entries(value).slice(0, 50).map(([key, item]) => [key.slice(0, 80), SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1)]))
}

export function fingerprintOf(event: { environment: string; service: string; component?: string | null; operation?: string | null; errorCode?: string | null; message: string }): string {
  const normalized = event.errorCode || redactString(event.message).replace(/\b\d+\b/g, "#").replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "#").slice(0, 180)
  return createHash("sha256").update([event.environment, event.service, event.component || "", event.operation || "", normalized].join("|")) .digest("hex")
}

export function safeDbError(error: unknown): Record<string, string> {
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>
  const safe = (key: string) => typeof e[key] === "string" && /^[A-Z0-9_]{1,80}$/.test(e[key] as string) ? e[key] as string : undefined
  const result: Record<string, string> = {}
  if (safe("code")) result.databaseErrorCode = safe("code")!
  if (safe("sqlState")) result.sqlState = safe("sqlState")!
  // MySQL's raw sqlMessage can contain query values. Never retain it.
  return result
}

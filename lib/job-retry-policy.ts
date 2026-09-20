export type FailureKind = "transient" | "permanent" | "uncertain"
export function classifyJobFailure(error: unknown, timedOut = false): FailureKind {
  if (timedOut) return "uncertain"
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>
  const code = String(e.code ?? "")
  const status = Number(e.status ?? e.responseCode ?? 0)
  // A dropped connection or timeout may occur after remote acceptance.
  if (["ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE"].includes(code) || e.name === "AbortError") return "uncertain"
  // SMTP 4xx means temporary rejection; 5xx means permanent rejection.
  // Check numeric SMTP response before broad transport error codes.
  if (e.responseCode != null && status >= 400 && status < 600) return status < 500 ? "transient" : "permanent"
  if (["EAUTH", "EENVELOPE", "EMESSAGE"].includes(code)) return "permanent"
  if (status >= 400 && status < 500 && status !== 429) return "permanent"
  if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"].includes(code) || status === 429 || status >= 500 && status < 600) return "transient"
  return "uncertain"
}
export function retryDisposition(kind: FailureKind, attempts: number, maxAttempts: number): "queued" | "dead_letter" {
  return kind === "transient" && attempts < maxAttempts ? "queued" : "dead_letter"
}

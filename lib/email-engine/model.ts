import crypto from "crypto"

export const EMAIL_MODULES = ["sales", "hr", "finance", "operations", "recruit", "system"] as const
export type EmailModule = (typeof EMAIL_MODULES)[number]

export type EmailAttachmentReference = { pathname: string; filename?: string }

export type EmailRequest = {
  tenantId: number
  actorId?: number | null
  module: EmailModule
  to: string
  toName?: string | null
  subject: string
  html: string
  templateId?: number | null
  replyToMessageId?: number | null
  attachments?: EmailAttachmentReference[]
  trackingConsent?: boolean
  idempotencyKey?: string
}

export function validateEmailRequest(input: EmailRequest): EmailRequest {
  if (!Number.isSafeInteger(input.tenantId) || input.tenantId <= 0) throw new Error("A tenant is required")
  if (!EMAIL_MODULES.includes(input.module)) throw new Error("Invalid email module")
  const to = input.to.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error("A valid recipient email is required")
  const subject = input.subject.trim()
  if (!subject || subject.length > 255) throw new Error("Subject must contain 1 to 255 characters")
  if (!input.html || input.html.length > 200_000) throw new Error("Email body must contain 1 to 200000 characters")
  const attachments = input.attachments ?? []
  if (attachments.length > 10 || attachments.some((a) => !/^\/api\/email-attachments\/[A-Za-z0-9_-]+$/.test(a.pathname))) {
    throw new Error("Invalid email attachment reference")
  }
  return { ...input, to, subject, attachments }
}

/** Literal-only variable replacement. Expressions are intentionally unsupported. */
export function renderEmailTemplate(source: string, variables: Record<string, string | number | null | undefined>) {
  return source.replace(/{{\s*([a-zA-Z][\w.]*)\s*}}/g, (_match, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) throw new Error(`Missing email template variable: ${key}`)
    return String(variables[key] ?? "")
  })
}

export function trackingToken() {
  return crypto.randomBytes(24).toString("hex")
}

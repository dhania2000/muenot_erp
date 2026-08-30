import nodemailer from "nodemailer"
import crypto from "crypto"

// SMTP transport configured via environment variables.
// Add these to .env.local (locally) or your Hostinger hosting panel:
//   SMTP_HOST     - e.g. smtp.hostinger.com
//   SMTP_PORT     - e.g. 465 (SSL) or 587 (TLS)
//   SMTP_SECURE   - "true" for port 465, "false" for 587
//   SMTP_USER     - the mailbox / SMTP username
//   SMTP_PASS     - the mailbox / SMTP password
//   SMTP_FROM     - default From address, e.g. "Muenot Sales <sales@muenot.co.in>"
//   APP_URL       - public base URL of this app, used to build the tracking
//                   pixel link, e.g. https://erp.muenot.co.in

let transporter: nodemailer.Transporter | null = null

export function isEmailConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
}

function getTransporter() {
  if (transporter) return transporter
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || "false") === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  })
  return transporter
}

export function generateTrackingToken() {
  return crypto.randomBytes(24).toString("hex")
}

/** Resolve the public base URL used for the tracking pixel. */
export function resolveBaseUrl(request: Request) {
  const fromEnv = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
  if (fromEnv) return fromEnv.replace(/\/$/, "")
  // Fall back to the incoming request origin.
  const url = new URL(request.url)
  const proto = request.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")
  const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || url.host
  return `${proto}://${host}`
}

/**
 * Build the final HTML with an invisible 1x1 tracking pixel appended.
 * The recipient cannot tell the pixel is there — it renders as a blank 1px image.
 */
export function withTrackingPixel(html: string, baseUrl: string, token: string) {
  const pixel = `<img src="${baseUrl}/api/track/${token}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;outline:none;" />`
  return `${html}${pixel}`
}

/** Merge {{field}} placeholders in a template with lead values. */
export function renderTemplate(text: string, vars: Record<string, string | null | undefined>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => {
    const val = vars[key]
    return val != null && val !== "" ? String(val) : ""
  })
}

export async function sendEmail(opts: {
  to: string
  from?: string
  subject: string
  html: string
}) {
  const from = opts.from || process.env.SMTP_FROM || process.env.SMTP_USER
  const info = await getTransporter().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  })
  return info
}

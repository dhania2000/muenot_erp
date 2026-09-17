import { NextResponse } from "next/server"
import {
  ensureLeadGenSchema,
  getPublicForm,
  recordFormView,
  processSubmission,
  SubmissionRejectedError,
} from "@/lib/marketing/leadgen-db"

// Public, unauthenticated capture endpoint. Guarded only by the unguessable
// public_token, server-side validation, a honeypot and per-IP rate limiting.

function publicView(form: any) {
  return {
    form_code: form.form_code,
    public_token: form.public_token,
    name: form.name,
    description: form.description,
    type: form.type,
    submit_label: form.submit_label,
    success_message: form.success_message,
    redirect_url: form.redirect_url,
    theme_color: form.theme_color,
    fields: form.fields.map((f: any) => ({
      field_key: f.field_key,
      label: f.label,
      type: f.type,
      placeholder: f.placeholder,
      help_text: f.help_text,
      required: f.required,
      options: f.options,
    })),
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  await ensureLeadGenSchema()
  const { token } = await params
  const form = await getPublicForm(token)
  if (!form) return NextResponse.json({ error: "Form not available" }, { status: 404 })
  await recordFormView(form.id)
  return NextResponse.json({ form: publicView(form) })
}

function clientIp(request: Request): string | null {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0].trim()
  return request.headers.get("x-real-ip")
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  await ensureLeadGenSchema()
  const { token } = await params
  const form = await getPublicForm(token)
  if (!form) return NextResponse.json({ error: "Form not available" }, { status: 404 })

  let body: Record<string, any> = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const data = body?.data && typeof body.data === "object" ? body.data : {}
  const honeypot = typeof body?._hp === "string" ? body._hp : ""

  try {
    const result = await processSubmission(form, data, {
      ip: clientIp(request),
      userAgent: request.headers.get("user-agent"),
      referrer: typeof body?.referrer === "string" ? body.referrer : request.headers.get("referer"),
      utm: body?.utm && typeof body.utm === "object" ? body.utm : null,
      honeypot,
    })
    return NextResponse.json({
      ok: true,
      status: result.status,
      success_message: form.success_message || "Thanks! We'll be in touch shortly.",
      redirect_url: form.redirect_url || null,
    })
  } catch (error) {
    if (error instanceof SubmissionRejectedError) {
      return NextResponse.json({ error: error.message, fields: error.fields }, { status: error.status })
    }
    console.error("[leadgen] public submission failed", error)
    return NextResponse.json({ error: "Unable to submit right now" }, { status: 500 })
  }
}

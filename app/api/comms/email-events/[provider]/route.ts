import { NextResponse } from "next/server"
import { ingestEmailEvents } from "@/lib/comms-governance/service"
import { EMAIL_EVENT_PROVIDERS, verifyEventSignature, type EmailEventProvider } from "@/lib/comms-governance/model"
import { monitorLogger } from "@/lib/system-monitoring"

/**
 * Spec41 — email provider bounce / complaint / delivery webhook.
 *
 * This endpoint has NO ERP session: it is called by the email provider. Its
 * authenticity comes from a shared-secret HMAC over `${timestamp}.${rawBody}`
 * (COMMS_EMAIL_WEBHOOK_SECRET), verified in constant time with a timestamp
 * tolerance to defeat replay. The tenant is derived ONLY from the platform's
 * own sent message (never the payload), and the (tenant, provider, event id)
 * unique key drops duplicate provider retries.
 *
 * Bodies are always acknowledged with 200 once authenticated so the provider
 * does not retry endlessly; unattributed events are counted, not errored.
 */

function isProvider(v: string): v is EmailEventProvider {
  return (EMAIL_EVENT_PROVIDERS as readonly string[]).includes(v)
}

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params
  if (!isProvider(provider)) return NextResponse.json({ error: "Unknown provider" }, { status: 404 })

  const rawBody = await request.text()
  const secret = process.env.COMMS_EMAIL_WEBHOOK_SECRET
  const ok = verifyEventSignature({
    secret,
    rawBody,
    timestamp: request.headers.get("x-comm-timestamp"),
    signature: request.headers.get("x-comm-signature"),
  })
  if (!ok) {
    monitorLogger.warning({
      service: "webhook",
      component: "comms-email-events",
      operation: "signature_verification",
      errorCode: "INVALID_WEBHOOK_SIGNATURE",
      message: "Email events webhook signature rejected",
      route: "/api/comms/email-events/[provider]",
      method: "POST",
      httpStatus: 403,
      requestId: request.headers.get("x-request-id") || undefined,
    })
    return new NextResponse("Invalid signature", { status: 403 })
  }

  let body: unknown
  try {
    body = JSON.parse(rawBody)
  } catch {
    // Acknowledge malformed bodies so the provider does not retry endlessly.
    return NextResponse.json({ ok: true, processed: 0 })
  }

  try {
    const result = await ingestEmailEvents(provider, body)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    monitorLogger.error({
      service: "webhook",
      component: "comms-email-events",
      operation: "ingest",
      errorCode: "EMAIL_EVENT_INGEST_FAILED",
      message: "Email events ingestion failed",
      route: "/api/comms/email-events/[provider]",
      method: "POST",
      requestId: request.headers.get("x-request-id") || undefined,
    })
    // Still 200 so a transient failure does not trigger an endless retry storm;
    // the event ledger is idempotent, so a manual replay is safe.
    return NextResponse.json({ ok: true, processed: 0 })
  }
}

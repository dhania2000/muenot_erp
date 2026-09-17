import "server-only"
import { NextRequest, NextResponse } from "next/server"
import { requireFeature } from "@/lib/api-auth"
import { query } from "@/lib/db"
import {
  cancelHubEmail,
  createHubEmail,
  dispatchDueHubEmails,
  ensureHubSchema,
  getHubBackend,
  getHubEmail,
  hubAnalytics,
  listHubAutomations,
  listHubEmails,
  parseAddressList,
  sendHubEmailRow,
  upsertHubAutomation,
  type HubBackend,
} from "@/lib/email-hub"
import type { EmailHubModuleKey } from "@/lib/email-hub-shared"

/**
 * Thin Next.js route-handler factories over the config-driven Email Hub service
 * (lib/email-hub.ts). Operations and Recruitment both mount the same handlers,
 * differing only by module key and the feature slug that guards them, so the two
 * hubs stay in lockstep with the proven HR / Finance / Sales implementations.
 */

type Cfg = { module: EmailHubModuleKey; feature: string }

function backendFor(module: EmailHubModuleKey): HubBackend {
  const backend = getHubBackend(module)
  if (!backend) throw new Error(`Unknown email hub module: ${module}`)
  return backend
}

/** GET — paginated history + summary cards. */
export function hubListHandler({ module, feature }: Cfg) {
  return async (request: NextRequest) => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    const sp = request.nextUrl.searchParams
    const result = await listHubEmails(backend, {
      q: sp.get("q") || undefined,
      status: sp.get("status") || undefined,
      category: sp.get("category") || undefined,
      page: Number(sp.get("page") || 1),
      pageSize: Number(sp.get("pageSize") || 25),
    })
    return NextResponse.json(result)
  }
}

/** POST — compose (send / draft / schedule), single or bulk. */
export function hubCreateHandler({ module, feature }: Cfg) {
  return async (request: NextRequest) => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)

    const body = await request.json().catch(() => ({}))
    const mode: "send" | "draft" | "schedule" =
      body.mode === "draft" || body.mode === "schedule" ? body.mode : "send"
    const category = (body.category || "General").trim() || "General"

    const shared = {
      cc: body.cc ?? null,
      bcc: body.bcc ?? null,
      subject: body.subject,
      body: body.body,
      templateId: body.template_id ?? null,
      category,
      sourceModule: "manual",
      emailType: "Manual" as const,
      scheduledAt: body.scheduled_at ?? null,
      mode,
      createdBy: (session as any).userId ?? null,
      attachment: body.attachment ?? null,
    }

    // Built-in recipient source (employees / candidates): resolve each id to a
    // real address + personalization vars and create one record per recipient.
    const recipientIds: string[] = Array.isArray(body.recipient_ids)
      ? body.recipient_ids.map((v: any) => String(v)).filter(Boolean)
      : body.recipient_id != null && String(body.recipient_id) !== ""
        ? [String(body.recipient_id)]
        : []

    if (recipientIds.length) {
      const results = []
      for (const rid of recipientIds) {
        const recipient = await backend.resolveRecipient(rid)
        if (!recipient) {
          results.push({ ok: false as const, error: `Recipient ${rid} not found or has no email` })
          continue
        }
        results.push(
          await createHubEmail(backend, {
            ...shared,
            toEmail: recipient.email,
            toName: recipient.name,
            recipientRef: rid,
            vars: recipient.vars,
            render: true,
          }),
        )
      }
      const failures = results.filter((r) => !r.ok)
      return NextResponse.json({
        ok: failures.length === 0,
        created: results.filter((r) => r.ok).length,
        failed: failures.length,
        errors: failures.map((r) => (r.ok ? null : r.error)).filter(Boolean),
      })
    }

    // Manual single recipient.
    const toList = parseAddressList(body.to_email)
    const result = await createHubEmail(backend, {
      ...shared,
      toEmail: toList[0] ?? body.to_email ?? null,
      toName: body.to_name ?? null,
      render: false,
    })
    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.code || 400 })
    }
    return NextResponse.json({
      ok: true,
      id: result.id,
      email_uid: result.emailUid,
      status: result.status,
    })
  }
}

/** GET one email (detail dialog). */
export function hubItemGetHandler({ module, feature }: Cfg) {
  return async (_request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    const { id } = await ctx.params
    const email = await getHubEmail(backend, Number(id))
    if (!email) return NextResponse.json({ error: "Not found" }, { status: 404 })
    return NextResponse.json({ email })
  }
}

/** PATCH — lifecycle actions: (re)send now, or cancel a pending/draft email. */
export function hubItemPatchHandler({ module, feature }: Cfg) {
  return async (request: NextRequest, ctx: { params: Promise<{ id: string }> }) => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    const { id } = await ctx.params
    const numericId = Number(id)
    const { action } = await request.json().catch(() => ({}))

    if (action === "cancel") {
      const ok = await cancelHubEmail(backend, numericId)
      if (!ok) return NextResponse.json({ error: "This email can no longer be cancelled" }, { status: 400 })
      return NextResponse.json({ ok: true, status: "Cancelled" })
    }
    if (action === "send" || action === "resend") {
      const result = await sendHubEmailRow(backend, numericId)
      return NextResponse.json({ ok: result.status === "Sent", status: result.status, error: result.error })
    }
    return NextResponse.json({ error: "Unknown action" }, { status: 400 })
  }
}

/** GET — recipient picker source (module-specific). */
export function hubRecipientsHandler({ module, feature }: Cfg) {
  return async (request: NextRequest) => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    const q = request.nextUrl.searchParams.get("q") || ""
    const recipients = await backend.listRecipients(q)
    return NextResponse.json({ recipients })
  }
}

/** GET — delivery + engagement analytics. */
export function hubAnalyticsHandler({ module, feature }: Cfg) {
  return async () => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    return NextResponse.json(await hubAnalytics(backend))
  }
}

/** GET — automation catalog with saved config. */
export function hubAutomationsGetHandler({ module, feature }: Cfg) {
  return async () => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    const events = await listHubAutomations(backend)
    return NextResponse.json({ events, canManage: true })
  }
}

/** PATCH — enable/disable an event or map it to a template. */
export function hubAutomationsPatchHandler({ module, feature }: Cfg) {
  return async (request: NextRequest) => {
    const session = await requireFeature(feature)
    if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const backend = backendFor(module)
    const body = await request.json().catch(() => ({}))
    const key = String(body.event_key || "")
    if (!key) return NextResponse.json({ error: "event_key is required" }, { status: 400 })

    const patch: { enabled?: boolean; template_id?: number | null; subject?: string | null; cc?: string | null } = {}
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled
    if ("template_id" in body) {
      patch.template_id = body.template_id == null || body.template_id === "" ? null : Number(body.template_id)
    }
    if ("subject" in body) patch.subject = body.subject || null
    if ("cc" in body) patch.cc = body.cc || null

    const ok = await upsertHubAutomation(backend, key, patch, (session as any).userId ?? null)
    if (!ok) return NextResponse.json({ error: "Unknown event" }, { status: 400 })
    return NextResponse.json({ ok: true })
  }
}

/** POST — process due scheduled/queued emails (cron or manual trigger). */
export function hubDispatchHandler({ module }: { module: EmailHubModuleKey }) {
  return async () => {
    const backend = backendFor(module)
    const result = await dispatchDueHubEmails(backend)
    return NextResponse.json(result)
  }
}

/** GET — 1x1 tracking pixel; opens are keyed by the email's thread token. */
export function hubTrackHandler({ module }: { module: EmailHubModuleKey }) {
  const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64")
  return async (_request: NextRequest, ctx: { params: Promise<{ token: string }> }) => {
    const backend = backendFor(module)
    const { token } = await ctx.params
    await ensureHubSchema(backend)
    await query(
      `UPDATE \`${backend.table}\` SET open_count = open_count + 1, opened_at = COALESCE(opened_at, NOW()) WHERE thread_id = ?`,
      [token],
    ).catch(() => {})
    return new NextResponse(PIXEL, {
      headers: { "Content-Type": "image/gif", "Cache-Control": "no-store, no-cache, must-revalidate" },
    })
  }
}

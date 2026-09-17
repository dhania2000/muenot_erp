import { NextRequest, NextResponse } from "next/server"
import { query, tableColumns } from "@/lib/db"
import { getSession } from "@/lib/auth"
import {
  sendEmail,
  withTrackingPixel,
  renderTemplate,
  baseSubject,
  buildMessageId,
  buildNewThreadId,
  buildRecipientKey,
  generateTrackingToken,
  getLatestThreadByEmailId,
  getLatestThreadIdByEmail,
} from "@/lib/email"
import { ensureOperationsSchema } from "@/lib/operations-ensure"
import {
  resolveOperationsEmailContext,
  type OperationsEmailEntity,
} from "@/lib/operations-email"

const ENTITY_TYPES = new Set<OperationsEmailEntity>([
  "project",
  "client",
  "employee",
  "task",
  "deliverable",
  "issue",
  "sla",
  "milestone",
])

export async function GET(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const sp = request.nextUrl.searchParams
  const entityType = sp.get("entity_type")
  const entityId = sp.get("entity_id")
  const projectId = sp.get("project_id")

  // Email history filtered to a specific linked entity / project (Phase 63).
  const where: string[] = []
  const args: any[] = []
  if (entityType && entityId) {
    where.push("entity_type = ? AND entity_id = ?")
    args.push(entityType, String(entityId))
  } else if (projectId) {
    where.push("project_id = ?")
    args.push(String(projectId))
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : ""
  const emails = await query<any[]>(
    `SELECT * FROM operations_emails ${clause} ORDER BY created_at DESC LIMIT 200`,
    args,
  ).catch(() => [] as any[])
  return NextResponse.json({ emails })
}

export async function POST(request: NextRequest) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  await ensureOperationsSchema()

  const body = await request.json()
  const entityType =
    body.entity_type && ENTITY_TYPES.has(body.entity_type) ? (body.entity_type as OperationsEmailEntity) : null
  const entityId = body.entity_id != null && String(body.entity_id) !== "" ? String(body.entity_id) : null

  // Resolve placeholder values + linking context from real source rows (Phase 62/63).
  let vars: Record<string, string | null | undefined> = {}
  let projectId: string | null = null
  let clientName: string | null = null
  let defaultTo: string | null = null
  if (entityType && entityId) {
    const ctx = await resolveOperationsEmailContext(entityType, entityId)
    vars = ctx.vars
    projectId = ctx.projectId
    clientName = ctx.clientName
    defaultTo = ctx.defaultTo
  }

  const to = String(body.to || defaultTo || "").trim()
  let subject = String(body.subject || "").trim()
  let bodyText = String(body.body || "")
  if (!to || !subject || !bodyText) {
    return NextResponse.json({ error: "Recipient, subject and body are required" }, { status: 400 })
  }

  // Apply placeholders to both subject and body so a template becomes a real,
  // personalised message before it is stored and sent.
  subject = renderTemplate(subject, vars)
  bodyText = renderTemplate(bodyText, vars)

  // Threading (Phase 64): a follow-up continues the referenced conversation;
  // anything else starts a fresh thread keyed to the recipient.
  const token = generateTrackingToken()
  const messageId = buildMessageId(token, "operations")
  let threadId: string | null = null
  let inReplyTo: string | null = null
  let references: string | null = null
  let providerThreadId: string | null = null

  const replyToId = body.reply_to_email_id ? Number(body.reply_to_email_id) : null
  if (replyToId) {
    const prev = await getLatestThreadByEmailId(replyToId).catch(() => null)
    if (prev) {
      threadId = prev.threadId ?? null
      inReplyTo = prev.messageId ?? null
      references = prev.references ? `${prev.references} ${prev.messageId ?? ""}`.trim() : prev.messageId ?? null
      providerThreadId = prev.providerThreadId ?? null
      subject = `Re: ${baseSubject(subject)}`
    }
  }
  if (!threadId) {
    // Continue an existing conversation with this recipient if one exists,
    // otherwise open a new thread.
    threadId = await getLatestThreadIdByEmail(to).catch(() => null)
    if (!threadId) threadId = buildNewThreadId(buildRecipientKey(null, to), token)
  }

  // Persist the email row up front (Queued), storing linking + threading columns
  // only when the base table has them (schema-defensive).
  const cols = await tableColumns("operations_emails")
  const record: Record<string, unknown> = {
    to_email: to,
    subject,
    body: bodyText,
    status: "Queued",
    created_by: session.userId ?? null,
    entity_type: entityType,
    entity_id: entityId,
    project_id: projectId,
    client_name: clientName,
    template_id: body.template_id ? Number(body.template_id) : null,
    thread_id: threadId,
    message_id: messageId,
    in_reply_to: inReplyTo,
    references_hdr: references,
    provider_thread_id: providerThreadId,
  }
  const keys = Object.keys(record).filter((k) => cols.has(k))
  const insert = await query<any>(
    `INSERT INTO operations_emails (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    keys.map((k) => (record[k] === "" ? null : record[k])),
  )
  const id = insert.insertId

  const html = withTrackingPixel(bodyText, process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000", id).replace(
    `/api/track/${id}`,
    `/api/operations/emails/track/${id}`,
  )
  try {
    const sent = await sendEmail({
      to,
      subject,
      html,
      department: "operations",
      messageId,
      inReplyTo: inReplyTo ?? undefined,
      references: references ?? undefined,
      providerThreadId: providerThreadId ?? undefined,
    })
    const setProvider = cols.has("provider_thread_id") && sent.providerThreadId ? ", provider_thread_id=?" : ""
    const args: any[] = []
    if (setProvider) args.push(sent.providerThreadId)
    args.push(id)
    await query(`UPDATE operations_emails SET status='Sent', sent_at=NOW()${setProvider} WHERE id=?`, args)
  } catch {
    await query("UPDATE operations_emails SET status='Failed' WHERE id=?", [id])
    return NextResponse.json({ error: "Email send failed" }, { status: 500 })
  }
  return NextResponse.json({ id, status: "Sent", thread_id: threadId }, { status: 201 })
}

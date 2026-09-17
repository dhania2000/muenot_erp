import "server-only"
import { query, pool } from "@/lib/db"
import {
  ensureEsignTables,
  getEsignRequest,
  getRequestSigners,
  getSigner,
  generateSignToken,
  recomputeRequestStatus,
  isSignerTurn,
  logEsignEvent,
  storeEsignFile,
  getEsignFile,
} from "@/lib/legal-esign"
import { getSignatory } from "@/lib/legal-esign-signatories"
import { ensureBasePdf, storeSignedPdf } from "@/lib/legal-esign-pdf"
import { sendSigningRequestEmail, sendSignedDocumentEmail } from "@/lib/legal-esign-email"
import {
  isInternalSignerType,
  isTerminalStatus,
  SIGNATURE_IMAGE_TYPES,
  SIGNATURE_MAX_BYTES,
} from "@/lib/legal-esign-shared"
import type { EsignRequest, EsignSigner, SignatureMethod } from "@/lib/legal-esign-shared"

// ---------------------------------------------------------------------------
// Legal E-sign — workflow orchestration (server-only).
//
// The state machine that ties the core library together: preparing & sending a
// request (secure per-signer tokens), advancing sequential order, applying a
// signature onto the signed-PDF version, rejection, cancellation, resend,
// expiry and reminder sweeps. Every transition is idempotent and audited, and
// concurrent signing is serialized with a row lock so a signature can never be
// duplicated (Phases 62, 63, 83, 94).
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_DAYS = 14

function tokenExpiry(request: EsignRequest): Date {
  // Link lives until the due date's end-of-day, or a default window when no due
  // date was set. A comfortable buffer is added past the due date so a signer
  // who opens the email on the final day can still complete.
  if (request.due_date) {
    const d = new Date(request.due_date)
    d.setHours(23, 59, 59, 0)
    d.setDate(d.getDate() + 3)
    return d
  }
  const d = new Date()
  d.setDate(d.getDate() + DEFAULT_TOKEN_DAYS)
  return d
}

/** Mint a fresh single-use token for a signer and persist only its hash. */
async function issueToken(signerId: number, expires: Date): Promise<string> {
  const { raw, hash } = generateSignToken()
  await query(
    `UPDATE legal_esign_signers
        SET token_hash = ?, token_expires_at = ?, token_used = 0
      WHERE id = ?`,
    [hash, expires, signerId],
  )
  return raw
}

/** Which signers should currently receive a signing email. */
function dispatchTargets(request: EsignRequest, signers: EsignSigner[]): EsignSigner[] {
  const open = signers.filter((s) => s.status !== "Signed" && s.status !== "Rejected")
  if (request.signing_type === "parallel") return open
  // Sequential: only the lowest-order signer who has not yet signed.
  const sorted = [...open].sort((a, b) => a.signing_order - b.signing_order)
  return sorted.length ? [sorted[0]] : []
}

export type SendResult = {
  ok: boolean
  sent: number
  failures: { signerId: number; name: string; error: string }[]
  status: string
  error?: string
}

/**
 * Prepare (freeze base PDF) and send/advance a request. Draft → Sent. For
 * sequential requests only the current-turn signer is emailed; parallel emails
 * every open signer. Re-runnable: already-signed signers are skipped.
 */
export async function sendEsignRequest(input: {
  requestId: number
  actorId?: number | null
  actorName?: string | null
  onlySignerId?: number | null
}): Promise<SendResult> {
  await ensureEsignTables()
  const request = await getEsignRequest(input.requestId)
  if (!request) return { ok: false, sent: 0, failures: [], status: "Draft", error: "Request not found" }
  if (isTerminalStatus(request.status)) {
    return { ok: false, sent: 0, failures: [], status: request.status, error: `Request is ${request.status}` }
  }
  const signers = request.signers || (await getRequestSigners(request.id))
  if (signers.length === 0) {
    return { ok: false, sent: 0, failures: [], status: request.status, error: "Add at least one signer first" }
  }
  const withEmail = signers.filter((s) => s.email)
  if (withEmail.length !== signers.length) {
    // Phase 57 — never silently skip a signer that cannot be reached.
    const bad = signers.find((s) => !s.email)
    return {
      ok: false,
      sent: 0,
      failures: [],
      status: request.status,
      error: `Signer “${bad?.name}” has no email address`,
    }
  }

  // Freeze the immutable base document before anyone can sign (Phase 41).
  await ensureBasePdf(request)

  let targets = dispatchTargets(request, signers)
  if (input.onlySignerId) targets = targets.filter((s) => s.id === input.onlySignerId)

  const expires = tokenExpiry(request)
  const failures: SendResult["failures"] = []
  let sent = 0

  for (const signer of targets) {
    const raw = await issueToken(signer.id, expires)
    const res = await sendSigningRequestEmail({
      request,
      signer,
      rawToken: raw,
      senderName: input.actorName ?? request.created_by_name ?? null,
      senderUserId: input.actorId ?? null,
    })
    if (res.ok) {
      await query(`UPDATE legal_esign_signers SET status = 'Sent' WHERE id = ? AND status = 'Pending'`, [signer.id])
      sent++
    } else {
      failures.push({ signerId: signer.id, name: signer.name, error: res.error || "Email failed" })
    }
  }

  const wasDraft = request.status === "Draft"
  await query(`UPDATE legal_esign_requests SET sent_at = COALESCE(sent_at, NOW()) WHERE id = ?`, [request.id])
  const status = await recomputeRequestStatus(request.id)

  if (wasDraft) {
    await logEsignEvent({
      requestId: request.id,
      type: "request_sent",
      summary: `Request sent to ${sent} signer${sent === 1 ? "" : "s"}`,
      detail: { targets: targets.map((t) => t.name), signingType: request.signing_type },
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
    })
  }

  return { ok: failures.length === 0, sent, failures, status }
}

/** Resend to a single signer with a fresh token (Phase 51). */
export async function resendToSigner(input: {
  requestId: number
  signerId: number
  actorId?: number | null
  actorName?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  await ensureEsignTables()
  const request = await getEsignRequest(input.requestId)
  if (!request) return { ok: false, error: "Request not found" }
  if (isTerminalStatus(request.status)) return { ok: false, error: `Request is ${request.status}` }
  const signer = await getSigner(input.signerId)
  if (!signer || signer.request_id !== request.id) return { ok: false, error: "Signer not found" }
  if (signer.status === "Signed") return { ok: false, error: "Signer has already signed" }
  if (!signer.email) return { ok: false, error: "Signer has no email address" }

  const raw = await issueToken(signer.id, tokenExpiry(request))
  const res = await sendSigningRequestEmail({
    request,
    signer,
    rawToken: raw,
    senderName: input.actorName ?? null,
    senderUserId: input.actorId ?? null,
    resend: true,
  })
  if (!res.ok) return { ok: false, error: res.error }
  await query(`UPDATE legal_esign_signers SET status = 'Sent' WHERE id = ? AND status = 'Pending'`, [signer.id])
  await recomputeRequestStatus(request.id)
  return { ok: true }
}

/** Mark a signer's document as viewed (Phase 45). Idempotent. */
export async function markSignerViewed(input: {
  signerId: number
  ip?: string | null
  userAgent?: string | null
}): Promise<void> {
  const signer = await getSigner(input.signerId)
  if (!signer) return
  if (signer.viewed_at || signer.status === "Signed" || signer.status === "Rejected") return
  await query(`UPDATE legal_esign_signers SET viewed_at = NOW(), status = 'Viewed' WHERE id = ? AND status = 'Sent'`, [
    signer.id,
  ])
  await logEsignEvent({
    requestId: signer.request_id,
    signerId: signer.id,
    type: "document_viewed",
    summary: `${signer.name} opened the document`,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })
  await recomputeRequestStatus(signer.request_id)
}

function dataUrlToBuffer(dataUrl: string): { buffer: Buffer; contentType: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl.trim())
  if (!m) return null
  const contentType = m[1].toLowerCase()
  try {
    return { buffer: Buffer.from(m[2], "base64"), contentType }
  } catch {
    return null
  }
}

async function resolveSignatureFile(
  signer: EsignSigner,
  method: SignatureMethod,
  imageData?: string | null,
): Promise<{ fileId: string | null; error?: string }> {
  if (method === "saved") {
    // Internal signer using the saved authorized signature (Phase 35).
    if (signer.signatory_id) {
      const sig = await getSignatory(signer.signatory_id)
      if (sig?.signature_file_id) return { fileId: sig.signature_file_id }
      return { fileId: null, error: "No saved signature is available for this signatory" }
    }
    return { fileId: null, error: "Saved signature is only available for authorized signatories" }
  }
  // draw / upload — a base64 image payload from the signing page.
  if (!imageData) return { fileId: null, error: "No signature image was provided" }
  const parsed = dataUrlToBuffer(imageData)
  if (!parsed) return { fileId: null, error: "Signature image is malformed" }
  if (!SIGNATURE_IMAGE_TYPES.includes(parsed.contentType)) {
    return { fileId: null, error: "Signature must be a PNG or JPG image" }
  }
  if (parsed.buffer.length > SIGNATURE_MAX_BYTES) {
    return { fileId: null, error: "Signature image is too large (max 3 MB)" }
  }
  if (parsed.buffer.length < 32) return { fileId: null, error: "Signature image looks empty" }
  const fileId = await storeEsignFile({
    kind: "signature",
    data: parsed.buffer,
    contentType: parsed.contentType,
    filename: `signature-${signer.signer_uid}.${parsed.contentType.includes("png") ? "png" : "jpg"}`,
  })
  return { fileId }
}

export type SubmitResult = {
  ok: boolean
  error?: string
  status?: string
  completed?: boolean
}

/**
 * Apply a signer's signature and regenerate the signed PDF version. Serialized
 * per-signer with a row lock so two simultaneous submits can't both win
 * (Phases 63, 83). The signer's single-use token is burned on success.
 */
export async function submitSignature(input: {
  signerId: number
  method: SignatureMethod
  imageData?: string | null
  confirmed: boolean
  ip?: string | null
  userAgent?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<SubmitResult> {
  await ensureEsignTables()
  const connection = await pool.getConnection()
  let requestId = 0
  try {
    await connection.beginTransaction()
    const [rows] = await connection.query<any[]>(
      `SELECT * FROM legal_esign_signers WHERE id = ? FOR UPDATE`,
      [input.signerId],
    )
    const signerRow = rows[0]
    if (!signerRow) {
      await connection.rollback()
      return { ok: false, error: "Signer not found" }
    }
    requestId = Number(signerRow.request_id)
    if (signerRow.token_used || signerRow.status === "Signed") {
      await connection.rollback()
      return { ok: false, error: "This document has already been signed" }
    }
    if (signerRow.status === "Rejected") {
      await connection.rollback()
      return { ok: false, error: "This request was rejected" }
    }
    // Burn the token immediately inside the lock (Phase 63).
    await connection.query(`UPDATE legal_esign_signers SET token_used = 1 WHERE id = ?`, [input.signerId])
    await connection.commit()
  } catch (error) {
    await connection.rollback()
    return { ok: false, error: (error as Error).message }
  } finally {
    connection.release()
  }

  const request = await getEsignRequest(requestId)
  if (!request) return { ok: false, error: "Request not found" }
  if (isTerminalStatus(request.status)) return { ok: false, error: `Request is ${request.status}` }
  const signer = await getSigner(input.signerId)
  if (!signer) return { ok: false, error: "Signer not found" }

  // Confirmation gate (Phase 37).
  if (request.require_confirm && !input.confirmed) {
    await query(`UPDATE legal_esign_signers SET token_used = 0 WHERE id = ?`, [signer.id])
    return { ok: false, error: "You must confirm before signing" }
  }
  // Sequential turn gate (Phase 20).
  const turn = await isSignerTurn(request, signer)
  if (!turn) {
    await query(`UPDATE legal_esign_signers SET token_used = 0 WHERE id = ?`, [signer.id])
    return { ok: false, error: "It is not yet your turn to sign this document" }
  }

  // Internal signers may only use a saved signature; external may draw/upload.
  let method = input.method
  if (isInternalSignerType(signer.signer_type) && signer.signatory_id && method !== "saved") {
    // An authorized signatory always signs with their saved mark.
    method = "saved"
  }

  const resolved = await resolveSignatureFile(signer, method, input.imageData)
  if (resolved.error) {
    await query(`UPDATE legal_esign_signers SET token_used = 0 WHERE id = ?`, [signer.id])
    return { ok: false, error: resolved.error }
  }

  await query(
    `UPDATE legal_esign_signers
        SET status = 'Signed', signed_at = NOW(), signature_method = ?, signature_file_id = ?,
            confirmed = ?, sign_ip = ?, sign_user_agent = ?, token_used = 1
      WHERE id = ?`,
    [method, resolved.fileId, input.confirmed ? 1 : 0, input.ip ?? null, input.userAgent ?? null, signer.id],
  )
  await logEsignEvent({
    requestId: request.id,
    signerId: signer.id,
    type: "signature_submitted",
    summary: `${signer.name} signed the document`,
    detail: { method, requestUid: request.request_uid },
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? signer.name,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })

  // Regenerate the signed PDF version with every signature collected so far
  // (Phase 42, 43 — never lose a previous mark).
  const freshSigners = await getRequestSigners(request.id)
  await storeSignedPdf({ ...request, signers: freshSigners }, freshSigners, {
    actorId: input.actorId ?? null,
  })
  await logEsignEvent({
    requestId: request.id,
    type: "signed_pdf_generated",
    summary: `Signed PDF version regenerated after ${signer.name} signed`,
  })

  const status = await recomputeRequestStatus(request.id)
  const completed = status === "Completed"

  if (completed) {
    await onRequestCompleted(request.id, input.actorId ?? null, input.actorName ?? null)
  } else {
    // Advance sequential order to the next signer.
    await sendEsignRequest({
      requestId: request.id,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
    }).catch((e) => console.error("[v0] sequential advance failed:", (e as Error).message))
  }

  return { ok: true, status, completed }
}

/**
 * Apply a Muenot authorized signatory's saved signature from inside the ERP
 * (no email round-trip) — Phase 35. Reuses submitSignature with the "saved"
 * method after asserting the signer is an internal authorized signatory.
 */
export async function signInternally(input: {
  requestId: number
  signerId: number
  actorId?: number | null
  actorName?: string | null
  ip?: string | null
  userAgent?: string | null
}): Promise<SubmitResult> {
  const signer = await getSigner(input.signerId)
  if (!signer || signer.request_id !== input.requestId) return { ok: false, error: "Signer not found" }
  if (!signer.signatory_id) return { ok: false, error: "Only authorized signatories can sign from inside the ERP" }
  return submitSignature({
    signerId: input.signerId,
    method: "saved",
    confirmed: true,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })
}

/** Reject a signature with a mandatory reason (Phases 47, 48). */
export async function rejectSignature(input: {
  signerId: number
  reason: string
  ip?: string | null
  userAgent?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const reason = (input.reason || "").trim()
  if (!reason) return { ok: false, error: "A rejection reason is required" }
  const signer = await getSigner(input.signerId)
  if (!signer) return { ok: false, error: "Signer not found" }
  const request = await getEsignRequest(signer.request_id)
  if (!request) return { ok: false, error: "Request not found" }
  if (isTerminalStatus(request.status)) return { ok: false, error: `Request is ${request.status}` }
  if (signer.status === "Signed") return { ok: false, error: "You have already signed this document" }

  await query(
    `UPDATE legal_esign_signers
        SET status = 'Rejected', rejected_at = NOW(), reject_reason = ?, token_used = 1,
            sign_ip = ?, sign_user_agent = ?
      WHERE id = ?`,
    [reason.slice(0, 500), input.ip ?? null, input.userAgent ?? null, signer.id],
  )
  await query(`UPDATE legal_esign_requests SET status = 'Rejected' WHERE id = ?`, [request.id])
  await logEsignEvent({
    requestId: request.id,
    signerId: signer.id,
    type: "signature_rejected",
    summary: `${signer.name} rejected the document`,
    detail: { reason },
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? signer.name,
    ip: input.ip ?? null,
    userAgent: input.userAgent ?? null,
  })
  return { ok: true }
}

/** Cancel a request with a stored reason (Phase 52). */
export async function cancelEsignRequest(input: {
  requestId: number
  reason?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const request = await getEsignRequest(input.requestId)
  if (!request) return { ok: false, error: "Request not found" }
  if (request.status === "Completed") return { ok: false, error: "A completed request cannot be cancelled" }
  if (request.status === "Cancelled") return { ok: true }
  const reason = (input.reason || "").trim().slice(0, 500) || null
  await query(`UPDATE legal_esign_requests SET status = 'Cancelled', cancel_reason = ? WHERE id = ?`, [
    reason,
    request.id,
  ])
  // Invalidate every outstanding token (Phase 62).
  await query(`UPDATE legal_esign_signers SET token_used = 1 WHERE request_id = ? AND status <> 'Signed'`, [request.id])
  await logEsignEvent({
    requestId: request.id,
    type: "request_cancelled",
    summary: `Request cancelled${reason ? `: ${reason}` : ""}`,
    detail: reason ? { reason } : null,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
  })
  return { ok: true }
}

/** Extend (or set) a due date, reviving an expired request (Phase 50). */
export async function extendDueDate(input: {
  requestId: number
  dueDate: string
  actorId?: number | null
  actorName?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const request = await getEsignRequest(input.requestId)
  if (!request) return { ok: false, error: "Request not found" }
  if (["Completed", "Cancelled", "Rejected"].includes(request.status)) {
    return { ok: false, error: `Request is ${request.status}` }
  }
  await query(`UPDATE legal_esign_requests SET due_date = ? WHERE id = ?`, [input.dueDate, request.id])
  if (request.status === "Expired") {
    await query(`UPDATE legal_esign_requests SET status = 'Awaiting Signature' WHERE id = ?`, [request.id])
    // Refresh tokens so signers can act again.
    const signers = await getRequestSigners(request.id)
    const updated = await getEsignRequest(request.id)
    const expires = tokenExpiry(updated as EsignRequest)
    for (const s of dispatchTargets(updated as EsignRequest, signers)) {
      const raw = await issueToken(s.id, expires)
      await sendSigningRequestEmail({
        request: updated as EsignRequest,
        signer: s,
        rawToken: raw,
        senderName: input.actorName ?? null,
        senderUserId: input.actorId ?? null,
        resend: true,
      }).catch(() => {})
    }
  }
  await logEsignEvent({
    requestId: request.id,
    type: "due_date_extended",
    summary: `Due date set to ${input.dueDate}`,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
  })
  return { ok: true }
}

/** Email the final signed PDF to a recipient (Phases 54, 91). */
export async function emailSignedDocument(input: {
  requestId: number
  to: string
  recipientName?: string | null
  actorId?: number | null
  actorName?: string | null
}): Promise<{ ok: boolean; error?: string }> {
  const request = await getEsignRequest(input.requestId)
  if (!request) return { ok: false, error: "Request not found" }
  if (!request.signed_file_id) return { ok: false, error: "No signed document is available yet" }
  return sendSignedDocumentEmail({
    request,
    to: input.to,
    recipientName: input.recipientName ?? null,
    senderName: input.actorName ?? null,
    senderUserId: input.actorId ?? null,
    actorId: input.actorId ?? null,
    actorName: input.actorName ?? null,
  })
}

/** Runs when the last signer completes: auto-email + notify owner (Phases 55, 95). */
async function onRequestCompleted(requestId: number, actorId: number | null, actorName: string | null): Promise<void> {
  const request = await getEsignRequest(requestId)
  if (!request) return
  const signers = await getRequestSigners(requestId)
  // Ensure a final signed PDF exists.
  if (!request.signed_file_id) {
    await storeSignedPdf({ ...request, signers }, signers, { final: true, actorId })
  }
  await logEsignEvent({
    requestId,
    type: "request_completed",
    summary: "All signatures collected — request completed",
    actorId,
    actorName,
  })

  if (request.auto_email_signed) {
    // Auto-deliver to every signer with an email (Phase 55).
    const fresh = await getEsignRequest(requestId)
    for (const s of signers) {
      if (!s.email) continue
      await sendSignedDocumentEmail({
        request: fresh as EsignRequest,
        to: s.email,
        recipientName: s.name,
        actorId,
        actorName,
      }).catch((e) => console.error("[v0] auto-email signed failed:", (e as Error).message))
    }
  }
}

// --- Cron sweep -------------------------------------------------------------

export type SchedulerResult = {
  expired: number
  reminders: number
  completedEmails: number
}

/**
 * Unattended sweep (Phase 93): expire overdue requests, send tiered reminders
 * (7 / 3 / 1 days before due) and retry auto-email for completed requests that
 * never got their signed PDF out. Idempotent via the reminder ledger and status
 * guards (Phase 94).
 */
export async function runEsignScheduler(): Promise<SchedulerResult> {
  await ensureEsignTables()
  const result: SchedulerResult = { expired: 0, reminders: 0, completedEmails: 0 }
  const today = new Date()
  today.setHours(0, 0, 0, 0)

  // 1) Expire overdue, non-terminal requests.
  const overdue = await query<any[]>(
    `SELECT id FROM legal_esign_requests
      WHERE due_date IS NOT NULL AND due_date < CURDATE()
        AND status NOT IN ('Completed','Rejected','Cancelled','Expired','Draft')`,
  ).catch(() => [])
  for (const r of overdue) {
    await query(`UPDATE legal_esign_requests SET status = 'Expired' WHERE id = ?`, [r.id])
    await query(`UPDATE legal_esign_signers SET token_used = 1 WHERE request_id = ? AND status <> 'Signed'`, [r.id])
    await logEsignEvent({ requestId: Number(r.id), type: "request_expired", summary: "Request expired (past due date)" })
    result.expired++
  }

  // 2) Tiered reminders for open signers with a due date.
  const rows = await query<any[]>(
    `SELECT s.id AS signer_id, s.request_id, s.name, s.email, s.status AS signer_status,
            s.token_hash, s.token_expires_at, r.due_date, r.title, r.status AS req_status,
            r.signing_type, r.created_by_name, r.created_by
       FROM legal_esign_signers s
       JOIN legal_esign_requests r ON r.id = s.request_id
      WHERE r.due_date IS NOT NULL
        AND r.status IN ('Sent','Viewed','Awaiting Signature','Partially Signed')
        AND s.status IN ('Sent','Viewed')
        AND s.email IS NOT NULL`,
  ).catch(() => [])

  for (const row of rows) {
    const due = new Date(row.due_date)
    due.setHours(0, 0, 0, 0)
    const days = Math.round((due.getTime() - today.getTime()) / 86400000)
    let key: string | null = null
    if (days === 7) key = "d7"
    else if (days === 3) key = "d3"
    else if (days === 1) key = "d1"
    else if (days === 0) key = "d0"
    if (!key) continue

    // Idempotency: unique (signer_id, reminder_key) row must not already exist.
    const claimed = await query<any>(
      `INSERT IGNORE INTO legal_esign_reminders (request_id, signer_id, reminder_key) VALUES (?,?,?)`,
      [row.request_id, row.signer_id, key],
    )
    if (!(claimed as any).affectedRows) continue

    // Reuse the still-valid token; only mint a new one if missing/expired.
    const request = await getEsignRequest(Number(row.request_id))
    const signer = await getSigner(Number(row.signer_id))
    if (!request || !signer) continue
    let raw: string
    const expired = !row.token_expires_at || new Date(row.token_expires_at).getTime() < Date.now()
    if (expired || !row.token_hash) {
      raw = await issueToken(signer.id, tokenExpiry(request))
    } else {
      // Existing token hash can't be reversed, so re-mint for the reminder link.
      raw = await issueToken(signer.id, tokenExpiry(request))
    }
    const res = await sendSigningRequestEmail({
      request,
      signer,
      rawToken: raw,
      senderName: row.created_by_name ?? null,
      senderUserId: row.created_by ?? null,
      resend: true,
    })
    if (res.ok) {
      await logEsignEvent({
        requestId: Number(row.request_id),
        signerId: Number(row.signer_id),
        type: "reminder_sent",
        summary: `Reminder sent to ${row.name} (${days} day${days === 1 ? "" : "s"} to due date)`,
        detail: { reminderKey: key },
      })
      result.reminders++
    }
  }

  // 3) Retry auto-email for completed requests still flagged for it.
  const pendingEmails = await query<any[]>(
    `SELECT id FROM legal_esign_requests
      WHERE status = 'Completed' AND auto_email_signed = 1 AND signed_file_id IS NOT NULL
        AND id NOT IN (SELECT request_id FROM legal_esign_events WHERE event_type = 'signed_pdf_emailed')`,
  ).catch(() => [])
  for (const r of pendingEmails) {
    const request = await getEsignRequest(Number(r.id))
    if (!request) continue
    const signers = await getRequestSigners(request.id)
    for (const s of signers) {
      if (!s.email) continue
      const res = await sendSignedDocumentEmail({ request, to: s.email, recipientName: s.name })
      if (res.ok) result.completedEmails++
    }
  }

  return result
}

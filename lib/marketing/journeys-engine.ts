import "server-only"
import { query } from "@/lib/db"
import {
  sendEmail,
  withTrackingPixel,
  renderTemplate,
  generateTrackingToken,
  isEmailConfigured,
  hydrateDepartmentSMTP,
} from "@/lib/email"
import { getWhatsAppIntegration, sendWhatsAppTemplate, sendWhatsAppText } from "@/lib/whatsapp"
import { isEligible, recordContactActivity } from "@/lib/marketing/contacts-db"
import {
  ensureJourneySchema,
  getJourney,
  getJourneySteps,
  recordJourneyEvent,
  parseJson,
  newEnrollmentCode,
  type JourneyRow,
  type JourneyStepRow,
  type EnrollmentRow,
  type TriggerType,
} from "@/lib/marketing/journeys-db"

/**
 * Marketing Journeys — automation engine.
 *
 * Responsible for enrolling contacts, executing steps, and advancing
 * enrollments. Designed to run both from a Vercel cron sweep (unattended) and
 * from on-demand API calls. Every send is idempotent (guarded by a unique
 * step-run key) so a retry or overlapping cron tick can never double-send.
 */

function dispatchBaseUrl(): string {
  return (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/$/, "")
}

// ---------------------------------------------------------------------------
// Contact loading + template variables
// ---------------------------------------------------------------------------

export async function loadContact(contactId: number): Promise<Record<string, any> | null> {
  const rows = await query<any[]>(`SELECT * FROM marketing_contacts WHERE id = ? LIMIT 1`, [contactId])
  return rows[0] ?? null
}

async function contactTags(contactId: number): Promise<string[]> {
  const rows = await query<any[]>(`SELECT tag FROM marketing_contact_tags WHERE contact_id = ?`, [contactId])
  return rows.map((r) => String(r.tag))
}

function templateVars(contact: Record<string, any>): Record<string, string | null> {
  return {
    first_name: contact.first_name,
    last_name: contact.last_name,
    full_name: contact.full_name,
    name: contact.full_name,
    email: contact.email,
    phone: contact.phone,
    company: contact.company_name,
    company_name: contact.company_name,
    job_title: contact.job_title,
    city: contact.city,
    country: contact.country,
  }
}

// ---------------------------------------------------------------------------
// Audience matching (optional extra filter beyond the trigger)
// ---------------------------------------------------------------------------

async function matchesAudience(journey: JourneyRow, contact: Record<string, any>): Promise<boolean> {
  const audience = parseJson<any>(journey.audience_config, null)
  if (!audience) return true
  if (audience.lifecycleStage && contact.lifecycle_stage !== audience.lifecycleStage) return false
  if (Array.isArray(audience.tags) && audience.tags.length) {
    const tags = await contactTags(contact.id)
    const hasAll = audience.tags.every((t: string) => tags.includes(t))
    if (!hasAll) return false
  }
  if (Array.isArray(audience.segmentIds) && audience.segmentIds.length) {
    const rows = await query<any[]>(
      `SELECT 1 FROM marketing_segment_members
       WHERE contact_id = ? AND segment_id IN (${audience.segmentIds.map(() => "?").join(",")}) LIMIT 1`,
      [contact.id, ...audience.segmentIds],
    )
    if (!rows.length) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export type EnrollResult = { enrolled: boolean; enrollmentId?: number; reason?: string }

export async function enrollContact(
  journeyId: number,
  contactId: number,
  opts: { source?: string; actorId?: number | null; force?: boolean } = {},
): Promise<EnrollResult> {
  await ensureJourneySchema()
  const journey = await getJourney(journeyId)
  if (!journey) return { enrolled: false, reason: "Journey not found" }
  if (!opts.force && journey.status !== "Active") return { enrolled: false, reason: "Journey not active" }

  const contact = await loadContact(contactId)
  if (!contact) return { enrolled: false, reason: "Contact not found" }
  if (contact.archived_at || contact.status !== "Active") return { enrolled: false, reason: "Contact not active" }

  if (!(await matchesAudience(journey, contact))) return { enrolled: false, reason: "Outside audience" }

  // Re-entry / concurrency rules.
  const existing = await query<any[]>(
    `SELECT id, status FROM marketing_journey_enrollments WHERE journey_id = ? AND contact_id = ?`,
    [journeyId, contactId],
  )
  const hasActive = existing.some((e) => e.status === "Active" || e.status === "Waiting")
  if (hasActive && !journey.allow_multiple_active) {
    return { enrolled: false, reason: "Already enrolled" }
  }
  const hasPast = existing.length > 0
  if (hasPast && !journey.allow_reentry && !hasActive) {
    return { enrolled: false, reason: "Re-entry not allowed" }
  }

  const steps = await getJourneySteps(journeyId)
  const firstStep = steps.find((s) => s.enabled)
  const code = newEnrollmentCode()
  const res: any = await query(
    `INSERT INTO marketing_journey_enrollments
       (enrollment_code, journey_id, contact_id, status, current_step_order, next_run_at, source, enrolled_by)
     VALUES (?,?,?,?,?,NOW(),?,?)`,
    [
      code,
      journeyId,
      contactId,
      firstStep ? "Active" : "Completed",
      firstStep ? firstStep.step_order - 1 : 0,
      opts.source ?? "trigger",
      opts.actorId ?? null,
    ],
  )
  const enrollmentId = Number(res.insertId)

  await recordJourneyEvent({
    journeyId,
    enrollmentId,
    contactId,
    action: "enrolled",
    detail: `Enrolled via ${opts.source ?? "trigger"}`,
    actorId: opts.actorId ?? null,
  })
  await recordContactActivity({
    contactId,
    contactCode: contact.contact_code,
    type: "journey_enrolled",
    summary: `Entered journey "${journey.name}"`,
    meta: { journeyId, enrollmentId },
    actorId: opts.actorId ?? null,
  })

  return { enrolled: true, enrollmentId }
}

export async function bulkEnroll(
  journeyId: number,
  contactIds: number[],
  opts: { source?: string; actorId?: number | null; force?: boolean } = {},
): Promise<{ enrolled: number; skipped: number; results: EnrollResult[] }> {
  const results: EnrollResult[] = []
  let enrolled = 0
  for (const id of contactIds) {
    const r = await enrollContact(journeyId, id, opts)
    results.push(r)
    if (r.enrolled) enrolled++
  }
  return { enrolled, skipped: contactIds.length - enrolled, results }
}

// ---------------------------------------------------------------------------
// Trigger fan-out (called by contact/lead/form events)
// ---------------------------------------------------------------------------

export async function triggerEvent(
  type: TriggerType,
  payload: { contactId: number; tag?: string; segmentId?: number; actorId?: number | null },
): Promise<{ enrolled: number }> {
  try {
    await ensureJourneySchema()
    const journeys = await query<JourneyRow[]>(
      `SELECT * FROM marketing_journeys WHERE status = 'Active' AND trigger_type = ?`,
      [type],
    )
    let enrolled = 0
    for (const j of journeys) {
      // Config match for parameterized triggers.
      const cfg = parseJson<any>(j.trigger_config, null)
      if (type === "tag_added" && cfg?.tag && cfg.tag !== payload.tag) continue
      if (type === "segment_entered" && cfg?.segmentId && Number(cfg.segmentId) !== Number(payload.segmentId)) continue

      // Dedup so the same event can't enroll twice.
      const key = `${type}:${j.id}:${payload.contactId}:${payload.tag ?? payload.segmentId ?? ""}`
      const dedup: any = await query(
        `INSERT IGNORE INTO marketing_journey_event_dedup (event_key) VALUES (?)`,
        [key],
      )
      if (dedup.affectedRows === 0 && !journeyAllowsReentry(j)) continue

      const r = await enrollContact(j.id, payload.contactId, {
        source: "trigger",
        actorId: payload.actorId ?? null,
      })
      if (r.enrolled) enrolled++
    }
    return { enrolled }
  } catch (e) {
    console.error("[journeys-engine] triggerEvent failed", e)
    return { enrolled: 0 }
  }
}

function journeyAllowsReentry(j: JourneyRow): boolean {
  return !!j.allow_reentry
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

type StepOutcome =
  | { kind: "next" }
  | { kind: "wait"; until: Date }
  | { kind: "goto"; order: number }
  | { kind: "complete" }
  | { kind: "exit"; reason: string }
  | { kind: "fail"; error: string }

async function alreadySent(enrollmentId: number, stepId: number): Promise<boolean> {
  const rows = await query<any[]>(
    `SELECT 1 FROM marketing_journey_step_runs
     WHERE idempotency_key = ? LIMIT 1`,
    [`e${enrollmentId}:s${stepId}`],
  )
  return rows.length > 0
}

async function recordStepRun(input: {
  enrollmentId: number
  journeyId: number
  stepId: number | null
  stepOrder: number
  contactId: number
  type: string
  status: "Completed" | "Skipped" | "Failed"
  key: string
  result?: any
  error?: string | null
}): Promise<void> {
  await query(
    `INSERT IGNORE INTO marketing_journey_step_runs
       (enrollment_id, journey_id, step_id, step_order, contact_id, type, status, idempotency_key, result, error)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      input.enrollmentId,
      input.journeyId,
      input.stepId,
      input.stepOrder,
      input.contactId,
      input.type,
      input.status,
      input.key,
      input.result ? JSON.stringify(input.result) : null,
      input.error ? input.error.slice(0, 500) : null,
    ],
  ).catch((e) => console.error("[journeys-engine] recordStepRun failed", e))
}

function computeWaitUntil(config: any): Date {
  const now = Date.now()
  const value = Number(config?.value ?? 0)
  const unit = String(config?.unit ?? "hours")
  const mult =
    unit === "minutes" ? 60_000 : unit === "hours" ? 3_600_000 : unit === "days" ? 86_400_000 : unit === "weeks" ? 604_800_000 : 3_600_000
  return new Date(now + Math.max(0, value) * mult)
}

async function evaluateCondition(
  condition: any,
  contact: Record<string, any>,
  enrollment: EnrollmentRow,
): Promise<boolean> {
  if (!condition || !condition.type) return true
  switch (condition.type) {
    case "has_tag": {
      const tags = await contactTags(contact.id)
      return tags.includes(condition.tag)
    }
    case "field_equals":
      return String(contact[condition.field] ?? "").toLowerCase() === String(condition.value ?? "").toLowerCase()
    case "is_eligible":
      return isEligible(contact, condition.channel || "email")
    case "email_opened": {
      const rows = await query<any[]>(
        `SELECT 1 FROM sales_emails WHERE to_email = ? AND open_count > 0 AND sent_at >= ? LIMIT 1`,
        [contact.email, enrollment.started_at],
      )
      return rows.length > 0
    }
    default:
      return true
  }
}

async function executeStep(
  journey: JourneyRow,
  step: JourneyStepRow,
  enrollment: EnrollmentRow,
  contact: Record<string, any>,
): Promise<StepOutcome> {
  const config = parseJson<any>(step.config, {})
  const type = step.type

  // Wait — schedule the next tick.
  if (type === "wait") {
    return { kind: "wait", until: computeWaitUntil(config) }
  }

  // Branch — evaluate a condition and route.
  if (type === "branch") {
    const met = await evaluateCondition(config.condition, contact, enrollment)
    await recordStepRun({
      enrollmentId: enrollment.id,
      journeyId: journey.id,
      stepId: step.id,
      stepOrder: step.step_order,
      contactId: contact.id,
      type,
      status: "Completed",
      key: `e${enrollment.id}:s${step.id}:${Date.now()}`,
      result: { met },
    })
    const branch = met ? config.onTrue : config.onFalse
    if (branch === "exit" || (!met && branch == null)) return { kind: "exit", reason: "Branch: condition not met" }
    if (typeof branch === "number") return { kind: "goto", order: branch }
    return { kind: "next" }
  }

  // Goal checkpoint.
  if (type === "goal") {
    const met = await evaluateCondition(config.condition, contact, enrollment)
    if (met) {
      await query(`UPDATE marketing_journey_enrollments SET goal_reached = 1 WHERE id = ?`, [enrollment.id])
      await recordJourneyEvent({
        journeyId: journey.id,
        enrollmentId: enrollment.id,
        contactId: contact.id,
        stepId: step.id,
        action: "goal_reached",
        detail: "Journey goal reached",
      })
      if (config.exitOnGoal) return { kind: "complete" }
    }
    return { kind: "next" }
  }

  if (type === "end") {
    return { kind: "complete" }
  }

  // Email send.
  if (type === "email") {
    if (await alreadySent(enrollment.id, step.id)) return { kind: "next" }
    if (!isEligible(contact, "email")) {
      await recordStepRun({
        enrollmentId: enrollment.id,
        journeyId: journey.id,
        stepId: step.id,
        stepOrder: step.step_order,
        contactId: contact.id,
        type,
        status: "Skipped",
        key: `e${enrollment.id}:s${step.id}`,
        error: "Not eligible for email",
      })
      return { kind: "next" }
    }

    let subject = config.subject || ""
    let body = config.body || ""
    if (config.templateId) {
      const tpl = await query<any[]>(`SELECT subject, body FROM sales_email_templates WHERE id = ? LIMIT 1`, [config.templateId])
      if (tpl[0]) {
        subject = subject || tpl[0].subject
        body = body || tpl[0].body
      }
    }
    if (!subject || !body) {
      return { kind: "fail", error: "Email step has no subject/body" }
    }

    const vars = templateVars(contact)
    subject = renderTemplate(subject, vars)
    body = renderTemplate(body, vars)

    try {
      await hydrateDepartmentSMTP("sales").catch(() => {})
      if (!isEmailConfigured("sales")) {
        return { kind: "fail", error: "No email transport configured" }
      }
      const token = generateTrackingToken()
      const html = withTrackingPixel(body, dispatchBaseUrl(), token)
      await sendEmail({ to: contact.email, subject, html, department: "sales" })

      // Persist to sales_emails so opens are tracked by the shared pixel route.
      await query(
        `INSERT INTO sales_emails (lead_id, template_id, to_email, to_name, subject, body, tracking_token, status, sent_by)
         VALUES (NULL, ?, ?, ?, ?, ?, ?, 'Sent', ?)`,
        [config.templateId ?? null, contact.email, contact.full_name, subject, body, token, journey.owner_id ?? null],
      ).catch(() => {})

      await recordStepRun({
        enrollmentId: enrollment.id,
        journeyId: journey.id,
        stepId: step.id,
        stepOrder: step.step_order,
        contactId: contact.id,
        type,
        status: "Completed",
        key: `e${enrollment.id}:s${step.id}`,
        result: { subject, token },
      })
      await recordContactActivity({
        contactId: contact.id,
        contactCode: contact.contact_code,
        type: "journey_email",
        summary: `Journey email sent: ${subject}`.slice(0, 255),
        meta: { journeyId: journey.id, stepId: step.id },
      })
      await recordJourneyEvent({
        journeyId: journey.id,
        enrollmentId: enrollment.id,
        contactId: contact.id,
        stepId: step.id,
        action: "email_sent",
        detail: subject,
      })
      return { kind: "next" }
    } catch (e) {
      return { kind: "fail", error: (e as Error).message }
    }
  }

  // WhatsApp send.
  if (type === "whatsapp") {
    if (await alreadySent(enrollment.id, step.id)) return { kind: "next" }
    if (!isEligible(contact, "whatsapp")) {
      await recordStepRun({
        enrollmentId: enrollment.id,
        journeyId: journey.id,
        stepId: step.id,
        stepOrder: step.step_order,
        contactId: contact.id,
        type,
        status: "Skipped",
        key: `e${enrollment.id}:s${step.id}`,
        error: "Not eligible for WhatsApp",
      })
      return { kind: "next" }
    }
    const integration = await getWhatsAppIntegration()
    if (!integration) return { kind: "fail", error: "WhatsApp not connected" }
    try {
      let sendRes
      if (config.templateName) {
        sendRes = await sendWhatsAppTemplate({
          integration,
          to: contact.phone,
          templateName: config.templateName,
          languageCode: config.languageCode || "en_US",
        })
      } else if (config.text) {
        sendRes = await sendWhatsAppText({ integration, to: contact.phone, body: renderTemplate(config.text, templateVars(contact)) })
      } else {
        return { kind: "fail", error: "WhatsApp step has no template or text" }
      }
      if (!sendRes.ok) return { kind: "fail", error: sendRes.error || "WhatsApp send failed" }

      await recordStepRun({
        enrollmentId: enrollment.id,
        journeyId: journey.id,
        stepId: step.id,
        stepOrder: step.step_order,
        contactId: contact.id,
        type,
        status: "Completed",
        key: `e${enrollment.id}:s${step.id}`,
        result: { messageId: sendRes.messageId },
      })
      await recordContactActivity({
        contactId: contact.id,
        contactCode: contact.contact_code,
        type: "journey_whatsapp",
        summary: `Journey WhatsApp sent`,
        meta: { journeyId: journey.id, stepId: step.id },
      })
      await recordJourneyEvent({
        journeyId: journey.id,
        enrollmentId: enrollment.id,
        contactId: contact.id,
        stepId: step.id,
        action: "whatsapp_sent",
        detail: config.templateName || "text",
      })
      return { kind: "next" }
    } catch (e) {
      return { kind: "fail", error: (e as Error).message }
    }
  }

  // Tag / segment / owner mutations.
  if (type === "add_tag" && config.tag) {
    await query(`INSERT IGNORE INTO marketing_contact_tags (contact_id, tag) VALUES (?, ?)`, [contact.id, String(config.tag).slice(0, 80)])
    await finishInstant(journey, step, enrollment, contact, type, { tag: config.tag })
    return { kind: "next" }
  }
  if (type === "remove_tag" && config.tag) {
    await query(`DELETE FROM marketing_contact_tags WHERE contact_id = ? AND tag = ?`, [contact.id, config.tag])
    await finishInstant(journey, step, enrollment, contact, type, { tag: config.tag })
    return { kind: "next" }
  }
  if (type === "add_segment" && config.segmentId) {
    await query(
      `INSERT IGNORE INTO marketing_segment_members (segment_id, contact_id, added_by) VALUES (?,?,?)`,
      [config.segmentId, contact.id, journey.owner_id ?? null],
    )
    await finishInstant(journey, step, enrollment, contact, type, { segmentId: config.segmentId })
    return { kind: "next" }
  }
  if (type === "remove_segment" && config.segmentId) {
    await query(`DELETE FROM marketing_segment_members WHERE segment_id = ? AND contact_id = ?`, [config.segmentId, contact.id])
    await finishInstant(journey, step, enrollment, contact, type, { segmentId: config.segmentId })
    return { kind: "next" }
  }
  if (type === "assign_owner" && config.ownerId) {
    await query(`UPDATE marketing_contacts SET owner_id = ? WHERE id = ?`, [config.ownerId, contact.id])
    await finishInstant(journey, step, enrollment, contact, type, { ownerId: config.ownerId })
    return { kind: "next" }
  }

  // Internal notification / task-style follow-up to a team member.
  if (type === "notification" || type === "create_task") {
    const recipient = config.userId || journey.owner_id
    if (recipient) {
      const title = renderTemplate(config.title || (type === "create_task" ? "Journey task" : "Journey notification"), templateVars(contact))
      const bodyText = renderTemplate(config.body || `Contact ${contact.full_name} reached this step in "${journey.name}"`, templateVars(contact))
      await query(
        `INSERT INTO sales_notifications (user_id, type, title, body, link, entity_type, entity_id)
         VALUES (?,?,?,?,?,?,?)`,
        [
          recipient,
          type === "create_task" ? "task" : "info",
          title.slice(0, 255),
          bodyText.slice(0, 500),
          `/modules/marketing/journeys`,
          "journey",
          String(journey.id),
        ],
      ).catch(() => {})
    }
    await finishInstant(journey, step, enrollment, contact, type, { recipient })
    return { kind: "next" }
  }

  // Unknown step type — skip forward rather than stall.
  await finishInstant(journey, step, enrollment, contact, type, { skipped: true }, "Skipped")
  return { kind: "next" }
}

async function finishInstant(
  journey: JourneyRow,
  step: JourneyStepRow,
  enrollment: EnrollmentRow,
  contact: Record<string, any>,
  type: string,
  result: any,
  status: "Completed" | "Skipped" = "Completed",
) {
  await recordStepRun({
    enrollmentId: enrollment.id,
    journeyId: journey.id,
    stepId: step.id,
    stepOrder: step.step_order,
    contactId: contact.id,
    type,
    status,
    key: `e${enrollment.id}:s${step.id}:${Date.now()}`,
    result,
  })
}

// ---------------------------------------------------------------------------
// Enrollment advancement (process one enrollment)
// ---------------------------------------------------------------------------

const MAX_STEPS_PER_TICK = 25

export async function processEnrollment(enrollmentId: number): Promise<void> {
  const rows = await query<EnrollmentRow[]>(`SELECT * FROM marketing_journey_enrollments WHERE id = ? LIMIT 1`, [enrollmentId])
  const enrollment = rows[0]
  if (!enrollment) return
  if (enrollment.status !== "Active" && enrollment.status !== "Waiting") return

  const journey = await getJourney(enrollment.journey_id)
  if (!journey) return
  if (journey.status === "Paused" || journey.status === "Archived") return

  const contact = await loadContact(enrollment.contact_id)
  if (!contact || contact.archived_at || contact.status !== "Active") {
    await query(
      `UPDATE marketing_journey_enrollments SET status = 'Exited', exit_reason = 'Contact inactive', locked_at = NULL, last_action_at = NOW() WHERE id = ?`,
      [enrollmentId],
    )
    return
  }

  const steps = (await getJourneySteps(journey.id)).filter((s) => s.enabled)
  let currentOrder = enrollment.current_step_order
  let working = { ...enrollment }

  for (let i = 0; i < MAX_STEPS_PER_TICK; i++) {
    const next = steps.find((s) => s.step_order > currentOrder)
    if (!next) {
      await query(
        `UPDATE marketing_journey_enrollments
         SET status = 'Completed', completed_at = NOW(), current_step_order = ?, next_run_at = NULL, locked_at = NULL, last_action_at = NOW()
         WHERE id = ?`,
        [currentOrder, enrollmentId],
      )
      await recordJourneyEvent({ journeyId: journey.id, enrollmentId, contactId: contact.id, action: "completed", detail: "Journey completed" })
      await recordContactActivity({
        contactId: contact.id,
        contactCode: contact.contact_code,
        type: "journey_completed",
        summary: `Completed journey "${journey.name}"`,
        meta: { journeyId: journey.id },
      })
      return
    }

    const outcome = await executeStep(journey, next, working, contact)

    if (outcome.kind === "wait") {
      await query(
        `UPDATE marketing_journey_enrollments
         SET status = 'Waiting', current_step_order = ?, next_run_at = ?, locked_at = NULL, last_action_at = NOW()
         WHERE id = ?`,
        [next.step_order, outcome.until, enrollmentId],
      )
      return
    }
    if (outcome.kind === "complete") {
      await query(
        `UPDATE marketing_journey_enrollments
         SET status = 'Completed', completed_at = NOW(), current_step_order = ?, next_run_at = NULL, locked_at = NULL, last_action_at = NOW()
         WHERE id = ?`,
        [next.step_order, enrollmentId],
      )
      await recordJourneyEvent({ journeyId: journey.id, enrollmentId, contactId: contact.id, action: "completed", detail: "Journey completed" })
      return
    }
    if (outcome.kind === "exit") {
      await query(
        `UPDATE marketing_journey_enrollments
         SET status = 'Exited', exit_reason = ?, current_step_order = ?, next_run_at = NULL, locked_at = NULL, last_action_at = NOW()
         WHERE id = ?`,
        [outcome.reason.slice(0, 190), next.step_order, enrollmentId],
      )
      await recordJourneyEvent({ journeyId: journey.id, enrollmentId, contactId: contact.id, action: "exited", detail: outcome.reason })
      return
    }
    if (outcome.kind === "fail") {
      const attempts = (working.attempt_count || 0) + 1
      if (attempts >= 5) {
        await query(
          `UPDATE marketing_journey_enrollments
           SET status = 'Failed', exit_reason = ?, attempt_count = ?, next_run_at = NULL, locked_at = NULL, last_action_at = NOW()
           WHERE id = ?`,
          [outcome.error.slice(0, 190), attempts, enrollmentId],
        )
        await recordJourneyEvent({ journeyId: journey.id, enrollmentId, contactId: contact.id, stepId: next.id, action: "failed", detail: outcome.error })
      } else {
        const retryAt = new Date(Date.now() + 30 * 60_000)
        await query(
          `UPDATE marketing_journey_enrollments
           SET status = 'Active', current_step_order = ?, attempt_count = ?, next_run_at = ?, locked_at = NULL, last_action_at = NOW()
           WHERE id = ?`,
          [currentOrder, attempts, retryAt, enrollmentId],
        )
      }
      return
    }
    if (outcome.kind === "goto") {
      currentOrder = outcome.order - 1
      working = { ...working, current_step_order: currentOrder }
      continue
    }
    // next
    currentOrder = next.step_order
    working = { ...working, current_step_order: currentOrder }
    // Persist progress between chained instant steps so a crash resumes cleanly.
    await query(`UPDATE marketing_journey_enrollments SET current_step_order = ?, last_action_at = NOW() WHERE id = ?`, [currentOrder, enrollmentId])
  }

  // Hit the per-tick cap — leave Active so the next sweep resumes.
  await query(`UPDATE marketing_journey_enrollments SET status = 'Active', next_run_at = NOW(), locked_at = NULL WHERE id = ?`, [enrollmentId])
}

// ---------------------------------------------------------------------------
// Cron sweep
// ---------------------------------------------------------------------------

export async function processDueEnrollments(limit = 100): Promise<{ processed: number; claimed: number }> {
  await ensureJourneySchema()
  const candidates = await query<any[]>(
    `SELECT id FROM marketing_journey_enrollments
     WHERE status IN ('Active','Waiting')
       AND (next_run_at IS NULL OR next_run_at <= NOW())
       AND (locked_at IS NULL OR locked_at < (NOW() - INTERVAL 5 MINUTE))
     ORDER BY next_run_at IS NULL DESC, next_run_at ASC
     LIMIT ?`,
    [limit],
  )
  let processed = 0
  let claimed = 0
  for (const row of candidates) {
    const lock: any = await query(
      `UPDATE marketing_journey_enrollments
       SET locked_at = NOW()
       WHERE id = ? AND (locked_at IS NULL OR locked_at < (NOW() - INTERVAL 5 MINUTE))`,
      [row.id],
    )
    if (lock.affectedRows !== 1) continue
    claimed++
    try {
      await processEnrollment(row.id)
      processed++
    } catch (e) {
      console.error("[journeys-engine] processEnrollment failed", row.id, e)
      await query(`UPDATE marketing_journey_enrollments SET locked_at = NULL WHERE id = ?`, [row.id]).catch(() => {})
    }
  }
  return { processed, claimed }
}

export async function exitEnrollment(enrollmentId: number, reason: string, actorId?: number | null): Promise<void> {
  await query(
    `UPDATE marketing_journey_enrollments
     SET status = 'Exited', exit_reason = ?, next_run_at = NULL, locked_at = NULL, last_action_at = NOW()
     WHERE id = ? AND status IN ('Active','Waiting','Paused')`,
    [reason.slice(0, 190), enrollmentId],
  )
  const rows = await query<any[]>(`SELECT journey_id, contact_id FROM marketing_journey_enrollments WHERE id = ?`, [enrollmentId])
  if (rows[0]) {
    await recordJourneyEvent({
      journeyId: rows[0].journey_id,
      enrollmentId,
      contactId: rows[0].contact_id,
      action: "exited",
      detail: reason,
      actorId: actorId ?? null,
    })
  }
}

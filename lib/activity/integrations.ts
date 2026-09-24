import "server-only"
/**
 * SPEC 109 — Activity Timeline: module integration surface (Phase 3).
 * ---------------------------------------------------------------------------
 * The typed, stable seam every module uses to feed the ONE centralized stream
 * instead of inventing another private log. Each helper is a thin, correctly-
 * typed wrapper over recordActivitySafe (fire-and-forget: a timeline write must
 * never roll back the caller's real operation), pinning the right `kind` and
 * defaults so callers only supply what varies.
 *
 * Migration intent: as modules adopt these emitters, their bespoke tables
 * (sales_lead_activities, marketing_contact_activity, dms_audit, …) become
 * write-through mirrors and the unified timeline becomes the read model. New
 * code should emit here directly.
 */

import { recordActivitySafe, type RecordedActivity } from "@/lib/activity/db"
import type { ActivityEventInput, ActivityVisibility } from "@/lib/activity/model"

/** What every emitter needs: which subject the activity is about + who did it. */
export type SubjectRef = {
  subjectType: string
  subjectId: string | number
  subjectLabel?: string | null
  actorId?: number | null
  sourceModule?: string | null
  occurredAt?: string | Date | null
  visibility?: ActivityVisibility
  watchers?: number[] | null
  meta?: Record<string, any> | null
}

function base(subject: SubjectRef): Partial<ActivityEventInput> {
  return {
    subject_type: subject.subjectType,
    subject_id: subject.subjectId,
    subject_label: subject.subjectLabel ?? null,
    actor_id: subject.actorId ?? null,
    source_module: subject.sourceModule ?? null,
    occurred_at: subject.occurredAt ?? null,
    visibility: subject.visibility ?? "timeline",
    watchers: subject.watchers ?? null,
    meta: subject.meta ?? null,
  }
}

export function recordCall(
  subject: SubjectRef,
  detail: { title?: string; body?: string; direction?: "inbound" | "outbound"; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "call",
    action: detail.direction ? `${detail.direction} call` : "call",
    title: detail.title ?? "",
    body: detail.body ?? null,
    ref_type: "call",
    ref_id: detail.refId ?? null,
  } as ActivityEventInput)
}

export function recordEmail(
  subject: SubjectRef,
  detail: { subject_line?: string; body?: string; direction?: "inbound" | "outbound"; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "email",
    action: detail.direction ? `email ${detail.direction === "inbound" ? "received" : "sent"}` : "email",
    title: detail.subject_line ?? "",
    body: detail.body ?? null,
    ref_type: "email",
    ref_id: detail.refId ?? null,
  } as ActivityEventInput)
}

export function recordMeeting(
  subject: SubjectRef,
  detail: { title?: string; body?: string; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "meeting",
    action: "meeting",
    title: detail.title ?? "",
    body: detail.body ?? null,
    ref_type: "meeting",
    ref_id: detail.refId ?? null,
  } as ActivityEventInput)
}

export function recordNote(
  subject: SubjectRef,
  detail: { title?: string; body: string },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "note",
    action: "note added",
    title: detail.title ?? "Note",
    body: detail.body,
  } as ActivityEventInput)
}

export function recordTask(
  subject: SubjectRef,
  detail: { title: string; body?: string; state?: string; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "task",
    action: detail.state ? `task ${detail.state}` : "task",
    title: detail.title,
    body: detail.body ?? null,
    ref_type: "task",
    ref_id: detail.refId ?? null,
  } as ActivityEventInput)
}

export function recordStatusChange(
  subject: SubjectRef,
  detail: { from?: string | null; to: string; title?: string; body?: string },
): Promise<RecordedActivity | null> {
  const action = detail.from ? `${detail.from} → ${detail.to}` : `set to ${detail.to}`
  return recordActivitySafe({
    ...base(subject),
    kind: "status_change",
    action,
    title: detail.title ?? action,
    body: detail.body ?? null,
    meta: { ...(subject.meta ?? {}), from: detail.from ?? null, to: detail.to },
  } as ActivityEventInput)
}

export function recordApproval(
  subject: SubjectRef,
  detail: { decision: "requested" | "approved" | "rejected"; title?: string; body?: string; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "approval",
    action: detail.decision,
    title: detail.title ?? `Approval ${detail.decision}`,
    body: detail.body ?? null,
    ref_type: "approval",
    ref_id: detail.refId ?? null,
    // Approvals default to internal — hidden from portal viewers.
    visibility: subject.visibility ?? "internal",
  } as ActivityEventInput)
}

export function recordPayment(
  subject: SubjectRef,
  detail: { title?: string; body?: string; amount?: number; currency?: string; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "payment",
    action: "payment",
    title:
      detail.title ??
      (detail.amount != null ? `Payment ${detail.currency ?? ""} ${detail.amount}`.trim() : "Payment"),
    body: detail.body ?? null,
    ref_type: "payment",
    ref_id: detail.refId ?? null,
    meta: { ...(subject.meta ?? {}), amount: detail.amount ?? null, currency: detail.currency ?? null },
  } as ActivityEventInput)
}

export function recordDocument(
  subject: SubjectRef,
  detail: { title: string; body?: string; action?: string; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "document",
    action: detail.action ?? "document",
    title: detail.title,
    body: detail.body ?? null,
    ref_type: "document",
    ref_id: detail.refId ?? null,
  } as ActivityEventInput)
}

export function recordSystemEvent(
  subject: SubjectRef,
  detail: { title: string; body?: string; action?: string; refId?: string | number },
): Promise<RecordedActivity | null> {
  return recordActivitySafe({
    ...base(subject),
    kind: "system",
    action: detail.action ?? "system",
    title: detail.title,
    body: detail.body ?? null,
    actor_type: "system",
    ref_type: detail.refId != null ? "system" : null,
    ref_id: detail.refId ?? null,
  } as ActivityEventInput)
}

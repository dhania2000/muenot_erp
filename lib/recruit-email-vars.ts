// Phase 93 — Recruitment email template variables.
//
// ONE catalog of merge fields, resolved from the unified pipeline
// (Application -> Job -> Requisition -> Interview -> Offer -> Joining -> Candidate).
// No candidate data is ever hard-coded into an email: templates reference these
// `{{placeholders}}` and the server fills them from the linked records at send
// time. Unknown placeholders resolve to an empty string (see renderTemplate).
//
// This module is a pure constant with no server-only imports, so client
// components (compose/template dialogs) can render the available-variable hint.
// The server-only resolver that reads the DB lives in
// `lib/recruit-email-vars.server.ts` (imported only from server code) to keep
// this module safe to import from the client.

export type RecruitVarGroup = {
  entity: string
  vars: { key: string; label: string }[]
}

export const RECRUIT_EMAIL_VAR_GROUPS: RecruitVarGroup[] = [
  {
    entity: "Candidate & Application",
    vars: [
      { key: "candidate_name", label: "Candidate name" },
      { key: "email", label: "Email" },
      { key: "phone", label: "Phone" },
      { key: "candidate_location", label: "Location" },
      { key: "experience", label: "Experience" },
      { key: "current_company", label: "Current company" },
      { key: "expected_salary", label: "Expected salary" },
      { key: "source", label: "Source" },
      { key: "stage", label: "Pipeline stage" },
      { key: "rating", label: "Rating" },
      { key: "application_id", label: "Application ID" },
      { key: "applied_date", label: "Applied date" },
    ],
  },
  {
    entity: "Job",
    vars: [
      { key: "job_title", label: "Job title" },
      { key: "job_department", label: "Department" },
      { key: "job_location", label: "Job location" },
      { key: "job_type", label: "Employment type" },
      { key: "work_mode", label: "Work mode" },
      { key: "positions", label: "Open positions" },
      { key: "job_experience", label: "Required experience" },
      { key: "salary_range", label: "Salary range" },
      { key: "job_recruiter", label: "Recruiter" },
    ],
  },
  {
    entity: "Requisition",
    vars: [
      { key: "requisition_id", label: "Requisition ID" },
      { key: "requisition_department", label: "Requisition department" },
      { key: "hiring_manager", label: "Hiring manager" },
      { key: "requisition_recruiter", label: "Requisition recruiter" },
      { key: "priority", label: "Priority" },
      { key: "target_date", label: "Target date" },
      { key: "employment_type", label: "Employment type" },
    ],
  },
  {
    entity: "Interview",
    vars: [
      { key: "interview_round", label: "Round" },
      { key: "interview_mode", label: "Mode" },
      { key: "interview_location", label: "Location / link" },
      { key: "interview_datetime", label: "Date & time" },
      { key: "interviewer", label: "Interviewer" },
      { key: "interview_status", label: "Status" },
    ],
  },
  {
    entity: "Offer",
    vars: [
      { key: "offer_id", label: "Offer ID" },
      { key: "offer_salary", label: "Offered salary" },
      { key: "offer_currency", label: "Currency" },
      { key: "offer_status", label: "Offer status" },
      { key: "offer_joining_date", label: "Offer joining date" },
      { key: "offer_expiry_date", label: "Offer expiry date" },
    ],
  },
  {
    entity: "Joining",
    vars: [
      { key: "joining_date", label: "Joining date" },
      { key: "joining_status", label: "Joining status" },
    ],
  },
]

/** Flat list of every supported placeholder key. */
export const RECRUIT_EMAIL_VAR_KEYS: string[] = RECRUIT_EMAIL_VAR_GROUPS.flatMap((g) =>
  g.vars.map((v) => v.key),
)

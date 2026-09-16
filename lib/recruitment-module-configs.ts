/**
 * Single source of truth for every config-driven Recruitment sub-module.
 * Mirrors the Finance module architecture (lib/finance-module-configs.ts):
 * each sheet from the Recruitment Master workbook is described once by a
 * ModuleConfig, and the shared CRUD factory, the generic list client and the
 * generic form dialog are all driven from that config.
 *
 * Every column from the source spreadsheet is represented as a field so no
 * header is lost.
 */
import { num, round2 } from "@/lib/finance-calc"
import type { FieldDef, FieldType, ModuleConfig } from "@/lib/finance-schema"
import { EMPLOYMENT_TYPES, PRIORITIES, WORK_MODES } from "@/lib/recruitment-option-sets"

/** Terse field builder. */
function fld(section: string, key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef {
  return { section, key, label, type, ...extra }
}

const YES_NO = ["Yes", "No"]

const TRACKING_FIELDS = (section: string): FieldDef[] => [
  fld(section, "tracking_id", "Tracking ID", "text"),
  fld(section, "opened", "Opened", "select", { options: YES_NO, optional: true }),
  fld(section, "first_opened_on", "First opened on", "date"),
  fld(section, "last_opened_on", "Last opened on", "date"),
  fld(section, "open_count", "Open count", "number"),
]

// ---------------------------------------------------------------------------
// 1. Job Requisitions
// ---------------------------------------------------------------------------
const jobRequisitions: ModuleConfig = {
  key: "job-requisitions",
  table: "recruitment_requisitions",
  label: "Job Requisitions",
  subtitle: "Recruitment management",
  addLabel: "New requisition",
  idColumn: "requisition_id",
  idPrefix: "REQ",
  editableId: true,
  dateColumn: "requisition_date",
  statusColumn: "status",
  searchColumns: ["requisition_id", "job_title", "department", "project", "hiring_manager", "recruiter", "location"],
  fields: [
    fld("Requisition", "requisition_id", "Requisition ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Requisition", "requisition_date", "Requisition date", "date", { required: true }),
    fld("Requisition", "job_title", "Job title", "text", { required: true }),
    fld("Requisition", "department", "Department", "select", { optionsCategory: "hr_department", optional: true }),
    fld("Requisition", "project", "Project", "text"),
    fld("Requisition", "employment_type", "Employment type", "select", { options: EMPLOYMENT_TYPES, optionsCategory: "employment_type", optional: true }),
    fld("Resources", "required_resources", "Required resources", "number"),
    fld("Resources", "filled_resources", "Filled resources", "number"),
    fld("Resources", "pending_resources", "Pending resources", "number", { computed: true }),
    fld("Resources", "priority", "Priority", "select", { options: PRIORITIES, optionsCategory: "priority", optional: true }),
    fld("Requirements", "required_qualification", "Required qualification", "text"),
    fld("Requirements", "required_skills", "Required skills", "textarea"),
    fld("Requirements", "experience_required", "Experience required", "text"),
    fld("Requirements", "location", "Location", "text"),
    fld("Requirements", "work_mode", "Work mode", "select", { options: WORK_MODES, optionsCategory: "work_mode", optional: true }),
    fld("Requirements", "rate_salary", "Rate / Salary", "text", { placeholder: "e.g. ₹8-10 LPA" }),
    fld("Ownership", "hiring_manager", "Hiring manager", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Ownership", "recruiter", "Recruiter", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Ownership", "target_date", "Target date", "date"),
    fld("Ownership", "status", "Status", "select", { options: ["Open", "On Hold", "Closed", "Cancelled", "Filled"], optionsCategory: "requisition_status" }),
    fld("Ownership", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => ({
    pending_resources: Math.max(num(v.required_resources) - num(v.filled_resources), 0),
  }),
  tableColumns: [
    { key: "requisition_id", label: "Requisition ID", mono: true },
    { key: "requisition_date", label: "Date" },
    { key: "job_title", label: "Job Title", sub: "department" },
    { key: "required_resources", label: "Required", align: "right" },
    { key: "pending_resources", label: "Pending", align: "right" },
    { key: "priority", label: "Priority", badge: { Urgent: "destructive", High: "default", Medium: "secondary", Low: "outline" } },
    { key: "status", label: "Status", badge: { Open: "default", Filled: "secondary", "On Hold": "outline", Closed: "outline", Cancelled: "destructive" } },
  ],
  kpis: [
    { label: "Open Requisitions", key: "open_reqs", icon: "ClipboardList" },
    { label: "Required Resources", key: "total_required", icon: "Users" },
    { label: "Filled Resources", key: "total_filled", icon: "UserCheck" },
    { label: "Pending Resources", key: "total_pending", icon: "UserPlus" },
  ],
  summarySelect:
    "COALESCE(SUM(status = 'Open'),0) open_reqs, COALESCE(SUM(required_resources),0) total_required, COALESCE(SUM(filled_resources),0) total_filled, COALESCE(SUM(pending_resources),0) total_pending, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// 2. Recruitment Campaigns
// ---------------------------------------------------------------------------
const recruitmentCampaigns: ModuleConfig = {
  key: "recruitment-campaigns",
  table: "recruitment_campaigns",
  label: "Recruitment Campaigns",
  subtitle: "Recruitment management",
  addLabel: "New campaign",
  idColumn: "campaign_id",
  idPrefix: "CAM",
  editableId: true,
  dateColumn: "campaign_start_date",
  statusColumn: "campaign_status",
  searchColumns: ["campaign_id", "campaign_name", "job_title", "requisition_id", "recruitment_source", "recruiter"],
  fields: [
    fld("Campaign", "campaign_id", "Campaign ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Campaign", "campaign_name", "Campaign name", "text", { required: true }),
    fld("Campaign", "job_title", "Job title", "text"),
    fld("Campaign", "requisition_id", "Requisition ID", "text"),
    fld("Campaign", "recruitment_source", "Recruitment source", "text"),
    fld("Campaign", "recruiter", "Recruiter", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Form & schedule", "google_form_url", "Google Form URL", "text"),
    fld("Form & schedule", "form_response_sheet", "Form response sheet", "text"),
    fld("Form & schedule", "form_created_date", "Form created date", "date"),
    fld("Form & schedule", "campaign_start_date", "Campaign start date", "date"),
    fld("Form & schedule", "campaign_end_date", "Campaign end date", "date"),
    fld("Funnel", "target_applications", "Target applications", "number"),
    fld("Funnel", "applications_received", "Applications received", "number"),
    fld("Funnel", "shortlisted", "Shortlisted", "number"),
    fld("Funnel", "interviewed", "Interviewed", "number"),
    fld("Funnel", "selected", "Selected", "number"),
    fld("Funnel", "joined", "Joined", "number"),
    fld("Status", "campaign_status", "Campaign status", "select", { options: ["Planned", "Active", "Paused", "Completed", "Cancelled"], optionsCategory: "campaign_status" }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "campaign_id", label: "Campaign ID", mono: true },
    { key: "campaign_name", label: "Campaign", sub: "job_title" },
    { key: "applications_received", label: "Applications", align: "right" },
    { key: "shortlisted", label: "Shortlisted", align: "right" },
    { key: "selected", label: "Selected", align: "right" },
    { key: "campaign_status", label: "Status", badge: { Active: "default", Completed: "secondary", Planned: "outline", Paused: "outline", Cancelled: "destructive" } },
  ],
  kpis: [
    { label: "Applications", key: "total_applications", icon: "FileText" },
    { label: "Shortlisted", key: "total_shortlisted", icon: "ListChecks" },
    { label: "Selected", key: "total_selected", icon: "UserCheck" },
    { label: "Joined", key: "total_joined", icon: "Users" },
  ],
  summarySelect:
    "COALESCE(SUM(applications_received),0) total_applications, COALESCE(SUM(shortlisted),0) total_shortlisted, COALESCE(SUM(selected),0) total_selected, COALESCE(SUM(joined),0) total_joined, COUNT(*) total_rows",
}

// ---------------------------------------------------------------------------
// Candidate Master was consolidated into Candidate Database. Its ModuleConfig
// was removed so the generic module surface no longer exposes a duplicate
// candidate registry; Candidate Database (components/recruit/candidates-client)
// is the single canonical view over the recruitment_candidates table.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 4. Screening
// ---------------------------------------------------------------------------
const screening: ModuleConfig = {
  key: "screening",
  table: "recruitment_screening",
  label: "Screening",
  subtitle: "Recruitment management",
  addLabel: "New screening",
  idColumn: "screening_id",
  idPrefix: "SCR",
  editableId: true,
  dateColumn: "screening_date",
  statusColumn: "status",
  searchColumns: ["screening_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "recruiter"],
  fields: [
    fld("Screening", "screening_id", "Screening ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Screening", "candidate_id", "Candidate ID", "text"),
    fld("Screening", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Screening", "job_applied", "Job applied", "text"),
    fld("Screening", "requisition_id", "Requisition ID", "text"),
    fld("Screening", "screening_date", "Screening date", "date", { required: true }),
    fld("Screening", "recruiter", "Recruiter", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Scores", "qualification_match", "Qualification match", "number"),
    fld("Scores", "experience_match", "Experience match", "number"),
    fld("Scores", "skill_match", "Skill match", "number"),
    fld("Scores", "communication", "Communication", "number"),
    fld("Scores", "availability", "Availability", "number"),
    fld("Scores", "rate_salary_fit", "Rate / Salary fit", "number"),
    fld("Scores", "overall_score", "Overall score", "number", { computed: true }),
    fld("Outcome", "screening_result", "Screening result", "select", { options: ["Shortlisted", "On Hold", "Rejected"], optionsCategory: "screening_result" }),
    fld("Outcome", "status", "Status", "select", { options: ["Pending", "Completed", "In Progress"] }),
    fld("Outcome", "reason_for_rejection", "Reason for rejection", "text"),
    fld("Outcome", "next_action", "Next action", "text"),
    fld("Outcome", "next_action_date", "Next action date", "date"),
    fld("Outcome", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => {
    const parts = [v.qualification_match, v.experience_match, v.skill_match, v.communication, v.availability, v.rate_salary_fit]
    const given = parts.filter((p) => p !== undefined && p !== null && p !== "")
    const overall = given.length ? round2(given.reduce((s, p) => s + num(p), 0) / given.length) : 0
    return { overall_score: overall }
  },
  tableColumns: [
    { key: "screening_id", label: "Screening ID", mono: true },
    { key: "screening_date", label: "Date" },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "overall_score", label: "Score", align: "right" },
    { key: "screening_result", label: "Result", badge: { Shortlisted: "default", "On Hold": "secondary", Rejected: "destructive" } },
    { key: "status", label: "Status", badge: { Completed: "default", "In Progress": "secondary", Pending: "outline" } },
  ],
  kpis: [
    { label: "Screenings", key: "total_rows", icon: "ListChecks" },
    { label: "Shortlisted", key: "total_shortlisted", icon: "UserCheck" },
    { label: "Rejected", key: "total_rejected", icon: "UserX" },
    { label: "Avg Score", key: "avg_score", icon: "Gauge" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(screening_result = 'Shortlisted'),0) total_shortlisted, COALESCE(SUM(screening_result = 'Rejected'),0) total_rejected, ROUND(COALESCE(AVG(NULLIF(overall_score,0)),0),1) avg_score",
}

// ---------------------------------------------------------------------------
// 5. Interview Tracker
// ---------------------------------------------------------------------------
const interviewTracker: ModuleConfig = {
  key: "interview-tracker",
  table: "recruitment_interviews",
  label: "Interview Tracker",
  subtitle: "Recruitment management",
  addLabel: "New interview",
  idColumn: "interview_id",
  idPrefix: "INT",
  editableId: true,
  dateColumn: "interview_date",
  statusColumn: "interview_result",
  searchColumns: ["interview_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "interviewer", "panel", "recruiter"],
  fields: [
    fld("Interview", "interview_id", "Interview ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Interview", "candidate_id", "Candidate ID", "text"),
    fld("Interview", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Interview", "application_id", "Application ID", "text", { placeholder: "Links to the application pipeline" }),
    fld("Interview", "job_applied", "Job applied", "text"),
    fld("Interview", "requisition_id", "Requisition ID", "text"),
    fld("Interview", "interview_round", "Interview round", "text"),
    fld("Interview", "interview_type", "Interview type", "select", { options: ["Telephonic", "Video", "In-person", "Technical", "HR", "Managerial"], optionsCategory: "interview_type", optional: true }),
    fld("Interview", "interview_mode", "Mode", "select", { options: ["Telephonic", "Video", "In-person", "Onsite"], optionsCategory: "interview_mode", optional: true }),
    fld("Interview", "interviewer", "Interviewer", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Interview", "interviewer_email", "Interviewer email", "text", { placeholder: "Used for the calendar invite" }),
    fld("Interview", "candidate_email", "Candidate email", "text", { placeholder: "Used for the calendar invite" }),
    fld("Interview", "panel", "Panel members", "text", { placeholder: "Comma-separated panel members" }),
    fld("Schedule", "interview_date", "Interview date", "date", { required: true }),
    fld("Schedule", "interview_time", "Interview time", "text"),
    fld("Schedule", "interview_status", "Interview status", "select", {
      options: ["Scheduled", "Confirmed", "Completed", "Rescheduled", "Cancelled", "No Show"],
      default: "Scheduled",
    }),
    fld("Schedule", "interview_link_location", "Interview link / location", "text"),
    fld("Schedule", "meeting_link", "Meeting link", "text", { hidden: true }),
    fld("Schedule", "calendar_event_id", "Calendar event ID", "text", { hidden: true }),
    fld("Schedule", "google_sync_status", "Calendar sync", "text", { hidden: true }),
    fld("Schedule", "attendance", "Attendance", "select", { options: ["Attended", "No Show", "Rescheduled"], optional: true }),
    fld("Scores", "technical_score", "Technical score", "number"),
    fld("Scores", "communication_score", "Communication score", "number"),
    fld("Scores", "subject_score", "Subject score", "number"),
    fld("Scores", "overall_score", "Overall score", "number", { computed: true }),
    fld("Outcome", "interview_result", "Interview result", "select", { options: ["Selected", "On Hold", "Rejected", "Pending"], optionsCategory: "interview_result" }),
    fld("Outcome", "feedback", "Feedback", "textarea"),
    fld("Outcome", "next_round", "Next round", "text"),
    fld("Outcome", "next_interview_date", "Next interview date", "date"),
    fld("Outcome", "recruiter", "Recruiter", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Outcome", "email_status", "Email status", "text"),
    fld("Outcome", "remarks", "Remarks", "textarea"),
    ...TRACKING_FIELDS("Email tracking"),
  ],
  compute: (v) => {
    const parts = [v.technical_score, v.communication_score, v.subject_score]
    const given = parts.filter((p) => p !== undefined && p !== null && p !== "")
    const overall = given.length ? round2(given.reduce((s, p) => s + num(p), 0) / given.length) : 0
    return { overall_score: overall }
  },
  tableColumns: [
    { key: "interview_id", label: "Interview ID", mono: true },
    { key: "interview_date", label: "Date" },
    { key: "candidate_name", label: "Candidate", sub: "interview_round" },
    { key: "overall_score", label: "Score", align: "right" },
    { key: "attendance", label: "Attendance", badge: { Attended: "default", Rescheduled: "secondary", "No Show": "destructive" } },
    { key: "interview_result", label: "Result", badge: { Selected: "default", "On Hold": "secondary", Pending: "outline", Rejected: "destructive" } },
  ],
  kpis: [
    { label: "Interviews", key: "total_rows", icon: "CalendarClock" },
    { label: "Selected", key: "total_selected", icon: "UserCheck" },
    { label: "Rejected", key: "total_rejected", icon: "UserX" },
    { label: "Avg Score", key: "avg_score", icon: "Gauge" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(interview_result = 'Selected'),0) total_selected, COALESCE(SUM(interview_result = 'Rejected'),0) total_rejected, ROUND(COALESCE(AVG(NULLIF(overall_score,0)),0),1) avg_score",
}

// ---------------------------------------------------------------------------
// 6. Assessment Tracker
// ---------------------------------------------------------------------------
const assessmentTracker: ModuleConfig = {
  key: "assessment-tracker",
  table: "recruitment_assessments",
  label: "Assessment Tracker",
  subtitle: "Recruitment management",
  addLabel: "New assessment",
  idColumn: "assessment_id",
  idPrefix: "ASM",
  editableId: true,
  dateColumn: "assessment_sent_date",
  statusColumn: "status",
  searchColumns: ["assessment_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "assessment_type", "evaluator"],
  fields: [
    fld("Assessment", "assessment_id", "Assessment ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Assessment", "candidate_id", "Candidate ID", "text"),
    fld("Assessment", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Assessment", "application_id", "Application ID", "text", { placeholder: "Links to the application pipeline" }),
    fld("Assessment", "job_applied", "Job applied", "text"),
    fld("Assessment", "requisition_id", "Requisition ID", "text"),
    fld("Assessment", "assessment_type", "Assessment type", "text"),
    fld("Schedule", "assessment_sent_date", "Assessment sent date", "date", { required: true }),
    fld("Schedule", "submission_deadline", "Submission deadline", "date"),
    fld("Schedule", "submission_date", "Submission date", "date"),
    fld("Schedule", "assessment_link", "Assessment link", "text"),
    fld("Scores", "score", "Score", "number"),
    fld("Scores", "maximum_score", "Maximum score", "number"),
    fld("Scores", "percentage", "Percentage", "number", { computed: true }),
    fld("Scores", "qc_score", "QC score", "number"),
    fld("Outcome", "assessment_result", "Assessment result", "select", { options: ["Pass", "Fail", "On Hold"] }),
    fld("Outcome", "evaluator", "Evaluator", "text"),
    fld("Outcome", "feedback", "Feedback", "textarea"),
    fld("Outcome", "status", "Status", "select", { options: ["Sent", "Submitted", "Evaluated", "Pending", "Expired"] }),
    fld("Outcome", "remarks", "Remarks", "textarea"),
    ...TRACKING_FIELDS("Email tracking"),
  ],
  compute: (v) => {
    const max = num(v.maximum_score)
    return { percentage: max > 0 ? round2((num(v.score) / max) * 100) : 0 }
  },
  tableColumns: [
    { key: "assessment_id", label: "Assessment ID", mono: true },
    { key: "assessment_sent_date", label: "Sent" },
    { key: "candidate_name", label: "Candidate", sub: "assessment_type" },
    { key: "score", label: "Score", align: "right" },
    { key: "percentage", label: "%", align: "right" },
    { key: "assessment_result", label: "Result", badge: { Pass: "default", "On Hold": "secondary", Fail: "destructive" } },
    { key: "status", label: "Status", badge: { Evaluated: "default", Submitted: "secondary", Sent: "outline", Pending: "outline", Expired: "destructive" } },
  ],
  kpis: [
    { label: "Assessments", key: "total_rows", icon: "ClipboardCheck" },
    { label: "Passed", key: "total_pass", icon: "UserCheck" },
    { label: "Failed", key: "total_fail", icon: "UserX" },
    { label: "Avg %", key: "avg_percentage", icon: "Gauge" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(assessment_result = 'Pass'),0) total_pass, COALESCE(SUM(assessment_result = 'Fail'),0) total_fail, ROUND(COALESCE(AVG(NULLIF(percentage,0)),0),1) avg_percentage",
}

// ---------------------------------------------------------------------------
// 7. Selection & Offers
// ---------------------------------------------------------------------------
const selectionOffers: ModuleConfig = {
  key: "selection-offers",
  table: "recruitment_selections",
  label: "Selection & Offers",
  subtitle: "Recruitment management",
  addLabel: "New selection",
  idColumn: "selection_id",
  idPrefix: "SEL",
  editableId: true,
  dateColumn: "selection_date",
  statusColumn: "offer_status",
  searchColumns: ["selection_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "recruiter"],
  fields: [
    fld("Selection", "selection_id", "Selection ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Selection", "candidate_id", "Candidate ID", "text"),
    fld("Selection", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Selection", "job_applied", "Job applied", "text"),
    fld("Selection", "requisition_id", "Requisition ID", "text"),
    fld("Selection", "selection_date", "Selection date", "date", { required: true }),
    fld("Selection", "selected_by", "Selected by", "text"),
    fld("Selection", "employment_type", "Employment type", "select", { options: EMPLOYMENT_TYPES, optional: true }),
    fld("Offer", "offered_salary_rate", "Offered salary / rate", "text"),
    fld("Offer", "final_salary_rate", "Final salary / rate", "text"),
    fld("Offer", "offer_date", "Offer date", "date"),
    fld("Offer", "offer_sent", "Offer sent", "select", { options: YES_NO, optional: true }),
    fld("Offer", "offer_accepted", "Offer accepted", "select", { options: YES_NO, optional: true }),
    fld("Offer", "offer_acceptance_date", "Offer acceptance date", "date"),
    fld("Offer", "joining_date", "Joining date", "date"),
    fld("Status", "offer_status", "Offer status", "select", { options: ["Draft", "Sent", "Accepted", "Rejected", "On Hold"] }),
    fld("Status", "joining_status", "Joining status", "select", { options: ["Pending", "Joined", "Dropped", "Delayed"] }),
    fld("Status", "reason_for_drop", "Reason for drop", "text"),
    fld("Status", "recruiter", "Recruiter", "select", { optionsCategory: "hr_recruiter", optional: true }),
    fld("Status", "remarks", "Remarks", "textarea"),
    ...TRACKING_FIELDS("Email tracking"),
  ],
  tableColumns: [
    { key: "selection_id", label: "Selection ID", mono: true },
    { key: "selection_date", label: "Date" },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "offer_status", label: "Offer", badge: { Accepted: "default", Sent: "secondary", Draft: "outline", "On Hold": "outline", Rejected: "destructive" } },
    { key: "joining_status", label: "Joining", badge: { Joined: "default", Delayed: "secondary", Pending: "outline", Dropped: "destructive" } },
  ],
  kpis: [
    { label: "Selections", key: "total_rows", icon: "UserCheck" },
    { label: "Offers Accepted", key: "total_accepted", icon: "FileCheck" },
    { label: "Joined", key: "total_joined", icon: "Users" },
    { label: "Dropped", key: "total_dropped", icon: "UserX" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(offer_status = 'Accepted'),0) total_accepted, COALESCE(SUM(joining_status = 'Joined'),0) total_joined, COALESCE(SUM(joining_status = 'Dropped'),0) total_dropped",
}

// ---------------------------------------------------------------------------
// 8. Recruitment Sources
// ---------------------------------------------------------------------------
const recruitmentSources: ModuleConfig = {
  key: "recruitment-sources",
  table: "recruitment_sources",
  label: "Recruitment Sources",
  subtitle: "Recruitment management",
  addLabel: "New source",
  idColumn: "source_id",
  idPrefix: "SRC",
  editableId: true,
  statusColumn: "status",
  searchColumns: ["source_id", "source_name", "source_type", "contact_person", "contact_email"],
  fields: [
    fld("Source", "source_id", "Source ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Source", "source_name", "Source name", "text", { required: true }),
    fld("Source", "source_type", "Source type", "select", { options: ["Job Portal", "Referral", "Social Media", "Agency", "Campus", "Website", "Other"], optional: true }),
    fld("Source", "source_url", "Source URL", "text"),
    fld("Contact", "contact_person", "Contact person", "text"),
    fld("Contact", "contact_email", "Contact email", "text"),
    fld("Contact", "contact_mobile", "Contact mobile", "text"),
    fld("Performance", "cost", "Cost", "number", { money: true }),
    fld("Performance", "applications", "Applications", "number"),
    fld("Performance", "shortlisted", "Shortlisted", "number"),
    fld("Performance", "selected", "Selected", "number"),
    fld("Performance", "joined", "Joined", "number"),
    fld("Performance", "conversion_rate", "Conversion rate %", "number", { computed: true }),
    fld("Status", "status", "Status", "select", { options: ["Active", "Inactive"] }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => {
    const apps = num(v.applications)
    return { conversion_rate: apps > 0 ? round2((num(v.joined) / apps) * 100) : 0 }
  },
  tableColumns: [
    { key: "source_id", label: "Source ID", mono: true },
    { key: "source_name", label: "Source", sub: "source_type" },
    { key: "applications", label: "Applications", align: "right" },
    { key: "joined", label: "Joined", align: "right" },
    { key: "conversion_rate", label: "Conversion %", align: "right" },
    { key: "cost", label: "Cost", align: "right", money: true },
    { key: "status", label: "Status", badge: { Active: "default", Inactive: "outline" } },
  ],
  kpis: [
    { label: "Sources", key: "total_rows", icon: "Network" },
    { label: "Applications", key: "total_applications", icon: "FileText" },
    { label: "Joined", key: "total_joined", icon: "Users" },
    { label: "Total Cost", key: "total_cost", money: true, icon: "Coins" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(applications),0) total_applications, COALESCE(SUM(joined),0) total_joined, COALESCE(SUM(cost),0) total_cost",
}

// ---------------------------------------------------------------------------
// 9. Recruitment Settings
// ---------------------------------------------------------------------------
const recruitmentSettings: ModuleConfig = {
  key: "recruitment-settings",
  table: "recruitment_settings",
  label: "Recruitment Settings",
  subtitle: "Recruitment management",
  addLabel: "New setting",
  idColumn: "setting_id",
  idPrefix: "SET",
  editableId: true,
  statusColumn: "active",
  searchColumns: ["setting_id", "setting_category", "setting_name", "setting_value"],
  fields: [
    fld("Setting", "setting_id", "Setting ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Setting", "setting_category", "Setting category", "text"),
    fld("Setting", "setting_name", "Setting name", "text", { required: true }),
    fld("Setting", "setting_value", "Setting value", "text"),
    fld("Setting", "description", "Description", "textarea"),
    fld("Setting", "active", "Active", "select", { options: ["YES", "NO"] }),
  ],
  tableColumns: [
    { key: "setting_id", label: "Setting ID", mono: true },
    { key: "setting_category", label: "Category" },
    { key: "setting_name", label: "Name", sub: "setting_value" },
    { key: "active", label: "Active", badge: { YES: "default", NO: "outline" } },
  ],
  kpis: [
    { label: "Settings", key: "total_rows", icon: "Settings2" },
    { label: "Active", key: "total_active", icon: "ToggleRight" },
    { label: "Inactive", key: "total_inactive", icon: "ToggleLeft" },
    { label: "Categories", key: "total_categories", icon: "Layers" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(active = 'YES'),0) total_active, COALESCE(SUM(active = 'NO'),0) total_inactive, COUNT(DISTINCT setting_category) total_categories",
}

// ---------------------------------------------------------------------------
// 10. Candidate Activities — per-candidate activity timeline
// ---------------------------------------------------------------------------
const candidateActivities: ModuleConfig = {
  key: "candidate-activities",
  table: "recruitment_candidate_activities",
  label: "Candidate Activities",
  subtitle: "Recruitment management",
  addLabel: "Log activity",
  idColumn: "activity_id",
  idPrefix: "ACT",
  editableId: true,
  dateColumn: "activity_date",
  statusColumn: "activity_type",
  searchColumns: ["activity_id", "candidate_id", "candidate_name", "job_applied", "activity_type", "performed_by", "subject"],
  fields: [
    fld("Activity", "activity_id", "Activity ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Activity", "activity_date", "Activity date", "date", { required: true }),
    fld("Activity", "activity_type", "Activity type", "select", { options: ["Call", "Email", "Interview", "Follow-up", "Note", "Status Change", "Document", "Offer"], required: true }),
    fld("Activity", "performed_by", "Performed by", "text"),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_applied", "Job applied", "text"),
    fld("Candidate", "requisition_id", "Requisition ID", "text"),
    fld("Details", "subject", "Subject", "text"),
    fld("Details", "notes", "Notes", "textarea"),
    fld("Details", "outcome", "Outcome", "text"),
    fld("Follow-up", "next_action", "Next action", "text"),
    fld("Follow-up", "next_action_date", "Next action date", "date"),
  ],
  tableColumns: [
    { key: "activity_id", label: "Activity ID", mono: true },
    { key: "activity_date", label: "Date" },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "activity_type", label: "Type", badge: { Call: "default", Email: "secondary", Interview: "default", "Follow-up": "outline", Note: "outline", "Status Change": "secondary", Document: "outline", Offer: "default" } },
    { key: "performed_by", label: "By" },
    { key: "next_action_date", label: "Next action" },
  ],
  kpis: [
    { label: "Activities", key: "total_rows", icon: "ClipboardList" },
    { label: "Calls", key: "total_calls", icon: "Clock" },
    { label: "Interviews", key: "total_interviews", icon: "CalendarClock" },
    { label: "Follow-ups", key: "total_followups", icon: "ListChecks" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(activity_type = 'Call'),0) total_calls, COALESCE(SUM(activity_type = 'Interview'),0) total_interviews, COALESCE(SUM(activity_type = 'Follow-up'),0) total_followups",
}

// ---------------------------------------------------------------------------
// 11. Candidate Documents
// ---------------------------------------------------------------------------
const candidateDocuments: ModuleConfig = {
  key: "candidate-documents",
  table: "recruitment_candidate_documents",
  label: "Candidate Documents",
  subtitle: "Recruitment management",
  addLabel: "Add document",
  idColumn: "document_id",
  idPrefix: "DOC",
  editableId: true,
  dateColumn: "received_date",
  statusColumn: "verification_status",
  searchColumns: ["document_id", "candidate_id", "candidate_name", "job_applied", "document_type", "document_name", "document_number"],
  fields: [
    fld("Document", "document_id", "Document ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Document", "received_date", "Received date", "date", { required: true }),
    fld("Document", "document_type", "Document type", "select", { options: ["Resume", "Cover Letter", "ID Proof", "Education", "Experience", "Certificate", "Other"], required: true }),
    fld("Document", "document_name", "Document name", "text", { required: true }),
    fld("Document", "document_url", "Document URL", "text", { placeholder: "Link from the document store" }),
    fld("Document", "document_number", "Document number", "text"),
    fld("Document", "issued_by", "Issued by", "text"),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_applied", "Job applied", "text"),
    fld("Candidate", "application_id", "Application ID", "text"),
    fld("Verification", "verification_status", "Verification status", "select", { options: ["Pending", "Verified", "Rejected", "Not Required"] }),
    fld("Verification", "verified_by", "Verified by", "text"),
    fld("Verification", "verified_date", "Verified date", "date"),
    fld("Verification", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "document_id", label: "Document ID", mono: true },
    { key: "received_date", label: "Received" },
    { key: "candidate_name", label: "Candidate", sub: "document_type" },
    { key: "document_name", label: "Document" },
    { key: "verification_status", label: "Status", badge: { Verified: "default", Pending: "secondary", "Not Required": "outline", Rejected: "destructive" } },
  ],
  kpis: [
    { label: "Documents", key: "total_rows", icon: "FileText" },
    { label: "Verified", key: "total_verified", icon: "FileCheck" },
    { label: "Pending", key: "total_pending", icon: "Clock" },
    { label: "Document Types", key: "total_types", icon: "Layers" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(verification_status = 'Verified'),0) total_verified, COALESCE(SUM(verification_status = 'Pending'),0) total_pending, COUNT(DISTINCT document_type) total_types",
}

// ---------------------------------------------------------------------------
// 12. Employee Referrals
// ---------------------------------------------------------------------------
const employeeReferrals: ModuleConfig = {
  key: "employee-referrals",
  table: "recruitment_referrals",
  label: "Employee Referrals",
  subtitle: "Recruitment management",
  addLabel: "New referral",
  idColumn: "referral_id",
  idPrefix: "REF",
  editableId: true,
  dateColumn: "referral_date",
  statusColumn: "status",
  searchColumns: ["referral_id", "referrer_name", "referrer_employee_id", "candidate_name", "candidate_id", "job_title", "requisition_id"],
  fields: [
    fld("Referral", "referral_id", "Referral ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Referral", "referral_date", "Referral date", "date", { required: true }),
    fld("Referrer", "referrer_employee_id", "Referrer employee ID", "text"),
    fld("Referrer", "referrer_name", "Referrer name", "text", { required: true }),
    fld("Referrer", "referrer_department", "Referrer department", "select", { optionsCategory: "hr_department", optional: true }),
    fld("Referrer", "relationship", "Relationship to candidate", "text"),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "candidate_email", "Candidate email", "text"),
    fld("Candidate", "candidate_mobile", "Candidate mobile", "text"),
    fld("Position", "job_title", "Job title", "text"),
    fld("Position", "requisition_id", "Requisition ID", "text"),
    fld("Status", "status", "Status", "select", { options: ["Submitted", "Screening", "Shortlisted", "Interviewed", "Selected", "Rejected", "Joined"] }),
    fld("Bonus", "referral_bonus", "Referral bonus", "number", { money: true }),
    fld("Bonus", "bonus_status", "Bonus status", "select", { options: ["Not Applicable", "Pending", "Approved", "Paid"] }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "referral_id", label: "Referral ID", mono: true },
    { key: "referral_date", label: "Date" },
    { key: "referrer_name", label: "Referrer", sub: "referrer_department" },
    { key: "candidate_name", label: "Candidate", sub: "job_title" },
    { key: "status", label: "Status", badge: { Joined: "default", Selected: "default", Shortlisted: "secondary", Interviewed: "secondary", Screening: "outline", Submitted: "outline", Rejected: "destructive" } },
    { key: "referral_bonus", label: "Bonus", align: "right", money: true },
  ],
  kpis: [
    { label: "Referrals", key: "total_rows", icon: "Users" },
    { label: "Joined", key: "total_joined", icon: "UserCheck" },
    { label: "Bonus Payable", key: "total_bonus", money: true, icon: "Coins" },
    { label: "Pending Bonus", key: "total_pending_bonus", icon: "Clock" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(status = 'Joined'),0) total_joined, COALESCE(SUM(referral_bonus),0) total_bonus, COALESCE(SUM(bonus_status = 'Pending'),0) total_pending_bonus",
}

// ---------------------------------------------------------------------------
// 13. Recruitment Tasks
// ---------------------------------------------------------------------------
const recruitmentTasks: ModuleConfig = {
  key: "recruitment-tasks",
  table: "recruitment_tasks",
  label: "Recruitment Tasks",
  subtitle: "Recruitment management",
  addLabel: "New task",
  idColumn: "task_id",
  idPrefix: "TASK",
  editableId: true,
  dateColumn: "due_date",
  statusColumn: "status",
  searchColumns: ["task_id", "task_title", "task_type", "candidate_name", "candidate_id", "job_title", "assigned_to"],
  fields: [
    fld("Task", "task_id", "Task ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Task", "task_title", "Task title", "text", { required: true }),
    fld("Task", "task_type", "Task type", "select", { options: ["Call", "Email", "Interview", "Document", "Follow-up", "Offer", "Reference", "BGV", "Joining", "Other"], required: true }),
    fld("Task", "assigned_to", "Assigned to", "text"),
    fld("Task", "priority", "Priority", "select", { options: PRIORITIES, optional: true }),
    fld("Linked to", "candidate_id", "Candidate ID", "text"),
    fld("Linked to", "candidate_name", "Candidate name", "text"),
    fld("Linked to", "application_id", "Application ID", "text"),
    fld("Linked to", "job_title", "Job title", "text"),
    fld("Linked to", "requisition_id", "Requisition ID", "text"),
    fld("Schedule", "start_date", "Start date", "date"),
    fld("Schedule", "due_date", "Due date", "date", { required: true }),
    fld("Schedule", "completed_date", "Completed date", "date"),
    fld("Status", "status", "Status", "select", { options: ["Pending", "In Progress", "Completed", "Cancelled"] }),
    fld("Status", "description", "Description", "textarea"),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "task_id", label: "Task ID", mono: true },
    { key: "due_date", label: "Due" },
    { key: "task_title", label: "Task", sub: "task_type" },
    { key: "assigned_to", label: "Assigned to" },
    { key: "priority", label: "Priority", badge: { Urgent: "destructive", High: "default", Medium: "secondary", Low: "outline" } },
    { key: "status", label: "Status", badge: { Completed: "default", "In Progress": "secondary", Pending: "outline", Cancelled: "destructive" } },
  ],
  kpis: [
    { label: "Tasks", key: "total_rows", icon: "ClipboardCheck" },
    { label: "Pending", key: "total_pending", icon: "Clock" },
    { label: "In Progress", key: "total_inprogress", icon: "ListChecks" },
    { label: "Completed", key: "total_completed", icon: "UserCheck" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(status = 'Pending'),0) total_pending, COALESCE(SUM(status = 'In Progress'),0) total_inprogress, COALESCE(SUM(status = 'Completed'),0) total_completed",
}

// ---------------------------------------------------------------------------
// 14. Recruitment Follow-ups
// ---------------------------------------------------------------------------
const recruitmentFollowups: ModuleConfig = {
  key: "recruitment-followups",
  table: "recruitment_followups",
  label: "Recruitment Follow-ups",
  subtitle: "Recruitment management",
  addLabel: "New follow-up",
  idColumn: "followup_id",
  idPrefix: "FUP",
  editableId: true,
  dateColumn: "next_followup_date",
  statusColumn: "status",
  searchColumns: ["followup_id", "candidate_name", "candidate_id", "job_title", "owner", "followup_type"],
  fields: [
    fld("Follow-up", "followup_id", "Follow-up ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Follow-up", "followup_type", "Follow-up type", "select", { options: ["Call", "Email", "WhatsApp", "Meeting", "Other"], optional: true }),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_title", "Job title", "text"),
    fld("Candidate", "requisition_id", "Requisition ID", "text"),
    fld("Schedule", "last_contact_date", "Last contact date", "date"),
    fld("Schedule", "next_followup_date", "Next follow-up date", "date", { required: true }),
    fld("Ownership", "owner", "Owner", "text"),
    fld("Ownership", "priority", "Priority", "select", { options: PRIORITIES, optional: true }),
    fld("Reminder", "reminder", "Reminder", "select", { options: YES_NO, optional: true }),
    fld("Reminder", "reminder_date", "Reminder date", "date"),
    fld("Status", "status", "Status", "select", { options: ["Open", "Scheduled", "Done", "Overdue", "Cancelled"] }),
    fld("Status", "notes", "Notes", "textarea"),
  ],
  tableColumns: [
    { key: "followup_id", label: "Follow-up ID", mono: true },
    { key: "next_followup_date", label: "Next follow-up" },
    { key: "candidate_name", label: "Candidate", sub: "job_title" },
    { key: "owner", label: "Owner" },
    { key: "priority", label: "Priority", badge: { Urgent: "destructive", High: "default", Medium: "secondary", Low: "outline" } },
    { key: "status", label: "Status", badge: { Done: "default", Scheduled: "secondary", Open: "outline", Overdue: "destructive", Cancelled: "destructive" } },
  ],
  kpis: [
    { label: "Follow-ups", key: "total_rows", icon: "CalendarClock" },
    { label: "Open", key: "total_open", icon: "ListChecks" },
    { label: "Done", key: "total_done", icon: "UserCheck" },
    { label: "Overdue", key: "total_overdue", icon: "Clock" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(status = 'Open'),0) total_open, COALESCE(SUM(status = 'Done'),0) total_done, COALESCE(SUM(status = 'Overdue'),0) total_overdue",
}

// ---------------------------------------------------------------------------
// 15. Recruitment Vendors
// ---------------------------------------------------------------------------
const recruitmentVendors: ModuleConfig = {
  key: "recruitment-vendors",
  table: "recruitment_vendors",
  label: "Recruitment Vendors",
  subtitle: "Recruitment management",
  addLabel: "New vendor",
  idColumn: "vendor_id",
  idPrefix: "RVN",
  editableId: true,
  dateColumn: "agreement_date",
  statusColumn: "status",
  searchColumns: ["vendor_id", "vendor_name", "vendor_type", "contact_person", "contact_email", "gstin", "pan"],
  fields: [
    fld("Vendor", "vendor_id", "Vendor ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Vendor", "vendor_name", "Vendor name", "text", { required: true }),
    fld("Vendor", "vendor_type", "Vendor type", "select", { options: ["Agency", "Consultant", "Job Portal", "Freelancer", "Other"], optional: true }),
    fld("Contact", "contact_person", "Contact person", "text"),
    fld("Contact", "contact_email", "Contact email", "text"),
    fld("Contact", "contact_mobile", "Contact mobile", "text"),
    fld("Contact", "address", "Address", "textarea"),
    fld("Compliance", "gstin", "GSTIN", "text"),
    fld("Compliance", "pan", "PAN", "text"),
    fld("Agreement", "agreement_ref", "Agreement reference", "text"),
    fld("Agreement", "agreement_date", "Agreement date", "date"),
    fld("Agreement", "agreement_expiry", "Agreement expiry", "date"),
    fld("Fee", "fee_type", "Fee type", "select", { options: ["Percentage", "Fixed", "Per Hire"], optional: true }),
    fld("Fee", "fee_value", "Fee value", "number"),
    fld("Performance", "candidates_submitted", "Candidates submitted", "number"),
    fld("Performance", "candidates_placed", "Candidates placed", "number"),
    fld("Performance", "placement_status", "Placement status", "select", { options: ["Active", "On Hold", "Terminated"], optional: true }),
    fld("Billing", "total_billed", "Total billed", "number", { money: true }),
    fld("Billing", "total_paid", "Total paid", "number", { money: true }),
    fld("Billing", "payment_status", "Payment status", "select", { options: ["Pending", "Partial", "Paid", "Not Applicable"], optional: true }),
    fld("Status", "status", "Status", "select", { options: ["Active", "Inactive"] }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "vendor_id", label: "Vendor ID", mono: true },
    { key: "vendor_name", label: "Vendor", sub: "vendor_type" },
    { key: "candidates_submitted", label: "Submitted", align: "right" },
    { key: "candidates_placed", label: "Placed", align: "right" },
    { key: "placement_status", label: "Placement", badge: { Active: "default", "On Hold": "secondary", Terminated: "destructive" } },
    { key: "status", label: "Status", badge: { Active: "default", Inactive: "outline" } },
  ],
  kpis: [
    { label: "Vendors", key: "total_rows", icon: "Network" },
    { label: "Submitted", key: "total_submitted", icon: "FileText" },
    { label: "Placed", key: "total_placed", icon: "UserCheck" },
    { label: "Total Billed", key: "total_billed", money: true, icon: "Coins" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(candidates_submitted),0) total_submitted, COALESCE(SUM(candidates_placed),0) total_placed, COALESCE(SUM(total_billed),0) total_billed",
}

// ---------------------------------------------------------------------------
// 16. Recruitment Cost & Hiring Budget
// ---------------------------------------------------------------------------
const recruitmentCosts: ModuleConfig = {
  key: "recruitment-costs",
  table: "recruitment_costs",
  label: "Recruitment Cost & Budget",
  subtitle: "Recruitment management",
  addLabel: "New cost entry",
  idColumn: "cost_id",
  idPrefix: "RCT",
  editableId: true,
  dateColumn: "cost_date",
  statusColumn: "payment_status",
  searchColumns: ["cost_id", "cost_category", "description", "requisition_id", "job_title", "vendor_name", "expense_id"],
  fields: [
    fld("Cost", "cost_id", "Cost ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Cost", "cost_date", "Cost date", "date", { required: true }),
    fld("Cost", "cost_category", "Cost category", "select", { options: ["Agency Fee", "Job Portal", "Advertising", "Background Verification", "Interview Cost", "Referral Bonus", "Assessment", "Other"], required: true }),
    fld("Cost", "description", "Description", "text"),
    fld("Linked to", "requisition_id", "Requisition ID", "text"),
    fld("Linked to", "job_title", "Job title", "text"),
    fld("Linked to", "candidate_id", "Candidate ID", "text"),
    fld("Linked to", "application_id", "Application ID", "text"),
    fld("Vendor", "vendor_id", "Vendor ID", "text"),
    fld("Vendor", "vendor_name", "Vendor name", "text"),
    fld("Budget", "budget_amount", "Budget amount", "number", { money: true }),
    fld("Budget", "actual_amount", "Actual amount", "number", { money: true }),
    fld("Budget", "variance", "Variance (budget − actual)", "number", { money: true, computed: true }),
    fld("Finance", "expense_id", "Finance expense ID", "text", { placeholder: "Link to a Finance expense" }),
    fld("Finance", "payment_status", "Payment status", "select", { options: ["Pending", "Approved", "Paid"] }),
    fld("Finance", "paid_date", "Paid date", "date"),
    fld("Finance", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => ({
    variance: round2(num(v.budget_amount) - num(v.actual_amount)),
  }),
  tableColumns: [
    { key: "cost_id", label: "Cost ID", mono: true },
    { key: "cost_date", label: "Date" },
    { key: "cost_category", label: "Category", sub: "job_title" },
    { key: "budget_amount", label: "Budget", align: "right", money: true },
    { key: "actual_amount", label: "Actual", align: "right", money: true },
    { key: "payment_status", label: "Payment", badge: { Paid: "default", Approved: "secondary", Pending: "outline" } },
  ],
  kpis: [
    { label: "Cost Entries", key: "total_rows", icon: "ClipboardList" },
    { label: "Total Budget", key: "total_budget", money: true, icon: "Coins" },
    { label: "Actual Cost", key: "total_actual", money: true, icon: "FileText" },
    { label: "Remaining Budget", key: "total_variance", money: true, icon: "Gauge" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(budget_amount),0) total_budget, COALESCE(SUM(actual_amount),0) total_actual, COALESCE(SUM(budget_amount - actual_amount),0) total_variance",
}

// ---------------------------------------------------------------------------
// 17. Interview Feedback (per-interviewer, panel-aware)
// ---------------------------------------------------------------------------
// Extends the interview process with one traceable feedback record per
// interviewer / panel member, kept separate from the Interview Tracker so a
// single interview can hold several independent evaluations.
const interviewFeedback: ModuleConfig = {
  key: "interview-feedback",
  table: "recruitment_interview_feedback",
  label: "Interview Feedback",
  subtitle: "Recruitment management",
  addLabel: "New feedback",
  idColumn: "feedback_id",
  idPrefix: "IFB",
  editableId: true,
  dateColumn: "feedback_date",
  statusColumn: "final_result",
  searchColumns: ["feedback_id", "interview_id", "candidate_id", "candidate_name", "job_applied", "interviewer", "interview_panel"],
  fields: [
    fld("Feedback", "feedback_id", "Feedback ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Feedback", "feedback_date", "Feedback date", "date", { required: true }),
    fld("Feedback", "interview_id", "Interview ID", "text", { placeholder: "Link to the interview" }),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_applied", "Job applied", "text"),
    fld("Candidate", "requisition_id", "Requisition ID", "text"),
    fld("Interview", "interview_round", "Interview round", "text"),
    fld("Interview", "interview_type", "Interview type", "select", { options: ["Telephonic", "Video", "In-person", "Technical", "HR", "Managerial"], optional: true }),
    fld("Interview", "interview_date", "Interview date", "date"),
    fld("Interview", "interview_time", "Interview time", "text"),
    fld("Panel", "interviewer", "Interviewer", "select", { optionsCategory: "hr_recruiter", required: true }),
    fld("Panel", "interview_panel", "Interview panel", "text", { placeholder: "Panel name / other members" }),
    fld("Scores", "technical_score", "Technical score", "number"),
    fld("Scores", "communication_score", "Communication score", "number"),
    fld("Scores", "role_fit_score", "Role fit score", "number"),
    fld("Scores", "domain_knowledge_score", "Domain knowledge score", "number"),
    fld("Scores", "problem_solving_score", "Problem solving score", "number"),
    fld("Scores", "overall_score", "Overall score", "number", { computed: true }),
    fld("Outcome", "recommendation", "Recommendation", "select", { options: ["Strong Hire", "Hire", "Neutral", "No Hire", "Strong No Hire"], optional: true }),
    fld("Outcome", "final_result", "Final result", "select", { options: ["Pending", "Next Round", "Selected", "Rejected", "Hold"] }),
    fld("Outcome", "comments", "Comments", "textarea"),
  ],
  compute: (v) => {
    const parts = [
      v.technical_score,
      v.communication_score,
      v.role_fit_score,
      v.domain_knowledge_score,
      v.problem_solving_score,
    ]
    const given = parts.filter((p) => p !== undefined && p !== null && p !== "")
    const overall = given.length ? round2(given.reduce((s, p) => s + num(p), 0) / given.length) : 0
    return { overall_score: overall }
  },
  tableColumns: [
    { key: "feedback_id", label: "Feedback ID", mono: true },
    { key: "feedback_date", label: "Date" },
    { key: "candidate_name", label: "Candidate", sub: "interview_round" },
    { key: "interviewer", label: "Interviewer", sub: "interview_panel" },
    { key: "overall_score", label: "Score", align: "right" },
    { key: "recommendation", label: "Recommendation", badge: { "Strong Hire": "default", Hire: "default", Neutral: "secondary", "No Hire": "destructive", "Strong No Hire": "destructive" } },
    { key: "final_result", label: "Result", badge: { Selected: "default", "Next Round": "secondary", Pending: "outline", Hold: "outline", Rejected: "destructive" } },
  ],
  kpis: [
    { label: "Feedback Records", key: "total_rows", icon: "ClipboardCheck" },
    { label: "Selected", key: "total_selected", icon: "UserCheck" },
    { label: "Rejected", key: "total_rejected", icon: "UserX" },
    { label: "Avg Score", key: "avg_score", icon: "Gauge" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(final_result = 'Selected'),0) total_selected, COALESCE(SUM(final_result = 'Rejected'),0) total_rejected, ROUND(COALESCE(AVG(NULLIF(overall_score,0)),0),1) avg_score",
}

// ---------------------------------------------------------------------------
// 18. Background Verification
// ---------------------------------------------------------------------------
const backgroundVerification: ModuleConfig = {
  key: "background-verification",
  table: "recruitment_background_verification",
  label: "Background Verification",
  subtitle: "Recruitment management",
  addLabel: "New verification",
  idColumn: "bgv_id",
  idPrefix: "BGV",
  editableId: true,
  dateColumn: "initiated_date",
  statusColumn: "status",
  searchColumns: ["bgv_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "vendor_name", "check_type"],
  fields: [
    fld("Verification", "bgv_id", "Verification ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Verification", "initiated_date", "Initiated date", "date", { required: true }),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_applied", "Job applied", "text"),
    fld("Candidate", "requisition_id", "Requisition ID", "text"),
    fld("Checks", "check_type", "Check type", "select", { options: ["Identity", "Employment", "Education", "Reference", "Criminal", "Address", "Other"], required: true }),
    fld("Checks", "vendor_name", "Verification vendor", "text"),
    fld("Checks", "reference_number", "Reference / case number", "text"),
    fld("Checks", "document_url", "Supporting document URL", "text", { placeholder: "Link from the document store" }),
    fld("Result", "status", "Status", "select", { options: ["Initiated", "In Progress", "Verified", "Failed", "Requires Review"] }),
    fld("Result", "completed_date", "Completed date", "date"),
    fld("Result", "verified_by", "Verified by", "text"),
    fld("Result", "findings", "Findings", "textarea"),
    fld("Result", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "bgv_id", label: "Verification ID", mono: true },
    { key: "initiated_date", label: "Initiated" },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "check_type", label: "Check", sub: "vendor_name" },
    { key: "status", label: "Status", badge: { Verified: "default", "In Progress": "secondary", Initiated: "outline", "Requires Review": "outline", Failed: "destructive" } },
  ],
  kpis: [
    { label: "Verifications", key: "total_rows", icon: "ClipboardCheck" },
    { label: "Verified", key: "total_verified", icon: "UserCheck" },
    { label: "In Progress", key: "total_progress", icon: "Clock" },
    { label: "Failed / Review", key: "total_failed", icon: "UserX" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(status = 'Verified'),0) total_verified, COALESCE(SUM(status IN ('Initiated','In Progress')),0) total_progress, COALESCE(SUM(status IN ('Failed','Requires Review')),0) total_failed",
}

// ---------------------------------------------------------------------------
// 19. Reference Check
// ---------------------------------------------------------------------------
const referenceCheck: ModuleConfig = {
  key: "reference-check",
  table: "recruitment_reference_checks",
  label: "Reference Check",
  subtitle: "Recruitment management",
  addLabel: "New reference check",
  idColumn: "reference_id",
  idPrefix: "RFC",
  editableId: true,
  dateColumn: "check_date",
  statusColumn: "result",
  searchColumns: ["reference_id", "candidate_id", "candidate_name", "reference_name", "reference_company", "job_applied"],
  fields: [
    fld("Reference", "reference_id", "Reference ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Reference", "check_date", "Check date", "date", { required: true }),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_applied", "Job applied", "text"),
    fld("Candidate", "requisition_id", "Requisition ID", "text"),
    fld("Referee", "reference_name", "Reference name", "text", { required: true }),
    fld("Referee", "reference_company", "Company", "text"),
    fld("Referee", "reference_designation", "Designation", "text"),
    fld("Referee", "relationship", "Relationship", "text"),
    fld("Referee", "reference_contact", "Contact", "text"),
    fld("Referee", "reference_email", "Email", "text"),
    fld("Outcome", "conducted_by", "Conducted by", "text"),
    fld("Outcome", "result", "Result", "select", { options: ["Pending", "Positive", "Negative", "Neutral", "Unable to Reach"] }),
    fld("Outcome", "feedback", "Feedback", "textarea"),
    fld("Outcome", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "reference_id", label: "Reference ID", mono: true },
    { key: "check_date", label: "Date" },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "reference_name", label: "Reference", sub: "reference_company" },
    { key: "result", label: "Result", badge: { Positive: "default", Neutral: "secondary", Pending: "outline", "Unable to Reach": "outline", Negative: "destructive" } },
  ],
  kpis: [
    { label: "Reference Checks", key: "total_rows", icon: "ClipboardCheck" },
    { label: "Positive", key: "total_positive", icon: "UserCheck" },
    { label: "Pending", key: "total_pending", icon: "Clock" },
    { label: "Negative", key: "total_negative", icon: "UserX" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(result = 'Positive'),0) total_positive, COALESCE(SUM(result = 'Pending'),0) total_pending, COALESCE(SUM(result = 'Negative'),0) total_negative",
}

// ---------------------------------------------------------------------------
// 20. Pre-Joining (checklist with completion %)
// ---------------------------------------------------------------------------
const PRE_JOIN_STEPS = ["offer_accepted", "documents_collected", "background_verification", "reference_check", "joining_confirmation", "hr_handoff"] as const
const preJoining: ModuleConfig = {
  key: "pre-joining",
  table: "recruitment_pre_joining",
  label: "Pre-Joining",
  subtitle: "Recruitment management",
  addLabel: "New pre-joining",
  idColumn: "prejoin_id",
  idPrefix: "PRJ",
  editableId: true,
  dateColumn: "expected_joining_date",
  statusColumn: "status",
  searchColumns: ["prejoin_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "offer_id"],
  fields: [
    fld("Pre-Joining", "prejoin_id", "Pre-joining ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "job_applied", "Job applied", "text"),
    fld("Candidate", "requisition_id", "Requisition ID", "text"),
    fld("Candidate", "offer_id", "Offer ID", "text"),
    fld("Schedule", "expected_joining_date", "Expected joining date", "date", { required: true }),
    fld("Schedule", "coordinator", "Coordinator", "text"),
    fld("Checklist", "offer_accepted", "Offer accepted", "select", { options: YES_NO, optional: true }),
    fld("Checklist", "documents_collected", "Documents collected", "select", { options: YES_NO, optional: true }),
    fld("Checklist", "background_verification", "Background verification", "select", { options: YES_NO, optional: true }),
    fld("Checklist", "reference_check", "Reference check", "select", { options: YES_NO, optional: true }),
    fld("Checklist", "joining_confirmation", "Joining confirmation", "select", { options: YES_NO, optional: true }),
    fld("Checklist", "hr_handoff", "HR handoff", "select", { options: YES_NO, optional: true }),
    fld("Status", "completion_percent", "Completion %", "number", { computed: true }),
    fld("Status", "status", "Status", "select", { options: ["Pending", "In Progress", "Ready to Join", "Joined", "Dropped"] }),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  compute: (v) => {
    const done = PRE_JOIN_STEPS.filter((s) => String((v as any)[s] || "").toLowerCase() === "yes").length
    return { completion_percent: Math.round((done / PRE_JOIN_STEPS.length) * 100) }
  },
  tableColumns: [
    { key: "prejoin_id", label: "Pre-joining ID", mono: true },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "expected_joining_date", label: "Joining" },
    { key: "completion_percent", label: "Checklist %", align: "right" },
    { key: "status", label: "Status", badge: { Joined: "default", "Ready to Join": "default", "In Progress": "secondary", Pending: "outline", Dropped: "destructive" } },
  ],
  kpis: [
    { label: "Pre-Joining", key: "total_rows", icon: "ClipboardCheck" },
    { label: "Ready to Join", key: "total_ready", icon: "UserCheck" },
    { label: "Joined", key: "total_joined", icon: "Users" },
    { label: "Avg Checklist %", key: "avg_completion", icon: "Gauge" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(status = 'Ready to Join'),0) total_ready, COALESCE(SUM(status = 'Joined'),0) total_joined, ROUND(COALESCE(AVG(completion_percent),0),0) avg_completion",
}

// ---------------------------------------------------------------------------
// 21. Talent Pool
// ---------------------------------------------------------------------------
const talentPool: ModuleConfig = {
  key: "talent-pool",
  table: "recruitment_talent_pool",
  label: "Talent Pool",
  subtitle: "Recruitment management",
  addLabel: "Add to talent pool",
  idColumn: "pool_id",
  idPrefix: "TAL",
  editableId: true,
  dateColumn: "added_date",
  statusColumn: "pool_status",
  searchColumns: ["pool_id", "candidate_id", "candidate_name", "email", "mobile", "primary_skills", "preferred_role"],
  fields: [
    fld("Talent", "pool_id", "Pool ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Talent", "added_date", "Added date", "date", { required: true }),
    fld("Candidate", "candidate_id", "Candidate ID", "text"),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "email", "Email", "text"),
    fld("Candidate", "mobile", "Mobile", "text"),
    fld("Candidate", "current_location", "Current location", "text"),
    fld("Profile", "preferred_role", "Preferred role", "text"),
    fld("Profile", "experience", "Experience", "text"),
    fld("Profile", "primary_skills", "Primary skills", "textarea"),
    fld("Profile", "expected_ctc_rate", "Expected CTC / Rate", "text"),
    fld("Profile", "notice_period", "Notice period", "text"),
    fld("Profile", "source", "Source", "text"),
    fld("Status", "pool_status", "Pool status", "select", { options: ["Available", "Future Opportunity", "Passive", "Rejected but Reusable", "Placed"] }),
    fld("Status", "next_contact_date", "Next contact date", "date"),
    fld("Status", "owner", "Owner", "text"),
    fld("Status", "remarks", "Remarks", "textarea"),
  ],
  tableColumns: [
    { key: "pool_id", label: "Pool ID", mono: true },
    { key: "added_date", label: "Added" },
    { key: "candidate_name", label: "Candidate", sub: "preferred_role" },
    { key: "experience", label: "Experience" },
    { key: "pool_status", label: "Status", badge: { Available: "default", "Future Opportunity": "secondary", Passive: "outline", "Rejected but Reusable": "outline", Placed: "secondary" } },
  ],
  kpis: [
    { label: "Talent Pool", key: "total_rows", icon: "Users" },
    { label: "Available", key: "total_available", icon: "UserCheck" },
    { label: "Future Opportunity", key: "total_future", icon: "Clock" },
    { label: "Passive", key: "total_passive", icon: "UserPlus" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(pool_status = 'Available'),0) total_available, COALESCE(SUM(pool_status = 'Future Opportunity'),0) total_future, COALESCE(SUM(pool_status = 'Passive'),0) total_passive",
}

export const RECRUITMENT_MODULE_CONFIGS: Record<string, ModuleConfig> = {
  "job-requisitions": jobRequisitions,
  "recruitment-campaigns": recruitmentCampaigns,
  "screening": screening,
  "interview-tracker": interviewTracker,
  "assessment-tracker": assessmentTracker,
  "selection-offers": selectionOffers,
  "recruitment-sources": recruitmentSources,
  "recruitment-settings": recruitmentSettings,
  "candidate-activities": candidateActivities,
  "candidate-documents": candidateDocuments,
  "employee-referrals": employeeReferrals,
  "recruitment-tasks": recruitmentTasks,
  "recruitment-followups": recruitmentFollowups,
  "recruitment-vendors": recruitmentVendors,
  "recruitment-costs": recruitmentCosts,
  "interview-feedback": interviewFeedback,
  "background-verification": backgroundVerification,
  "reference-check": referenceCheck,
  "pre-joining": preJoining,
  "talent-pool": talentPool,
}

export const RECRUITMENT_MODULE_KEYS = Object.keys(RECRUITMENT_MODULE_CONFIGS)

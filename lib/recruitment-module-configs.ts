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

/** Terse field builder. */
function fld(section: string, key: string, label: string, type: FieldType = "text", extra: Partial<FieldDef> = {}): FieldDef {
  return { section, key, label, type, ...extra }
}

const EMPLOYMENT_TYPES = ["Full Time", "Part Time", "Contract", "Internship", "Freelance", "Temporary"]
const PRIORITIES = ["Low", "Medium", "High", "Urgent"]
const WORK_MODES = ["On-site", "Hybrid", "Remote"]
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
    fld("Requisition", "department", "Department", "text"),
    fld("Requisition", "project", "Project", "text"),
    fld("Requisition", "employment_type", "Employment type", "select", { options: EMPLOYMENT_TYPES, optional: true }),
    fld("Resources", "required_resources", "Required resources", "number"),
    fld("Resources", "filled_resources", "Filled resources", "number"),
    fld("Resources", "pending_resources", "Pending resources", "number", { computed: true }),
    fld("Resources", "priority", "Priority", "select", { options: PRIORITIES, optional: true }),
    fld("Requirements", "required_qualification", "Required qualification", "text"),
    fld("Requirements", "required_skills", "Required skills", "textarea"),
    fld("Requirements", "experience_required", "Experience required", "text"),
    fld("Requirements", "location", "Location", "text"),
    fld("Requirements", "work_mode", "Work mode", "select", { options: WORK_MODES, optional: true }),
    fld("Requirements", "rate_salary", "Rate / Salary", "text", { placeholder: "e.g. ₹8-10 LPA" }),
    fld("Ownership", "hiring_manager", "Hiring manager", "text"),
    fld("Ownership", "recruiter", "Recruiter", "text"),
    fld("Ownership", "target_date", "Target date", "date"),
    fld("Ownership", "status", "Status", "select", { options: ["Open", "On Hold", "Closed", "Cancelled", "Filled"] }),
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
    fld("Campaign", "recruiter", "Recruiter", "text"),
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
    fld("Status", "campaign_status", "Campaign status", "select", { options: ["Planned", "Active", "Paused", "Completed", "Cancelled"] }),
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
// 3. Candidate Master
// ---------------------------------------------------------------------------
const candidateMaster: ModuleConfig = {
  key: "candidate-master",
  table: "recruitment_candidates",
  label: "Candidate Master",
  subtitle: "Recruitment management",
  addLabel: "New candidate",
  idColumn: "candidate_id",
  idPrefix: "CAND",
  editableId: true,
  dateColumn: "application_date",
  statusColumn: "candidate_status",
  searchColumns: ["candidate_id", "candidate_name", "email", "mobile", "job_applied", "requisition_id", "primary_skills"],
  fields: [
    fld("Candidate", "candidate_id", "Candidate ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Candidate", "application_date", "Application date", "date", { required: true }),
    fld("Candidate", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Candidate", "email", "Email", "text"),
    fld("Candidate", "mobile", "Mobile", "text"),
    fld("Candidate", "alternate_mobile", "Alternate mobile", "text"),
    fld("Candidate", "current_location", "Current location", "text"),
    fld("Candidate", "preferred_location", "Preferred location", "text"),
    fld("Application", "job_applied", "Job applied", "text"),
    fld("Application", "requisition_id", "Requisition ID", "text"),
    fld("Application", "campaign_id", "Campaign ID", "text"),
    fld("Application", "source", "Source", "text"),
    fld("Application", "form_link", "Form link", "text"),
    fld("Application", "form_response_link", "Form response link", "text"),
    fld("Application", "employment_type", "Employment type", "select", { options: EMPLOYMENT_TYPES, optional: true }),
    fld("Profile", "experience", "Experience", "text"),
    fld("Profile", "highest_qualification", "Highest qualification", "text"),
    fld("Profile", "primary_skills", "Primary skills", "textarea"),
    fld("Profile", "secondary_skills", "Secondary skills", "textarea"),
    fld("Profile", "current_company", "Current company", "text"),
    fld("Compensation", "current_ctc", "Current CTC", "text"),
    fld("Compensation", "expected_ctc_rate", "Expected CTC / Rate", "text"),
    fld("Compensation", "notice_period", "Notice period", "text"),
    fld("Links", "resume_url", "Resume URL", "text"),
    fld("Links", "portfolio_url", "Portfolio URL", "text"),
    fld("Links", "linkedin_url", "LinkedIn URL", "text"),
    fld("Status", "candidate_status", "Candidate status", "text"),
    fld("Status", "remarks", "Remarks", "textarea"),
    fld("Source tracking", "source_spreadsheet", "Source spreadsheet", "text"),
    fld("Source tracking", "source_sheet", "Source sheet", "text"),
    fld("Source tracking", "source_row", "Source row", "number"),
  ],
  tableColumns: [
    { key: "candidate_id", label: "Candidate ID", mono: true },
    { key: "application_date", label: "Applied" },
    { key: "candidate_name", label: "Candidate", sub: "job_applied" },
    { key: "email", label: "Email" },
    { key: "experience", label: "Experience" },
    { key: "candidate_status", label: "Status", badge: {} },
  ],
  kpis: [
    { label: "Total Candidates", key: "total_rows", icon: "Users" },
    { label: "Selected", key: "total_selected", icon: "UserCheck" },
    { label: "In Process", key: "total_process", icon: "Clock" },
    { label: "Rejected", key: "total_rejected", icon: "UserX" },
  ],
  summarySelect:
    "COUNT(*) total_rows, COALESCE(SUM(candidate_status = 'Selected'),0) total_selected, COALESCE(SUM(candidate_status NOT IN ('Selected','Rejected','Joined')),0) total_process, COALESCE(SUM(candidate_status = 'Rejected'),0) total_rejected",
}

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
    fld("Screening", "recruiter", "Recruiter", "text"),
    fld("Scores", "qualification_match", "Qualification match", "number"),
    fld("Scores", "experience_match", "Experience match", "number"),
    fld("Scores", "skill_match", "Skill match", "number"),
    fld("Scores", "communication", "Communication", "number"),
    fld("Scores", "availability", "Availability", "number"),
    fld("Scores", "rate_salary_fit", "Rate / Salary fit", "number"),
    fld("Scores", "overall_score", "Overall score", "number", { computed: true }),
    fld("Outcome", "screening_result", "Screening result", "select", { options: ["Shortlisted", "On Hold", "Rejected"] }),
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
  searchColumns: ["interview_id", "candidate_id", "candidate_name", "job_applied", "requisition_id", "interviewer", "recruiter"],
  fields: [
    fld("Interview", "interview_id", "Interview ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Interview", "candidate_id", "Candidate ID", "text"),
    fld("Interview", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Interview", "job_applied", "Job applied", "text"),
    fld("Interview", "requisition_id", "Requisition ID", "text"),
    fld("Interview", "interview_round", "Interview round", "text"),
    fld("Interview", "interview_type", "Interview type", "select", { options: ["Telephonic", "Video", "In-person", "Technical", "HR", "Managerial"], optional: true }),
    fld("Interview", "interviewer", "Interviewer", "text"),
    fld("Schedule", "interview_date", "Interview date", "date", { required: true }),
    fld("Schedule", "interview_time", "Interview time", "text"),
    fld("Schedule", "interview_link_location", "Interview link / location", "text"),
    fld("Schedule", "attendance", "Attendance", "select", { options: ["Attended", "No Show", "Rescheduled"], optional: true }),
    fld("Scores", "technical_score", "Technical score", "number"),
    fld("Scores", "communication_score", "Communication score", "number"),
    fld("Scores", "subject_score", "Subject score", "number"),
    fld("Scores", "overall_score", "Overall score", "number", { computed: true }),
    fld("Outcome", "interview_result", "Interview result", "select", { options: ["Selected", "On Hold", "Rejected", "Pending"] }),
    fld("Outcome", "feedback", "Feedback", "textarea"),
    fld("Outcome", "next_round", "Next round", "text"),
    fld("Outcome", "next_interview_date", "Next interview date", "date"),
    fld("Outcome", "recruiter", "Recruiter", "text"),
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
  searchColumns: ["assessment_id", "candidate_id", "candidate_name", "job_applied", "assessment_type", "evaluator"],
  fields: [
    fld("Assessment", "assessment_id", "Assessment ID", "text", { placeholder: "Auto-generated if left blank" }),
    fld("Assessment", "candidate_id", "Candidate ID", "text"),
    fld("Assessment", "candidate_name", "Candidate name", "text", { required: true }),
    fld("Assessment", "job_applied", "Job applied", "text"),
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
    fld("Status", "recruiter", "Recruiter", "text"),
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

export const RECRUITMENT_MODULE_CONFIGS: Record<string, ModuleConfig> = {
  "job-requisitions": jobRequisitions,
  "recruitment-campaigns": recruitmentCampaigns,
  "candidate-master": candidateMaster,
  "screening": screening,
  "interview-tracker": interviewTracker,
  "assessment-tracker": assessmentTracker,
  "selection-offers": selectionOffers,
  "recruitment-sources": recruitmentSources,
  "recruitment-settings": recruitmentSettings,
}

export const RECRUITMENT_MODULE_KEYS = Object.keys(RECRUITMENT_MODULE_CONFIGS)

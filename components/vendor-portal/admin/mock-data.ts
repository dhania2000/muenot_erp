/**
 * Mock data + types for the Finance › Vendor Portal admin control center.
 *
 * This is FRONTEND-ONLY scaffolding. Every array below is static sample data so
 * the admin console renders realistically. Codex can later replace these with
 * real API calls / database queries — the component tree consumes these shapes,
 * so keeping the field names stable keeps the wiring straightforward.
 */

export type PortalStatus = "active" | "pending" | "invited" | "suspended" | "rejected" | "disabled"
export type OnboardingStatus = "not_started" | "in_progress" | "under_review" | "completed" | "incomplete"
export type ComplianceStatus = "compliant" | "pending" | "expiring" | "expired" | "rejected"
export type VerificationStatus = "unverified" | "pending" | "verified" | "rejected" | "change_requested"

export const PORTAL_STATUS_LABEL: Record<PortalStatus, string> = {
  active: "Active",
  pending: "Pending",
  invited: "Invited",
  suspended: "Suspended",
  rejected: "Rejected",
  disabled: "Disabled",
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  under_review: "Under review",
  completed: "Completed",
  incomplete: "Incomplete",
}

export const COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string> = {
  compliant: "Compliant",
  pending: "Pending",
  expiring: "Expiring",
  expired: "Expired",
  rejected: "Rejected",
}

/** Tone mapping consumed by the shared StatusBadge helper. */
export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "pending"

export const STATUS_TONE: Record<string, Tone> = {
  // portal
  active: "success",
  pending: "warning",
  invited: "info",
  suspended: "danger",
  rejected: "danger",
  disabled: "neutral",
  // onboarding
  not_started: "neutral",
  in_progress: "info",
  under_review: "warning",
  completed: "success",
  incomplete: "warning",
  // compliance
  compliant: "success",
  expiring: "warning",
  expired: "danger",
  // verification
  unverified: "neutral",
  verified: "success",
  change_requested: "warning",
  // generic
  approved: "success",
  paid: "success",
  new: "info",
  draft: "neutral",
  submitted: "info",
  scheduled: "info",
}

export type KpiTrend = { label: string; value: number; sub: string; delta?: number; tone?: Tone }

export const OVERVIEW_KPIS: KpiTrend[] = [
  { label: "Total Portal Vendors", value: 486, sub: "across all categories", delta: 4.2 },
  { label: "Active Vendors", value: 342, sub: "70% of portal base", delta: 2.1, tone: "success" },
  { label: "Pending Onboarding", value: 38, sub: "in onboarding flow", delta: -6.0, tone: "warning" },
  { label: "Pending Approval", value: 21, sub: "awaiting finance/admin", delta: 12.0, tone: "warning" },
  { label: "Invited Vendors", value: 44, sub: "invitations sent", delta: 8.0, tone: "info" },
  { label: "Active Vendor Users", value: 918, sub: "portal logins", delta: 3.3 },
  { label: "Suspended Accounts", value: 12, sub: "access on hold", delta: 1.0, tone: "danger" },
  { label: "Rejected Applications", value: 17, sub: "last 90 days", delta: -2.0, tone: "danger" },
  { label: "Documents Pending", value: 63, sub: "awaiting verification", delta: 5.0, tone: "warning" },
  { label: "Invoice Requests", value: 74, sub: "submitted this month", delta: 9.4, tone: "info" },
  { label: "Access Requests", value: 19, sub: "open in queue", delta: -1.0, tone: "warning" },
  { label: "Logins (30d)", value: 4127, sub: "portal sign-ins", delta: 6.7 },
]

export const ONBOARDING_FUNNEL = [
  { stage: "Registered", count: 486 },
  { stage: "Email verified", count: 451 },
  { stage: "Business info", count: 402 },
  { stage: "Tax info", count: 371 },
  { stage: "Bank info", count: 348 },
  { stage: "Documents", count: 319 },
  { stage: "Compliance", count: 288 },
  { stage: "Approved", count: 342 },
]

export const ACTIVITY_TREND = [
  { month: "Apr", logins: 3120, invoices: 210 },
  { month: "May", logins: 3480, invoices: 244 },
  { month: "Jun", logins: 3610, invoices: 268 },
  { month: "Jul", logins: 3902, invoices: 251 },
  { month: "Aug", logins: 4015, invoices: 289 },
  { month: "Sep", logins: 4127, invoices: 312 },
]

export const ADOPTION_BY_TYPE = [
  { type: "Manufacturing", value: 142 },
  { type: "Services", value: 118 },
  { type: "Logistics", value: 76 },
  { type: "IT / Software", value: 84 },
  { type: "Consulting", value: 66 },
]

export const COMPLIANCE_BREAKDOWN = [
  { status: "Compliant", count: 288 },
  { status: "Pending", count: 96 },
  { status: "Expiring", count: 61 },
  { status: "Expired", count: 24 },
  { status: "Rejected", count: 17 },
]

export type PortalEvent = {
  id: string
  actor: string
  vendor: string
  action: string
  time: string
  tone: Tone
}

export const RECENT_EVENTS: PortalEvent[] = [
  { id: "e1", actor: "Priya Nair", vendor: "Ashok Iron & Steel", action: "Submitted invoice INV-20456", time: "12 min ago", tone: "info" },
  { id: "e2", actor: "System", vendor: "Meridian Logistics", action: "Bank detail change requested", time: "38 min ago", tone: "warning" },
  { id: "e3", actor: "Rahul Verma", vendor: "BlueOak Consulting", action: "Application approved", time: "1 hr ago", tone: "success" },
  { id: "e4", actor: "Sana Khan", vendor: "Delta Components", action: "Uploaded GST certificate", time: "2 hr ago", tone: "info" },
  { id: "e5", actor: "System", vendor: "Nimbus Softworks", action: "Failed login (3 attempts)", time: "3 hr ago", tone: "danger" },
  { id: "e6", actor: "Amit Shah", vendor: "Everest Traders", action: "Account suspended", time: "5 hr ago", tone: "danger" },
  { id: "e7", actor: "Priya Nair", vendor: "Zenith Packaging", action: "Contract shared to portal", time: "6 hr ago", tone: "success" },
]

export type Vendor = {
  id: string
  name: string
  code: string
  company: string
  contact: string
  email: string
  phone: string
  type: string
  country: string
  category: string
  portalStatus: PortalStatus
  onboarding: OnboardingStatus
  compliance: ComplianceStatus
  users: number
  accessProfile: string
  lastLogin: string
  createdDate: string
  approvedDate: string | null
  paymentTerms: string
  currency: string
}

export const VENDORS: Vendor[] = [
  { id: "V-1042", name: "Ashok Iron & Steel", code: "VND-1042", company: "Ashok Iron & Steel Pvt Ltd", contact: "Priya Nair", email: "priya@ashokiron.com", phone: "+91 98200 11223", type: "Manufacturing", country: "India", category: "Raw Materials", portalStatus: "active", onboarding: "completed", compliance: "compliant", users: 4, accessProfile: "Vendor Admin", lastLogin: "2026-09-23", createdDate: "2024-02-11", approvedDate: "2024-02-18", paymentTerms: "Net 45", currency: "INR" },
  { id: "V-1043", name: "Meridian Logistics", code: "VND-1043", company: "Meridian Logistics LLP", contact: "Karan Mehta", email: "karan@meridianlog.com", phone: "+91 99870 55411", type: "Logistics", country: "India", category: "Transport", portalStatus: "active", onboarding: "completed", compliance: "expiring", users: 3, accessProfile: "Operations User", lastLogin: "2026-09-22", createdDate: "2023-11-02", approvedDate: "2023-11-10", paymentTerms: "Net 30", currency: "INR" },
  { id: "V-1044", name: "BlueOak Consulting", code: "VND-1044", company: "BlueOak Consulting Inc", contact: "Rahul Verma", email: "rahul@blueoak.io", phone: "+1 415 555 0132", type: "Consulting", country: "USA", category: "Advisory", portalStatus: "pending", onboarding: "under_review", compliance: "pending", users: 1, accessProfile: "Finance User", lastLogin: "2026-09-20", createdDate: "2026-09-01", approvedDate: null, paymentTerms: "Net 60", currency: "USD" },
  { id: "V-1045", name: "Delta Components", code: "VND-1045", company: "Delta Components GmbH", contact: "Sana Khan", email: "sana@deltacomp.de", phone: "+49 30 1234 5678", type: "Manufacturing", country: "Germany", category: "Components", portalStatus: "active", onboarding: "completed", compliance: "compliant", users: 5, accessProfile: "Vendor Admin", lastLogin: "2026-09-23", createdDate: "2022-06-19", approvedDate: "2022-06-28", paymentTerms: "Net 45", currency: "EUR" },
  { id: "V-1046", name: "Nimbus Softworks", code: "VND-1046", company: "Nimbus Softworks Pvt Ltd", contact: "Vikram Rao", email: "vikram@nimbussoft.com", phone: "+91 90080 22110", type: "IT / Software", country: "India", category: "Software", portalStatus: "suspended", onboarding: "completed", compliance: "rejected", users: 2, accessProfile: "Invoice User", lastLogin: "2026-09-10", createdDate: "2023-03-14", approvedDate: "2023-03-20", paymentTerms: "Net 30", currency: "INR" },
  { id: "V-1047", name: "Everest Traders", code: "VND-1047", company: "Everest Traders", contact: "Neha Gupta", email: "neha@everesttraders.com", phone: "+91 98765 43210", type: "Services", country: "India", category: "General", portalStatus: "disabled", onboarding: "incomplete", compliance: "expired", users: 1, accessProfile: "Viewer", lastLogin: "2026-08-02", createdDate: "2021-09-30", approvedDate: "2021-10-05", paymentTerms: "Net 15", currency: "INR" },
  { id: "V-1048", name: "Zenith Packaging", code: "VND-1048", company: "Zenith Packaging Co", contact: "Arjun Desai", email: "arjun@zenithpack.com", phone: "+91 91230 45678", type: "Manufacturing", country: "India", category: "Packaging", portalStatus: "active", onboarding: "completed", compliance: "compliant", users: 3, accessProfile: "Vendor Admin", lastLogin: "2026-09-21", createdDate: "2024-01-08", approvedDate: "2024-01-15", paymentTerms: "Net 45", currency: "INR" },
  { id: "V-1049", name: "Orion Chemicals", code: "VND-1049", company: "Orion Chemicals Ltd", contact: "Farah Ali", email: "farah@orionchem.com", phone: "+91 93456 78901", type: "Manufacturing", country: "India", category: "Chemicals", portalStatus: "invited", onboarding: "not_started", compliance: "pending", users: 0, accessProfile: "—", lastLogin: "—", createdDate: "2026-09-18", approvedDate: null, paymentTerms: "Net 30", currency: "INR" },
  { id: "V-1050", name: "Cascade Freight", code: "VND-1050", company: "Cascade Freight Systems", contact: "Deepak Iyer", email: "deepak@cascadefreight.com", phone: "+91 90011 22334", type: "Logistics", country: "India", category: "Transport", portalStatus: "pending", onboarding: "in_progress", compliance: "pending", users: 1, accessProfile: "Operations User", lastLogin: "2026-09-19", createdDate: "2026-09-12", approvedDate: null, paymentTerms: "Net 30", currency: "INR" },
  { id: "V-1051", name: "Aster Textiles", code: "VND-1051", company: "Aster Textiles Pvt Ltd", contact: "Meera Joshi", email: "meera@astertextiles.com", phone: "+91 98111 44556", type: "Manufacturing", country: "India", category: "Textiles", portalStatus: "active", onboarding: "completed", compliance: "expiring", users: 2, accessProfile: "Finance User", lastLogin: "2026-09-22", createdDate: "2023-07-25", approvedDate: "2023-08-01", paymentTerms: "Net 45", currency: "INR" },
]

export type PortalUser = {
  id: string
  name: string
  email: string
  phone: string
  designation: string
  department: string
  vendor: string
  role: string
  status: "active" | "invited" | "suspended" | "disabled" | "locked"
  language: string
  timezone: string
  mfa: boolean
  lastLogin: string
  failedAttempts: number
  sessions: number
}

export const PORTAL_USERS: PortalUser[] = [
  { id: "U-501", name: "Priya Nair", email: "priya@ashokiron.com", phone: "+91 98200 11223", designation: "Finance Head", department: "Finance", vendor: "Ashok Iron & Steel", role: "Vendor Admin", status: "active", language: "English", timezone: "Asia/Kolkata", mfa: true, lastLogin: "2026-09-23 09:14", failedAttempts: 0, sessions: 2 },
  { id: "U-502", name: "Karan Mehta", email: "karan@meridianlog.com", phone: "+91 99870 55411", designation: "Ops Manager", department: "Operations", vendor: "Meridian Logistics", role: "Operations User", status: "active", language: "English", timezone: "Asia/Kolkata", mfa: false, lastLogin: "2026-09-22 17:41", failedAttempts: 1, sessions: 1 },
  { id: "U-503", name: "Rahul Verma", email: "rahul@blueoak.io", phone: "+1 415 555 0132", designation: "Partner", department: "Advisory", vendor: "BlueOak Consulting", role: "Finance User", status: "invited", language: "English", timezone: "America/Los_Angeles", mfa: false, lastLogin: "—", failedAttempts: 0, sessions: 0 },
  { id: "U-504", name: "Sana Khan", email: "sana@deltacomp.de", phone: "+49 30 1234 5678", designation: "Accounts Lead", department: "Finance", vendor: "Delta Components", role: "Invoice User", status: "active", language: "German", timezone: "Europe/Berlin", mfa: true, lastLogin: "2026-09-23 12:02", failedAttempts: 0, sessions: 3 },
  { id: "U-505", name: "Vikram Rao", email: "vikram@nimbussoft.com", phone: "+91 90080 22110", designation: "Director", department: "Management", vendor: "Nimbus Softworks", role: "Vendor Admin", status: "suspended", language: "English", timezone: "Asia/Kolkata", mfa: true, lastLogin: "2026-09-10 08:33", failedAttempts: 4, sessions: 0 },
  { id: "U-506", name: "Neha Gupta", email: "neha@everesttraders.com", phone: "+91 98765 43210", designation: "Owner", department: "Management", vendor: "Everest Traders", role: "Viewer", status: "locked", language: "Hindi", timezone: "Asia/Kolkata", mfa: false, lastLogin: "2026-08-02 14:20", failedAttempts: 6, sessions: 0 },
]

export type Application = {
  id: string
  company: string
  type: string
  applicant: string
  email: string
  phone: string
  country: string
  submitted: string
  documents: number
  compliance: ComplianceStatus
  reviewer: string | null
  status: "pending" | "under_review" | "needs_info" | "approved" | "rejected" | "expired"
}

export const APPLICATION_STATUS_LABEL: Record<Application["status"], string> = {
  pending: "Pending",
  under_review: "Under review",
  needs_info: "Needs information",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
}

export const APPLICATIONS: Application[] = [
  { id: "APP-2201", company: "Skyline Interiors", type: "Services", applicant: "Ritu Sharma", email: "ritu@skylineint.com", phone: "+91 90000 12345", country: "India", submitted: "2026-09-21", documents: 5, compliance: "pending", reviewer: null, status: "pending" },
  { id: "APP-2202", company: "Quantum Metals", type: "Manufacturing", applicant: "Ved Prakash", email: "ved@quantummetals.com", phone: "+91 90000 22345", country: "India", submitted: "2026-09-20", documents: 7, compliance: "compliant", reviewer: "Amit Shah", status: "under_review" },
  { id: "APP-2203", company: "Nordic Supplies", type: "Logistics", applicant: "Erik Lund", email: "erik@nordicsupplies.se", phone: "+46 70 123 4567", country: "Sweden", submitted: "2026-09-18", documents: 3, compliance: "pending", reviewer: "Amit Shah", status: "needs_info" },
  { id: "APP-2204", company: "Greenfield Agro", type: "Services", applicant: "Latha Menon", email: "latha@greenfieldagro.com", phone: "+91 90000 32345", country: "India", submitted: "2026-09-15", documents: 8, compliance: "compliant", reviewer: "Priya Nair", status: "approved" },
  { id: "APP-2205", company: "Vortex Media", type: "Consulting", applicant: "Sam Okoye", email: "sam@vortexmedia.com", phone: "+234 80 1234 5678", country: "Nigeria", submitted: "2026-09-11", documents: 2, compliance: "rejected", reviewer: "Amit Shah", status: "rejected" },
  { id: "APP-2206", company: "Pioneer Tools", type: "Manufacturing", applicant: "Grace Tan", email: "grace@pioneertools.sg", phone: "+65 8123 4567", country: "Singapore", submitted: "2026-08-30", documents: 6, compliance: "expiring", reviewer: null, status: "expired" },
]

export const ONBOARDING_WORKFLOW = [
  "Registration",
  "Email Verification",
  "Business Information",
  "Tax Information",
  "Bank Information",
  "Document Submission",
  "Compliance Review",
  "Finance / Admin Approval",
  "Vendor Mapping",
  "Portal Activation",
]

export type PermissionLevel =
  | "no_access"
  | "view"
  | "download"
  | "create"
  | "submit"
  | "edit"
  | "upload"
  | "comment"
  | "approve"

export const PERMISSION_LEVELS: { value: PermissionLevel; label: string }[] = [
  { value: "no_access", label: "No Access" },
  { value: "view", label: "View" },
  { value: "download", label: "Download" },
  { value: "create", label: "Create" },
  { value: "submit", label: "Submit" },
  { value: "edit", label: "Edit" },
  { value: "upload", label: "Upload" },
  { value: "comment", label: "Comment" },
  { value: "approve", label: "Approve" },
]

export const PORTAL_RESOURCES = [
  "Dashboard",
  "Company Profile",
  "Purchase Orders",
  "Invoices",
  "Invoice Submission",
  "Invoice Status",
  "Payments",
  "Payment History",
  "Payment Advice",
  "Statements",
  "Contracts",
  "RFQs",
  "Quotations",
  "Documents",
  "Compliance",
  "Tax Documents",
  "Support Tickets",
  "Messages",
  "Notifications",
  "Reports",
]

export const FINANCE_RESOURCES = [
  "Invoices",
  "Invoice Submission",
  "Invoice Status",
  "Payment Status",
  "Payment History",
  "Payment Advice",
  "Statements",
  "Credit Notes",
  "Debit Notes",
  "Tax Documents",
  "Purchase Orders",
]

export type AccessProfile = {
  id: string
  name: string
  description: string
  users: number
  resources: number
  builtIn: boolean
}

export const ACCESS_PROFILES: AccessProfile[] = [
  { id: "AP-1", name: "Vendor Admin", description: "Full portal access including user management", users: 148, resources: 20, builtIn: true },
  { id: "AP-2", name: "Finance User", description: "Invoices, payments and statements", users: 212, resources: 11, builtIn: true },
  { id: "AP-3", name: "Invoice User", description: "Submit and track invoices only", users: 96, resources: 5, builtIn: true },
  { id: "AP-4", name: "Operations User", description: "Purchase orders, RFQs and documents", users: 74, resources: 8, builtIn: true },
  { id: "AP-5", name: "Viewer", description: "Read-only access to shared records", users: 41, resources: 6, builtIn: true },
  { id: "AP-6", name: "Compliance-Only", description: "Custom profile for document verification", users: 8, resources: 3, builtIn: false },
]

export type BankDetail = {
  id: string
  vendor: string
  holder: string
  bank: string
  account: string
  ifsc: string
  iban: string | null
  currency: string
  country: string
  status: VerificationStatus
  updated: string
}

export const BANK_DETAILS: BankDetail[] = [
  { id: "B-1", vendor: "Ashok Iron & Steel", holder: "Ashok Iron & Steel Pvt Ltd", bank: "HDFC Bank", account: "•••• •••• 4412", ifsc: "HDFC0001234", iban: null, currency: "INR", country: "India", status: "verified", updated: "2026-06-11" },
  { id: "B-2", vendor: "Delta Components", holder: "Delta Components GmbH", bank: "Deutsche Bank", account: "•••• •••• 7781", ifsc: "DEUTDEFF", iban: "DE89 3704 •••• •••• 00", currency: "EUR", country: "Germany", status: "verified", updated: "2026-05-02" },
  { id: "B-3", vendor: "Meridian Logistics", holder: "Meridian Logistics LLP", bank: "ICICI Bank", account: "•••• •••• 9032", ifsc: "ICIC0000456", iban: null, currency: "INR", country: "India", status: "change_requested", updated: "2026-09-23" },
  { id: "B-4", vendor: "Cascade Freight", holder: "Cascade Freight Systems", bank: "Axis Bank", account: "•••• •••• 1120", ifsc: "UTIB0000789", iban: null, currency: "INR", country: "India", status: "pending", updated: "2026-09-19" },
  { id: "B-5", vendor: "Nimbus Softworks", holder: "Nimbus Softworks Pvt Ltd", bank: "SBI", account: "•••• •••• 6654", ifsc: "SBIN0007788", iban: null, currency: "INR", country: "India", status: "rejected", updated: "2026-09-08" },
]

export type BankChangeRequest = {
  id: string
  vendor: string
  requestedBy: string
  oldSummary: string
  newSummary: string
  requested: string
  verification: VerificationStatus
  reviewer: string | null
  status: "pending" | "approved" | "rejected"
}

export const BANK_CHANGE_REQUESTS: BankChangeRequest[] = [
  { id: "BCR-88", vendor: "Meridian Logistics", requestedBy: "Karan Mehta", oldSummary: "ICICI •••9032 / ICIC0000456", newSummary: "ICICI •••4471 / ICIC0000456", requested: "2026-09-23", verification: "pending", reviewer: null, status: "pending" },
  { id: "BCR-87", vendor: "Aster Textiles", requestedBy: "Meera Joshi", oldSummary: "HDFC •••2201 / HDFC0002211", newSummary: "Kotak •••7788 / KKBK0004455", requested: "2026-09-20", verification: "pending", reviewer: "Amit Shah", status: "pending" },
  { id: "BCR-86", vendor: "Zenith Packaging", requestedBy: "Arjun Desai", oldSummary: "Axis •••3311 / UTIB0001122", newSummary: "Axis •••9900 / UTIB0001122", requested: "2026-09-14", verification: "verified", reviewer: "Priya Nair", status: "approved" },
]

export type ComplianceDoc = {
  id: string
  vendor: string
  document: string
  type: string
  number: string
  issued: string
  expiry: string
  status: ComplianceStatus
}

export const COMPLIANCE_DOCS: ComplianceDoc[] = [
  { id: "C-1", vendor: "Ashok Iron & Steel", document: "GST Registration", type: "GST/VAT", number: "27AABCA1234F1Z5", issued: "2021-04-01", expiry: "2027-03-31", status: "compliant" },
  { id: "C-2", vendor: "Meridian Logistics", document: "PAN Card", type: "PAN/Tax ID", number: "AAECM5678L", issued: "2019-01-15", expiry: "—", status: "compliant" },
  { id: "C-3", vendor: "Aster Textiles", document: "MSME Certificate", type: "MSME", number: "UDYAM-MH-12-0009988", issued: "2022-08-10", expiry: "2026-10-31", status: "expiring" },
  { id: "C-4", vendor: "Everest Traders", document: "Insurance Policy", type: "Insurance", number: "POL-448821", issued: "2024-01-01", expiry: "2025-12-31", status: "expired" },
  { id: "C-5", vendor: "BlueOak Consulting", document: "W-9 Form", type: "International Tax", number: "W9-2026-014", issued: "2026-01-05", expiry: "—", status: "pending" },
  { id: "C-6", vendor: "Nimbus Softworks", document: "ISO 27001", type: "Certification", number: "ISO-27001-2023", issued: "2023-06-01", expiry: "2026-05-31", status: "rejected" },
]

export type VendorDocument = {
  id: string
  vendor: string
  name: string
  category: string
  version: string
  uploaded: string
  status: VerificationStatus
}

export const VENDOR_DOCUMENTS: VendorDocument[] = [
  { id: "D-1", vendor: "Ashok Iron & Steel", name: "Certificate of Incorporation.pdf", category: "Registration Documents", version: "v1", uploaded: "2024-02-12", status: "verified" },
  { id: "D-2", vendor: "Delta Components", name: "GST Certificate.pdf", category: "Tax Documents", version: "v2", uploaded: "2026-05-02", status: "verified" },
  { id: "D-3", vendor: "Cascade Freight", name: "Cancelled Cheque.jpg", category: "Bank Proof", version: "v1", uploaded: "2026-09-19", status: "pending" },
  { id: "D-4", vendor: "BlueOak Consulting", name: "Master Services Agreement.pdf", category: "Contracts", version: "v1", uploaded: "2026-09-05", status: "pending" },
  { id: "D-5", vendor: "Nimbus Softworks", name: "NDA-signed.pdf", category: "NDA", version: "v1", uploaded: "2026-03-14", status: "rejected" },
  { id: "D-6", vendor: "Aster Textiles", name: "ISO-9001.pdf", category: "Certifications", version: "v3", uploaded: "2026-01-20", status: "change_requested" },
]

export type PortalInvoice = {
  id: string
  vendor: string
  po: string
  date: string
  amount: number
  currency: string
  submitted: string
  status: "draft" | "submitted" | "under_review" | "approved" | "rejected" | "scheduled" | "paid"
}

export const INVOICE_STATUS_LABEL: Record<PortalInvoice["status"], string> = {
  draft: "Draft",
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  scheduled: "Payment scheduled",
  paid: "Paid",
}

export const PORTAL_INVOICES: PortalInvoice[] = [
  { id: "INV-20456", vendor: "Ashok Iron & Steel", po: "PO-8891", date: "2026-09-20", amount: 482300, currency: "INR", submitted: "2026-09-21", status: "under_review" },
  { id: "INV-20455", vendor: "Delta Components", po: "PO-8874", date: "2026-09-18", amount: 12800, currency: "EUR", submitted: "2026-09-19", status: "approved" },
  { id: "INV-20454", vendor: "Meridian Logistics", po: "PO-8860", date: "2026-09-15", amount: 96500, currency: "INR", submitted: "2026-09-16", status: "scheduled" },
  { id: "INV-20453", vendor: "Aster Textiles", po: "PO-8842", date: "2026-09-10", amount: 154200, currency: "INR", submitted: "2026-09-11", status: "paid" },
  { id: "INV-20452", vendor: "Nimbus Softworks", po: "PO-8830", date: "2026-09-05", amount: 74000, currency: "INR", submitted: "2026-09-06", status: "rejected" },
  { id: "INV-20451", vendor: "Zenith Packaging", po: "PO-8815", date: "2026-09-02", amount: 61200, currency: "INR", submitted: "2026-09-03", status: "submitted" },
]

export type PortalPO = {
  id: string
  vendor: string
  amount: number
  currency: string
  issued: string
  status: string
  visible: boolean
  acknowledged: boolean
  ackDate: string | null
}

export const PORTAL_POS: PortalPO[] = [
  { id: "PO-8891", vendor: "Ashok Iron & Steel", amount: 482300, currency: "INR", issued: "2026-09-12", status: "Open", visible: true, acknowledged: true, ackDate: "2026-09-13" },
  { id: "PO-8874", vendor: "Delta Components", amount: 12800, currency: "EUR", issued: "2026-09-08", status: "Open", visible: true, acknowledged: false, ackDate: null },
  { id: "PO-8860", vendor: "Meridian Logistics", amount: 96500, currency: "INR", issued: "2026-09-04", status: "Closed", visible: true, acknowledged: true, ackDate: "2026-09-05" },
  { id: "PO-8842", vendor: "Aster Textiles", amount: 154200, currency: "INR", issued: "2026-08-28", status: "Closed", visible: false, acknowledged: false, ackDate: null },
  { id: "PO-8830", vendor: "Nimbus Softworks", amount: 74000, currency: "INR", issued: "2026-08-22", status: "Open", visible: false, acknowledged: false, ackDate: null },
]

export type PortalPayment = {
  id: string
  vendor: string
  invoice: string
  amount: number
  currency: string
  date: string
  method: string
  status: string
  advice: boolean
  visible: boolean
}

export const PORTAL_PAYMENTS: PortalPayment[] = [
  { id: "PAY-5521", vendor: "Aster Textiles", invoice: "INV-20453", amount: 154200, currency: "INR", date: "2026-09-14", method: "NEFT", status: "Completed", advice: true, visible: true },
  { id: "PAY-5520", vendor: "Meridian Logistics", invoice: "INV-20454", amount: 96500, currency: "INR", date: "2026-09-25", method: "RTGS", status: "Scheduled", advice: false, visible: true },
  { id: "PAY-5519", vendor: "Delta Components", invoice: "INV-20455", amount: 12800, currency: "EUR", date: "2026-09-22", method: "Wire", status: "Processing", advice: true, visible: false },
  { id: "PAY-5518", vendor: "Ashok Iron & Steel", invoice: "INV-20449", amount: 220000, currency: "INR", date: "2026-09-01", method: "NEFT", status: "Completed", advice: true, visible: true },
]

export type PortalContract = {
  id: string
  vendor: string
  title: string
  effective: string
  expiry: string
  status: string
  visible: boolean
  shared: string | null
}

export const PORTAL_CONTRACTS: PortalContract[] = [
  { id: "CON-330", vendor: "Ashok Iron & Steel", title: "Annual Supply Agreement 2026", effective: "2026-01-01", expiry: "2026-12-31", status: "Active", visible: true, shared: "2026-01-04" },
  { id: "CON-331", vendor: "Delta Components", title: "Master Services Agreement", effective: "2025-04-01", expiry: "2027-03-31", status: "Active", visible: true, shared: "2025-04-06" },
  { id: "CON-332", vendor: "BlueOak Consulting", title: "Consulting SOW #14", effective: "2026-09-01", expiry: "2027-02-28", status: "Pending signature", visible: false, shared: null },
  { id: "CON-333", vendor: "Meridian Logistics", title: "Transport Rate Card 2026", effective: "2026-01-01", expiry: "2026-12-31", status: "Active", visible: true, shared: "2026-01-10" },
]

export type Invitation = {
  id: string
  vendor: string
  recipient: string
  email: string
  role: string
  sent: string
  expires: string
  accepted: string | null
  status: "sent" | "accepted" | "expired" | "revoked"
  sentBy: string
}

export const INVITATIONS: Invitation[] = [
  { id: "INV-701", vendor: "Orion Chemicals", recipient: "Farah Ali", email: "farah@orionchem.com", role: "Vendor Admin", sent: "2026-09-18", expires: "2026-09-25", accepted: null, status: "sent", sentBy: "Priya Nair" },
  { id: "INV-702", vendor: "Cascade Freight", recipient: "Deepak Iyer", email: "deepak@cascadefreight.com", role: "Operations User", sent: "2026-09-12", expires: "2026-09-19", accepted: "2026-09-14", status: "accepted", sentBy: "Amit Shah" },
  { id: "INV-703", vendor: "Skyline Interiors", recipient: "Ritu Sharma", email: "ritu@skylineint.com", role: "Finance User", sent: "2026-08-28", expires: "2026-09-04", accepted: null, status: "expired", sentBy: "Priya Nair" },
  { id: "INV-704", vendor: "Vortex Media", recipient: "Sam Okoye", email: "sam@vortexmedia.com", role: "Viewer", sent: "2026-09-01", expires: "2026-09-08", accepted: null, status: "revoked", sentBy: "Amit Shah" },
]

export type AccessRequest = {
  id: string
  vendor: string
  user: string
  type: string
  requested: string
  status: "new" | "under_review" | "approved" | "rejected" | "completed"
}

export const ACCESS_REQUEST_STATUS_LABEL: Record<AccessRequest["status"], string> = {
  new: "New",
  under_review: "Under review",
  approved: "Approved",
  rejected: "Rejected",
  completed: "Completed",
}

export const ACCESS_REQUESTS: AccessRequest[] = [
  { id: "AR-311", vendor: "Ashok Iron & Steel", user: "Priya Nair", type: "Additional Access", requested: "2026-09-22", status: "new" },
  { id: "AR-312", vendor: "Delta Components", user: "Sana Khan", type: "Payment Access", requested: "2026-09-21", status: "under_review" },
  { id: "AR-313", vendor: "Meridian Logistics", user: "Karan Mehta", type: "Bank Change", requested: "2026-09-20", status: "under_review" },
  { id: "AR-314", vendor: "Aster Textiles", user: "Meera Joshi", type: "New User", requested: "2026-09-18", status: "approved" },
  { id: "AR-315", vendor: "Zenith Packaging", user: "Arjun Desai", type: "Document Access", requested: "2026-09-15", status: "completed" },
  { id: "AR-316", vendor: "Nimbus Softworks", user: "Vikram Rao", type: "Profile Change", requested: "2026-09-10", status: "rejected" },
]

export type PortalSession = {
  id: string
  vendor: string
  user: string
  device: string
  browser: string
  ip: string
  login: string
  lastActivity: string
  status: "active" | "idle" | "expired"
}

export const PORTAL_SESSIONS: PortalSession[] = [
  { id: "S-9001", vendor: "Ashok Iron & Steel", user: "Priya Nair", device: "MacBook Pro", browser: "Chrome 128", ip: "103.22.14.5", login: "2026-09-23 09:14", lastActivity: "2 min ago", status: "active" },
  { id: "S-9002", vendor: "Delta Components", user: "Sana Khan", device: "Windows 11", browser: "Edge 128", ip: "88.12.44.7", login: "2026-09-23 12:02", lastActivity: "8 min ago", status: "active" },
  { id: "S-9003", vendor: "Meridian Logistics", user: "Karan Mehta", device: "iPhone 15", browser: "Safari Mobile", ip: "49.36.22.1", login: "2026-09-22 17:41", lastActivity: "5 hr ago", status: "idle" },
  { id: "S-9004", vendor: "Aster Textiles", user: "Meera Joshi", device: "Android", browser: "Chrome Mobile", ip: "157.44.9.2", login: "2026-09-22 08:10", lastActivity: "1 day ago", status: "expired" },
]

export type NotificationTemplate = {
  id: string
  name: string
  channels: string[]
  updated: string
  enabled: boolean
}

export const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  { id: "T-1", name: "Invitation", channels: ["Email", "Portal"], updated: "2026-08-14", enabled: true },
  { id: "T-2", name: "Approval", channels: ["Email", "Portal"], updated: "2026-08-14", enabled: true },
  { id: "T-3", name: "Rejection", channels: ["Email"], updated: "2026-07-30", enabled: true },
  { id: "T-4", name: "Information Requested", channels: ["Email", "Portal"], updated: "2026-08-01", enabled: true },
  { id: "T-5", name: "Document Expiring", channels: ["Email", "Portal", "SMS"], updated: "2026-09-02", enabled: true },
  { id: "T-6", name: "Invoice Submitted", channels: ["Portal"], updated: "2026-08-20", enabled: true },
  { id: "T-7", name: "Invoice Approved", channels: ["Email", "Portal"], updated: "2026-08-20", enabled: true },
  { id: "T-8", name: "Invoice Rejected", channels: ["Email", "Portal"], updated: "2026-08-20", enabled: false },
  { id: "T-9", name: "Payment Scheduled", channels: ["Email", "Portal"], updated: "2026-09-10", enabled: true },
  { id: "T-10", name: "Payment Completed", channels: ["Email", "Portal", "WhatsApp"], updated: "2026-09-10", enabled: true },
  { id: "T-11", name: "PO Issued", channels: ["Email", "Portal"], updated: "2026-08-05", enabled: true },
  { id: "T-12", name: "Contract Shared", channels: ["Email", "Portal"], updated: "2026-08-05", enabled: true },
  { id: "T-13", name: "Account Suspended", channels: ["Email"], updated: "2026-06-18", enabled: true },
]

export type Announcement = {
  id: string
  title: string
  audience: string
  priority: "low" | "normal" | "high"
  start: string
  end: string
  status: "scheduled" | "published" | "expired" | "draft"
}

export const ANNOUNCEMENTS: Announcement[] = [
  { id: "AN-1", title: "Portal maintenance on Oct 5, 2026", audience: "All Vendors", priority: "high", start: "2026-09-28", end: "2026-10-05", status: "published" },
  { id: "AN-2", title: "New invoice submission guidelines", audience: "Manufacturing", priority: "normal", start: "2026-09-20", end: "2026-10-20", status: "published" },
  { id: "AN-3", title: "Year-end statement availability", audience: "Selected Vendors", priority: "normal", start: "2026-12-01", end: "2026-12-31", status: "scheduled" },
  { id: "AN-4", title: "Updated compliance policy (draft)", audience: "All Vendors", priority: "low", start: "—", end: "—", status: "draft" },
]

export type AuditEntry = {
  id: string
  timestamp: string
  actor: string
  vendor: string
  user: string
  action: string
  resource: string
  oldValue: string
  newValue: string
  ip: string
  result: "success" | "failure"
}

export const AUDIT_ENTRIES: AuditEntry[] = [
  { id: "L-1", timestamp: "2026-09-23 12:04", actor: "Sana Khan", vendor: "Delta Components", user: "sana@deltacomp.de", action: "Login", resource: "Session", oldValue: "—", newValue: "Session S-9002", ip: "88.12.44.7", result: "success" },
  { id: "L-2", timestamp: "2026-09-23 11:41", actor: "Priya Nair", vendor: "Ashok Iron & Steel", user: "priya@ashokiron.com", action: "Invoice Upload", resource: "INV-20456", oldValue: "—", newValue: "482,300 INR", ip: "103.22.14.5", result: "success" },
  { id: "L-3", timestamp: "2026-09-23 10:22", actor: "Karan Mehta", vendor: "Meridian Logistics", user: "karan@meridianlog.com", action: "Bank Detail Change", resource: "Bank B-3", oldValue: "•••9032", newValue: "•••4471", ip: "49.36.22.1", result: "success" },
  { id: "L-4", timestamp: "2026-09-23 09:03", actor: "Vikram Rao", vendor: "Nimbus Softworks", user: "vikram@nimbussoft.com", action: "Failed Login", resource: "Session", oldValue: "—", newValue: "Attempt 4", ip: "182.70.11.9", result: "failure" },
  { id: "L-5", timestamp: "2026-09-22 18:15", actor: "Amit Shah", vendor: "Everest Traders", user: "admin", action: "Permission Change", resource: "Access Profile", oldValue: "Finance User", newValue: "Viewer", ip: "10.0.0.4", result: "success" },
  { id: "L-6", timestamp: "2026-09-22 16:48", actor: "Sana Khan", vendor: "Delta Components", user: "sana@deltacomp.de", action: "Payment Advice Download", resource: "PAY-5519", oldValue: "—", newValue: "Downloaded", ip: "88.12.44.7", result: "success" },
]

/** Number/currency formatting helpers shared across the console. */
export function formatMoney(amount: number, currency = "INR") {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount)
}

export function formatNumber(n: number) {
  return new Intl.NumberFormat("en-IN").format(n)
}

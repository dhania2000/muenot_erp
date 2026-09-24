/**
 * SPEC 119 — Vendor Portal Administration Console
 * ---------------------------------------------------------------------------
 * FRONTEND-ONLY mock data + shared types for the Finance › Vendor Portal admin
 * control center. Every shape here is designed to be swapped for a real API
 * response later (Codex wires the backend). Nothing here talks to a database;
 * these are static fixtures so the UI can render tables, drawers, charts and
 * empty/error states end to end.
 */

export type PortalStatus = "active" | "pending" | "invited" | "suspended" | "rejected" | "disabled"
export type OnboardingStatus = "not-started" | "in-progress" | "under-review" | "complete" | "incomplete"
export type ComplianceStatus = "verified" | "pending" | "expiring" | "expired" | "rejected"

export const PORTAL_STATUS_LABEL: Record<PortalStatus, string> = {
  active: "Active",
  pending: "Pending",
  invited: "Invited",
  suspended: "Suspended",
  rejected: "Rejected",
  disabled: "Disabled",
}

export const ONBOARDING_STATUS_LABEL: Record<OnboardingStatus, string> = {
  "not-started": "Not started",
  "in-progress": "In progress",
  "under-review": "Under review",
  complete: "Complete",
  incomplete: "Incomplete",
}

export const COMPLIANCE_STATUS_LABEL: Record<ComplianceStatus, string> = {
  verified: "Verified",
  pending: "Pending",
  expiring: "Expiring",
  expired: "Expired",
  rejected: "Rejected",
}

export type Vendor = {
  id: string
  name: string
  code: string
  company: string
  contact: string
  contactEmail: string
  type: string
  portalStatus: PortalStatus
  onboarding: OnboardingStatus
  compliance: ComplianceStatus
  users: number
  accessProfile: string
  lastLogin: string | null
  category: string
  paymentTerms: string
  currency: string
  createdDate: string
  approvedDate: string | null
  country: string
}

export const VENDORS: Vendor[] = [
  {
    id: "V-1001",
    name: "Acme Components Pvt Ltd",
    code: "VN-0001",
    company: "Acme Components Pvt Ltd",
    contact: "Ravi Menon",
    contactEmail: "ravi@acmecomp.in",
    type: "Manufacturer",
    portalStatus: "active",
    onboarding: "complete",
    compliance: "verified",
    users: 3,
    accessProfile: "Vendor Admin",
    lastLogin: "2026-09-22T09:14:00Z",
    category: "Raw Materials",
    paymentTerms: "Net 45",
    currency: "INR",
    createdDate: "2025-02-11",
    approvedDate: "2025-02-18",
    country: "India",
  },
  {
    id: "V-1002",
    name: "Northwind Logistics",
    code: "VN-0002",
    company: "Northwind Logistics LLC",
    contact: "Sara Klein",
    contactEmail: "sara@northwind.com",
    type: "Service Provider",
    portalStatus: "active",
    onboarding: "complete",
    compliance: "expiring",
    users: 2,
    accessProfile: "Finance User",
    lastLogin: "2026-09-23T15:40:00Z",
    category: "Logistics",
    paymentTerms: "Net 30",
    currency: "USD",
    createdDate: "2025-03-02",
    approvedDate: "2025-03-09",
    country: "United States",
  },
  {
    id: "V-1003",
    name: "Blue Ridge Textiles",
    code: "VN-0003",
    company: "Blue Ridge Textiles Inc",
    contact: "Marcus Hale",
    contactEmail: "m.hale@blueridge.com",
    type: "Manufacturer",
    portalStatus: "pending",
    onboarding: "under-review",
    compliance: "pending",
    users: 1,
    accessProfile: "Invoice User",
    lastLogin: null,
    category: "Textiles",
    paymentTerms: "Net 60",
    currency: "USD",
    createdDate: "2026-08-30",
    approvedDate: null,
    country: "United States",
  },
  {
    id: "V-1004",
    name: "Zenith Software Labs",
    code: "VN-0004",
    company: "Zenith Software Labs",
    contact: "Priya Nair",
    contactEmail: "priya@zenithlabs.io",
    type: "Consultant",
    portalStatus: "invited",
    onboarding: "in-progress",
    compliance: "pending",
    users: 0,
    accessProfile: "—",
    lastLogin: null,
    category: "IT Services",
    paymentTerms: "Net 30",
    currency: "INR",
    createdDate: "2026-09-10",
    approvedDate: null,
    country: "India",
  },
  {
    id: "V-1005",
    name: "Harbor Freight Supplies",
    code: "VN-0005",
    company: "Harbor Freight Supplies Co",
    contact: "Elena Ross",
    contactEmail: "elena@harborfreight.com",
    type: "Distributor",
    portalStatus: "suspended",
    onboarding: "complete",
    compliance: "rejected",
    users: 2,
    accessProfile: "Viewer",
    lastLogin: "2026-07-01T11:00:00Z",
    category: "Hardware",
    paymentTerms: "Net 45",
    currency: "USD",
    createdDate: "2024-11-19",
    approvedDate: "2024-11-28",
    country: "United States",
  },
  {
    id: "V-1006",
    name: "Sahara Packaging",
    code: "VN-0006",
    company: "Sahara Packaging FZE",
    contact: "Omar Aziz",
    contactEmail: "omar@saharapack.ae",
    type: "Manufacturer",
    portalStatus: "rejected",
    onboarding: "incomplete",
    compliance: "rejected",
    users: 0,
    accessProfile: "—",
    lastLogin: null,
    category: "Packaging",
    paymentTerms: "Net 30",
    currency: "AED",
    createdDate: "2026-06-04",
    approvedDate: null,
    country: "UAE",
  },
  {
    id: "V-1007",
    name: "Greenfield Agro",
    code: "VN-0007",
    company: "Greenfield Agro Pvt Ltd",
    contact: "Anita Desai",
    contactEmail: "anita@greenfield.in",
    type: "Supplier",
    portalStatus: "active",
    onboarding: "complete",
    compliance: "verified",
    users: 4,
    accessProfile: "Operations User",
    lastLogin: "2026-09-24T06:22:00Z",
    category: "Agriculture",
    paymentTerms: "Net 15",
    currency: "INR",
    createdDate: "2025-01-08",
    approvedDate: "2025-01-15",
    country: "India",
  },
  {
    id: "V-1008",
    name: "Meridian Electricals",
    code: "VN-0008",
    company: "Meridian Electricals Ltd",
    contact: "John Baptiste",
    contactEmail: "john@meridian.co.uk",
    type: "Manufacturer",
    portalStatus: "disabled",
    onboarding: "complete",
    compliance: "expired",
    users: 1,
    accessProfile: "Viewer",
    lastLogin: "2026-04-14T08:30:00Z",
    category: "Electricals",
    paymentTerms: "Net 45",
    currency: "GBP",
    createdDate: "2024-09-27",
    approvedDate: "2024-10-05",
    country: "United Kingdom",
  },
]

export type KpiDatum = {
  key: string
  label: string
  value: number
  delta?: number
  tone?: "default" | "warning" | "danger" | "success"
}

export const OVERVIEW_KPIS: KpiDatum[] = [
  { key: "total", label: "Total Portal Vendors", value: 248, delta: 4.2, tone: "default" },
  { key: "active", label: "Active Vendors", value: 176, delta: 2.1, tone: "success" },
  { key: "pending-onboarding", label: "Pending Onboarding", value: 21, delta: -1.4, tone: "warning" },
  { key: "pending-approval", label: "Pending Approval", value: 14, delta: 3.0, tone: "warning" },
  { key: "invited", label: "Invited Vendors", value: 32, delta: 6.7, tone: "default" },
  { key: "active-users", label: "Active Vendor Users", value: 512, delta: 1.9, tone: "success" },
  { key: "suspended", label: "Suspended Accounts", value: 8, tone: "danger" },
  { key: "rejected", label: "Rejected Applications", value: 11, tone: "danger" },
  { key: "docs-pending", label: "Documents Pending Verification", value: 37, tone: "warning" },
  { key: "invoice-requests", label: "Payment / Invoice Requests", value: 63, tone: "default" },
  { key: "access-requests", label: "Access Requests", value: 9, tone: "warning" },
  { key: "logins-30d", label: "Last 30 Days Logins", value: 1284, delta: 8.5, tone: "success" },
]

export const ONBOARDING_FUNNEL = [
  { stage: "Registered", value: 320 },
  { stage: "Email Verified", value: 291 },
  { stage: "Business Info", value: 264 },
  { stage: "Tax Info", value: 238 },
  { stage: "Bank Info", value: 210 },
  { stage: "Documents", value: 188 },
  { stage: "Compliance", value: 171 },
  { stage: "Approved", value: 156 },
  { stage: "Activated", value: 148 },
]

export const ACTIVITY_TREND = [
  { month: "Apr", logins: 820, submissions: 210 },
  { month: "May", logins: 910, submissions: 260 },
  { month: "Jun", logins: 1040, submissions: 305 },
  { month: "Jul", logins: 980, submissions: 288 },
  { month: "Aug", logins: 1160, submissions: 344 },
  { month: "Sep", logins: 1284, submissions: 398 },
]

export const ADOPTION = [
  { name: "Activated", value: 148 },
  { name: "Onboarding", value: 42 },
  { name: "Invited only", value: 32 },
  { name: "Dormant", value: 26 },
]

export const COMPLIANCE_BREAKDOWN = [
  { name: "Verified", value: 176 },
  { name: "Pending", value: 37 },
  { name: "Expiring", value: 19 },
  { name: "Expired", value: 9 },
  { name: "Rejected", value: 7 },
]

export type PortalEvent = {
  id: string
  time: string
  vendor: string
  actor: string
  action: string
  tone?: "default" | "warning" | "danger" | "success"
}

export const RECENT_EVENTS: PortalEvent[] = [
  { id: "e1", time: "2026-09-24T06:22:00Z", vendor: "Greenfield Agro", actor: "anita@greenfield.in", action: "Submitted invoice INV-4821", tone: "default" },
  { id: "e2", time: "2026-09-24T05:10:00Z", vendor: "Northwind Logistics", actor: "sara@northwind.com", action: "Requested bank detail change", tone: "warning" },
  { id: "e3", time: "2026-09-23T18:44:00Z", vendor: "Blue Ridge Textiles", actor: "System", action: "New self-registration received", tone: "default" },
  { id: "e4", time: "2026-09-23T15:40:00Z", vendor: "Harbor Freight Supplies", actor: "admin@muenot", action: "Account suspended", tone: "danger" },
  { id: "e5", time: "2026-09-23T11:02:00Z", vendor: "Acme Components", actor: "ravi@acmecomp.in", action: "Uploaded GST certificate", tone: "success" },
  { id: "e6", time: "2026-09-22T09:14:00Z", vendor: "Acme Components", actor: "ravi@acmecomp.in", action: "Signed in from Mumbai, IN", tone: "default" },
]

export type PortalUser = {
  id: string
  name: string
  email: string
  phone: string
  designation: string
  department: string
  vendorId: string
  role: string
  status: "active" | "invited" | "suspended" | "disabled" | "locked"
  language: string
  timezone: string
  mfa: boolean
  lastLogin: string | null
  failedAttempts: number
  activeSessions: number
}

export const PORTAL_USERS: PortalUser[] = [
  { id: "U-01", name: "Ravi Menon", email: "ravi@acmecomp.in", phone: "+91 98200 11223", designation: "AP Manager", department: "Finance", vendorId: "V-1001", role: "Vendor Admin", status: "active", language: "English", timezone: "Asia/Kolkata", mfa: true, lastLogin: "2026-09-22T09:14:00Z", failedAttempts: 0, activeSessions: 2 },
  { id: "U-02", name: "Deepa Rao", email: "deepa@acmecomp.in", phone: "+91 99000 44556", designation: "Accountant", department: "Finance", vendorId: "V-1001", role: "Invoice User", status: "active", language: "English", timezone: "Asia/Kolkata", mfa: false, lastLogin: "2026-09-20T13:20:00Z", failedAttempts: 1, activeSessions: 1 },
  { id: "U-03", name: "Sara Klein", email: "sara@northwind.com", phone: "+1 415 220 1180", designation: "Controller", department: "Finance", vendorId: "V-1002", role: "Finance User", status: "active", language: "English", timezone: "America/Los_Angeles", mfa: true, lastLogin: "2026-09-23T15:40:00Z", failedAttempts: 0, activeSessions: 1 },
  { id: "U-04", name: "Marcus Hale", email: "m.hale@blueridge.com", phone: "+1 828 445 8890", designation: "Owner", department: "Management", vendorId: "V-1003", role: "Vendor Admin", status: "invited", language: "English", timezone: "America/New_York", mfa: false, lastLogin: null, failedAttempts: 0, activeSessions: 0 },
  { id: "U-05", name: "Elena Ross", email: "elena@harborfreight.com", phone: "+1 619 771 3320", designation: "Billing Lead", department: "Finance", vendorId: "V-1005", role: "Viewer", status: "suspended", language: "English", timezone: "America/Los_Angeles", mfa: true, lastLogin: "2026-07-01T11:00:00Z", failedAttempts: 4, activeSessions: 0 },
  { id: "U-06", name: "John Baptiste", email: "john@meridian.co.uk", phone: "+44 20 7946 0991", designation: "Director", department: "Management", vendorId: "V-1008", role: "Viewer", status: "locked", language: "English", timezone: "Europe/London", mfa: false, lastLogin: "2026-04-14T08:30:00Z", failedAttempts: 6, activeSessions: 0 },
]

export type ApplicationStatus = "pending" | "under-review" | "needs-info" | "approved" | "rejected" | "expired"

export const APPLICATION_STATUS_LABEL: Record<ApplicationStatus, string> = {
  pending: "Pending",
  "under-review": "Under Review",
  "needs-info": "Needs Information",
  approved: "Approved",
  rejected: "Rejected",
  expired: "Expired",
}

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
  status: ApplicationStatus
}

export const APPLICATIONS: Application[] = [
  { id: "APP-2041", company: "Blue Ridge Textiles Inc", type: "Manufacturer", applicant: "Marcus Hale", email: "m.hale@blueridge.com", phone: "+1 828 445 8890", country: "United States", submitted: "2026-09-23", documents: 4, compliance: "pending", reviewer: "K. Iyer", status: "under-review" },
  { id: "APP-2042", company: "Sahara Packaging FZE", type: "Manufacturer", applicant: "Omar Aziz", email: "omar@saharapack.ae", phone: "+971 4 555 2211", country: "UAE", submitted: "2026-09-21", documents: 2, compliance: "rejected", reviewer: "K. Iyer", status: "needs-info" },
  { id: "APP-2043", company: "Vertex Metals", type: "Distributor", applicant: "Liam Chen", email: "liam@vertexmetals.com", phone: "+65 6123 9087", country: "Singapore", submitted: "2026-09-24", documents: 5, compliance: "pending", reviewer: null, status: "pending" },
  { id: "APP-2044", company: "Orbit Chemicals", type: "Supplier", applicant: "Fatima Sheikh", email: "fatima@orbitchem.in", phone: "+91 98765 44300", country: "India", submitted: "2026-09-18", documents: 6, compliance: "verified", reviewer: "A. Bose", status: "approved" },
  { id: "APP-2045", company: "Falcon Tools", type: "Distributor", applicant: "Greg Park", email: "greg@falcontools.com", phone: "+1 312 664 2210", country: "United States", submitted: "2026-08-30", documents: 1, compliance: "rejected", reviewer: "A. Bose", status: "rejected" },
  { id: "APP-2046", company: "Nova Print House", type: "Service Provider", applicant: "Ivy Larsen", email: "ivy@novaprint.dk", phone: "+45 32 55 1122", country: "Denmark", submitted: "2026-07-11", documents: 3, compliance: "expired", reviewer: null, status: "expired" },
]

export const ONBOARDING_STAGES = [
  "Registration",
  "Email Verification",
  "Business Information",
  "Tax Information",
  "Bank Information",
  "Document Submission",
  "Compliance Review",
  "Finance/Admin Approval",
  "Vendor Mapping",
  "Portal Activation",
] as const

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
  { id: "INV-77", vendor: "Zenith Software Labs", recipient: "Priya Nair", email: "priya@zenithlabs.io", role: "Vendor Admin", sent: "2026-09-10", expires: "2026-09-24", accepted: null, status: "sent", sentBy: "admin@muenot" },
  { id: "INV-78", vendor: "Blue Ridge Textiles", recipient: "Marcus Hale", email: "m.hale@blueridge.com", role: "Vendor Admin", sent: "2026-09-01", expires: "2026-09-15", accepted: null, status: "expired", sentBy: "k.iyer@muenot" },
  { id: "INV-79", vendor: "Acme Components", recipient: "Deepa Rao", email: "deepa@acmecomp.in", role: "Invoice User", sent: "2026-08-18", expires: "2026-09-01", accepted: "2026-08-19", status: "accepted", sentBy: "admin@muenot" },
  { id: "INV-80", vendor: "Vertex Metals", recipient: "Liam Chen", email: "liam@vertexmetals.com", role: "Finance User", sent: "2026-09-22", expires: "2026-10-06", accepted: null, status: "sent", sentBy: "admin@muenot" },
  { id: "INV-81", vendor: "Falcon Tools", recipient: "Greg Park", email: "greg@falcontools.com", role: "Viewer", sent: "2026-08-30", expires: "2026-09-13", accepted: null, status: "revoked", sentBy: "a.bose@muenot" },
]

export type AccessRequestType = "new-user" | "additional-access" | "document-access" | "invoice-access" | "payment-access" | "profile-change" | "bank-change" | "other"
export type AccessRequestStatus = "new" | "under-review" | "approved" | "rejected" | "completed"

export const ACCESS_REQUEST_TYPE_LABEL: Record<AccessRequestType, string> = {
  "new-user": "New User",
  "additional-access": "Additional Access",
  "document-access": "Document Access",
  "invoice-access": "Invoice Access",
  "payment-access": "Payment Access",
  "profile-change": "Profile Change",
  "bank-change": "Bank Change",
  other: "Other",
}

export const ACCESS_REQUEST_STATUS_LABEL: Record<AccessRequestStatus, string> = {
  new: "New",
  "under-review": "Under Review",
  approved: "Approved",
  rejected: "Rejected",
  completed: "Completed",
}

export type AccessRequest = {
  id: string
  vendor: string
  requestedBy: string
  type: AccessRequestType
  detail: string
  requested: string
  status: AccessRequestStatus
}

export const ACCESS_REQUESTS: AccessRequest[] = [
  { id: "AR-301", vendor: "Northwind Logistics", requestedBy: "sara@northwind.com", type: "bank-change", detail: "Update primary settlement account", requested: "2026-09-24", status: "new" },
  { id: "AR-302", vendor: "Acme Components", requestedBy: "ravi@acmecomp.in", type: "additional-access", detail: "Grant Payment History access", requested: "2026-09-23", status: "under-review" },
  { id: "AR-303", vendor: "Greenfield Agro", requestedBy: "anita@greenfield.in", type: "new-user", detail: "Add accounts payable clerk", requested: "2026-09-22", status: "approved" },
  { id: "AR-304", vendor: "Zenith Software Labs", requestedBy: "priya@zenithlabs.io", type: "document-access", detail: "Access to signed MSA", requested: "2026-09-20", status: "completed" },
  { id: "AR-305", vendor: "Harbor Freight Supplies", requestedBy: "elena@harborfreight.com", type: "invoice-access", detail: "Re-enable invoice submission", requested: "2026-09-15", status: "rejected" },
]

export type BankDetail = {
  id: string
  vendor: string
  holder: string
  bank: string
  maskedAccount: string
  ifscSwift: string
  iban: string | null
  currency: string
  country: string
  status: "unverified" | "pending" | "verified" | "rejected" | "change-requested"
  updated: string
}

export const BANK_DETAILS: BankDetail[] = [
  { id: "BK-01", vendor: "Acme Components", holder: "Acme Components Pvt Ltd", bank: "HDFC Bank", maskedAccount: "•••• 4821", ifscSwift: "HDFC0001234", iban: null, currency: "INR", country: "India", status: "verified", updated: "2025-02-18" },
  { id: "BK-02", vendor: "Northwind Logistics", holder: "Northwind Logistics LLC", bank: "Chase", maskedAccount: "•••• 9930", ifscSwift: "CHASUS33", iban: null, currency: "USD", country: "United States", status: "change-requested", updated: "2026-09-24" },
  { id: "BK-03", vendor: "Blue Ridge Textiles", holder: "Blue Ridge Textiles Inc", bank: "Bank of America", maskedAccount: "•••• 1122", ifscSwift: "BOFAUS3N", iban: null, currency: "USD", country: "United States", status: "pending", updated: "2026-09-20" },
  { id: "BK-04", vendor: "Greenfield Agro", holder: "Greenfield Agro Pvt Ltd", bank: "ICICI Bank", maskedAccount: "•••• 7745", ifscSwift: "ICIC0004455", iban: null, currency: "INR", country: "India", status: "verified", updated: "2025-01-15" },
  { id: "BK-05", vendor: "Sahara Packaging", holder: "Sahara Packaging FZE", bank: "Emirates NBD", maskedAccount: "•••• 3300", ifscSwift: "EBILAEAD", iban: "AE07 0331 2345 6789 0123 456", currency: "AED", country: "UAE", status: "unverified", updated: "2026-06-04" },
]

export type BankChangeRequest = {
  id: string
  vendor: string
  requestedBy: string
  oldSummary: string
  newSummary: string
  requested: string
  verification: "not-started" | "pending" | "verified"
  reviewer: string | null
  status: "new" | "under-review" | "approved" | "rejected"
}

export const BANK_CHANGE_REQUESTS: BankChangeRequest[] = [
  { id: "BCR-11", vendor: "Northwind Logistics", requestedBy: "sara@northwind.com", oldSummary: "Chase •••• 9930 · CHASUS33", newSummary: "Wells Fargo •••• 6721 · WFBIUS6S", requested: "2026-09-24", verification: "pending", reviewer: "K. Iyer", status: "under-review" },
  { id: "BCR-12", vendor: "Meridian Electricals", requestedBy: "john@meridian.co.uk", oldSummary: "Barclays •••• 5540 · BARCGB22", newSummary: "HSBC •••• 8890 · HBUKGB4B", requested: "2026-09-19", verification: "not-started", reviewer: null, status: "new" },
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
  { id: "CD-01", vendor: "Acme Components", document: "GST Registration", type: "GST/VAT", number: "27AABCA1234F1Z5", issued: "2023-04-01", expiry: "2027-03-31", status: "verified" },
  { id: "CD-02", vendor: "Acme Components", document: "PAN Card", type: "PAN/Tax ID", number: "AABCA1234F", issued: "2019-06-11", expiry: "—", status: "verified" },
  { id: "CD-03", vendor: "Northwind Logistics", document: "W-9 Form", type: "W-9/W-8", number: "EIN 47-1122334", issued: "2024-01-15", expiry: "2026-12-31", status: "expiring" },
  { id: "CD-04", vendor: "Greenfield Agro", document: "MSME Certificate", type: "MSME", number: "UDYAM-KA-03-0099887", issued: "2022-08-20", expiry: "—", status: "verified" },
  { id: "CD-05", vendor: "Meridian Electricals", document: "Public Liability Insurance", type: "Insurance", number: "PLI-88291", issued: "2024-05-01", expiry: "2026-04-30", status: "expired" },
  { id: "CD-06", vendor: "Blue Ridge Textiles", document: "Business Registration", type: "Registration", number: "NC-SOS-778213", issued: "2020-02-10", expiry: "—", status: "pending" },
]

export type VendorDocument = {
  id: string
  vendor: string
  name: string
  category: string
  version: string
  uploaded: string
  status: ComplianceStatus
}

export const VENDOR_DOCUMENTS: VendorDocument[] = [
  { id: "DOC-01", vendor: "Acme Components", name: "Certificate of Incorporation.pdf", category: "Registration Documents", version: "v1", uploaded: "2025-02-12", status: "verified" },
  { id: "DOC-02", vendor: "Acme Components", name: "GST Certificate.pdf", category: "Tax Documents", version: "v2", uploaded: "2026-09-23", status: "pending" },
  { id: "DOC-03", vendor: "Northwind Logistics", name: "Cancelled Cheque.jpg", category: "Bank Proof", version: "v1", uploaded: "2025-03-04", status: "verified" },
  { id: "DOC-04", vendor: "Greenfield Agro", name: "Master Service Agreement.pdf", category: "Contracts", version: "v3", uploaded: "2026-01-10", status: "verified" },
  { id: "DOC-05", vendor: "Blue Ridge Textiles", name: "NDA.pdf", category: "NDA", version: "v1", uploaded: "2026-09-23", status: "pending" },
  { id: "DOC-06", vendor: "Meridian Electricals", name: "Insurance Policy.pdf", category: "Compliance", version: "v1", uploaded: "2024-05-02", status: "expired" },
]

export type PortalInvoice = {
  id: string
  vendor: string
  po: string
  date: string
  amount: number
  currency: string
  submitted: string
  validation: "passed" | "flagged" | "pending"
  approval: "pending" | "approved" | "rejected"
  payment: "unpaid" | "scheduled" | "paid"
  status: "draft" | "submitted" | "under-review" | "approved" | "rejected" | "payment-scheduled" | "paid"
}

export const PORTAL_INVOICES: PortalInvoice[] = [
  { id: "INV-4821", vendor: "Greenfield Agro", po: "PO-9910", date: "2026-09-24", amount: 184500, currency: "INR", submitted: "2026-09-24", validation: "pending", approval: "pending", payment: "unpaid", status: "submitted" },
  { id: "INV-4820", vendor: "Acme Components", po: "PO-9902", date: "2026-09-20", amount: 92000, currency: "INR", submitted: "2026-09-20", validation: "passed", approval: "approved", payment: "scheduled", status: "payment-scheduled" },
  { id: "INV-4819", vendor: "Northwind Logistics", po: "PO-9887", date: "2026-09-15", amount: 14200, currency: "USD", submitted: "2026-09-16", validation: "passed", approval: "approved", payment: "paid", status: "paid" },
  { id: "INV-4818", vendor: "Harbor Freight Supplies", po: "PO-9871", date: "2026-09-10", amount: 7600, currency: "USD", submitted: "2026-09-11", validation: "flagged", approval: "rejected", payment: "unpaid", status: "rejected" },
  { id: "INV-4817", vendor: "Acme Components", po: "PO-9866", date: "2026-09-05", amount: 45000, currency: "INR", submitted: "2026-09-06", validation: "passed", approval: "pending", payment: "unpaid", status: "under-review" },
]

export type PortalPO = {
  id: string
  vendor: string
  amount: number
  currency: string
  issued: string
  status: "open" | "acknowledged" | "closed"
  visible: boolean
  acknowledged: boolean
  ackDate: string | null
}

export const PORTAL_POS: PortalPO[] = [
  { id: "PO-9910", vendor: "Greenfield Agro", amount: 184500, currency: "INR", issued: "2026-09-18", status: "acknowledged", visible: true, acknowledged: true, ackDate: "2026-09-19" },
  { id: "PO-9902", vendor: "Acme Components", amount: 92000, currency: "INR", issued: "2026-09-12", status: "acknowledged", visible: true, acknowledged: true, ackDate: "2026-09-13" },
  { id: "PO-9887", vendor: "Northwind Logistics", amount: 14200, currency: "USD", issued: "2026-09-05", status: "closed", visible: true, acknowledged: true, ackDate: "2026-09-06" },
  { id: "PO-9871", vendor: "Harbor Freight Supplies", amount: 7600, currency: "USD", issued: "2026-08-28", status: "open", visible: false, acknowledged: false, ackDate: null },
  { id: "PO-9866", vendor: "Acme Components", amount: 45000, currency: "INR", issued: "2026-08-20", status: "open", visible: true, acknowledged: false, ackDate: null },
]

export type PortalPayment = {
  id: string
  vendor: string
  invoice: string
  amount: number
  currency: string
  date: string
  method: string
  status: "scheduled" | "processing" | "paid" | "failed"
  advice: boolean
  visible: boolean
}

export const PORTAL_PAYMENTS: PortalPayment[] = [
  { id: "PAY-3301", vendor: "Northwind Logistics", invoice: "INV-4819", amount: 14200, currency: "USD", date: "2026-09-18", method: "Wire", status: "paid", advice: true, visible: true },
  { id: "PAY-3302", vendor: "Acme Components", invoice: "INV-4820", amount: 92000, currency: "INR", date: "2026-09-28", method: "NEFT", status: "scheduled", advice: false, visible: true },
  { id: "PAY-3303", vendor: "Greenfield Agro", invoice: "INV-4805", amount: 66000, currency: "INR", date: "2026-09-10", method: "NEFT", status: "paid", advice: true, visible: true },
  { id: "PAY-3304", vendor: "Harbor Freight Supplies", invoice: "INV-4790", amount: 5400, currency: "USD", date: "2026-08-30", method: "ACH", status: "failed", advice: false, visible: false },
]

export type PortalContract = {
  id: string
  name: string
  vendor: string
  effective: string
  expiry: string
  status: "active" | "expiring" | "expired" | "draft"
  visible: boolean
  shared: string | null
}

export const PORTAL_CONTRACTS: PortalContract[] = [
  { id: "CTR-201", name: "Master Service Agreement", vendor: "Greenfield Agro", effective: "2025-01-15", expiry: "2027-01-14", status: "active", visible: true, shared: "2025-01-16" },
  { id: "CTR-202", name: "Supply Agreement 2026", vendor: "Acme Components", effective: "2026-01-01", expiry: "2026-12-31", status: "expiring", visible: true, shared: "2026-01-03" },
  { id: "CTR-203", name: "Logistics SLA", vendor: "Northwind Logistics", effective: "2025-03-10", expiry: "2026-03-09", status: "expired", visible: false, shared: null },
  { id: "CTR-204", name: "NDA", vendor: "Blue Ridge Textiles", effective: "2026-09-23", expiry: "2028-09-22", status: "draft", visible: false, shared: null },
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
  status: "active" | "idle"
}

export const PORTAL_SESSIONS: PortalSession[] = [
  { id: "S-01", vendor: "Acme Components", user: "Ravi Menon", device: "MacBook Pro", browser: "Chrome 129", ip: "103.21.44.12", login: "2026-09-24T08:02:00Z", lastActivity: "2026-09-24T09:11:00Z", status: "active" },
  { id: "S-02", vendor: "Acme Components", user: "Ravi Menon", device: "iPhone 15", browser: "Safari 18", ip: "103.21.44.18", login: "2026-09-24T07:40:00Z", lastActivity: "2026-09-24T08:05:00Z", status: "idle" },
  { id: "S-03", vendor: "Northwind Logistics", user: "Sara Klein", device: "Windows 11", browser: "Edge 129", ip: "72.14.201.5", login: "2026-09-23T15:40:00Z", lastActivity: "2026-09-23T17:22:00Z", status: "idle" },
  { id: "S-04", vendor: "Greenfield Agro", user: "Anita Desai", device: "Windows 11", browser: "Chrome 129", ip: "49.207.11.90", login: "2026-09-24T06:22:00Z", lastActivity: "2026-09-24T09:02:00Z", status: "active" },
]

export type NotificationTemplate = {
  id: string
  name: string
  event: string
  channels: string[]
  status: "active" | "draft"
  updated: string
}

export const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  { id: "NT-01", name: "Vendor Invitation", event: "Invitation", channels: ["Email", "Portal"], status: "active", updated: "2026-08-01" },
  { id: "NT-02", name: "Application Approved", event: "Approval", channels: ["Email", "Portal"], status: "active", updated: "2026-08-01" },
  { id: "NT-03", name: "Application Rejected", event: "Rejection", channels: ["Email"], status: "active", updated: "2026-08-01" },
  { id: "NT-04", name: "Information Requested", event: "Information Requested", channels: ["Email", "Portal"], status: "active", updated: "2026-08-05" },
  { id: "NT-05", name: "Document Expiring", event: "Document Expiring", channels: ["Email", "Portal", "WhatsApp"], status: "active", updated: "2026-08-10" },
  { id: "NT-06", name: "Invoice Submitted", event: "Invoice Submitted", channels: ["Portal"], status: "active", updated: "2026-08-10" },
  { id: "NT-07", name: "Invoice Approved", event: "Invoice Approved", channels: ["Email", "Portal"], status: "active", updated: "2026-08-10" },
  { id: "NT-08", name: "Invoice Rejected", event: "Invoice Rejected", channels: ["Email", "Portal"], status: "draft", updated: "2026-08-12" },
  { id: "NT-09", name: "Payment Scheduled", event: "Payment Scheduled", channels: ["Email", "Portal"], status: "active", updated: "2026-08-15" },
  { id: "NT-10", name: "Payment Completed", event: "Payment Completed", channels: ["Email", "Portal", "SMS"], status: "active", updated: "2026-08-15" },
  { id: "NT-11", name: "PO Issued", event: "PO Issued", channels: ["Email", "Portal"], status: "active", updated: "2026-08-18" },
  { id: "NT-12", name: "Contract Shared", event: "Contract Shared", channels: ["Email", "Portal"], status: "active", updated: "2026-08-18" },
  { id: "NT-13", name: "Account Suspended", event: "Account Suspended", channels: ["Email"], status: "active", updated: "2026-08-20" },
]

export type Announcement = {
  id: string
  title: string
  message: string
  audience: string
  priority: "low" | "normal" | "high"
  start: string
  end: string
  status: "scheduled" | "published" | "expired" | "draft"
}

export const ANNOUNCEMENTS: Announcement[] = [
  { id: "AN-01", title: "Portal maintenance window", message: "Scheduled downtime on Sep 30, 01:00–03:00 IST for system upgrades.", audience: "All Vendors", priority: "high", start: "2026-09-25", end: "2026-09-30", status: "published" },
  { id: "AN-02", title: "New invoice format required", message: "From October, all invoices must reference a valid PO number.", audience: "Manufacturers", priority: "normal", start: "2026-09-20", end: "2026-10-31", status: "published" },
  { id: "AN-03", title: "Year-end statement availability", message: "Annual statements will be published to the portal in December.", audience: "India", priority: "low", start: "2026-11-01", end: "2026-12-31", status: "scheduled" },
]

export type AuditEntry = {
  id: string
  time: string
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

export const AUDIT_LOG: AuditEntry[] = [
  { id: "A-9001", time: "2026-09-24T09:11:00Z", actor: "ravi@acmecomp.in", vendor: "Acme Components", user: "Ravi Menon", action: "Invoice Upload", resource: "INV-4821", oldValue: "—", newValue: "Submitted", ip: "103.21.44.12", result: "success" },
  { id: "A-9002", time: "2026-09-24T05:10:00Z", actor: "sara@northwind.com", vendor: "Northwind Logistics", user: "Sara Klein", action: "Bank Detail Change", resource: "BK-02", oldValue: "Chase •••• 9930", newValue: "Wells Fargo •••• 6721", ip: "72.14.201.5", result: "success" },
  { id: "A-9003", time: "2026-09-23T22:30:00Z", actor: "unknown", vendor: "Meridian Electricals", user: "John Baptiste", action: "Failed Login", resource: "Session", oldValue: "—", newValue: "—", ip: "88.202.11.4", result: "failure" },
  { id: "A-9004", time: "2026-09-23T15:40:00Z", actor: "admin@muenot", vendor: "Harbor Freight Supplies", user: "Elena Ross", action: "Permission Change", resource: "Account", oldValue: "Active", newValue: "Suspended", ip: "10.0.4.21", result: "success" },
  { id: "A-9005", time: "2026-09-23T11:02:00Z", actor: "ravi@acmecomp.in", vendor: "Acme Components", user: "Ravi Menon", action: "Document Upload", resource: "GST Certificate", oldValue: "v1", newValue: "v2", ip: "103.21.44.12", result: "success" },
  { id: "A-9006", time: "2026-09-22T09:14:00Z", actor: "anita@greenfield.in", vendor: "Greenfield Agro", user: "Anita Desai", action: "Payment Advice Download", resource: "PAY-3303", oldValue: "—", newValue: "Downloaded", ip: "49.207.11.90", result: "success" },
]

/** Vendor-portal resources for the permission matrix (SPEC 119 §7). */
export const ACCESS_RESOURCES = [
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
] as const

export const PERMISSION_LEVELS = [
  "No Access",
  "View",
  "Download",
  "Create",
  "Submit",
  "Edit",
  "Upload",
  "Comment",
  "Approve",
] as const

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
] as const

export type AccessProfile = {
  id: string
  name: string
  description: string
  users: number
  system: boolean
}

export const ACCESS_PROFILES: AccessProfile[] = [
  { id: "AP-01", name: "Vendor Admin", description: "Full access to all vendor portal features for their company.", users: 42, system: true },
  { id: "AP-02", name: "Finance User", description: "Invoices, payments, statements and tax documents.", users: 78, system: true },
  { id: "AP-03", name: "Invoice User", description: "Submit and track invoices against purchase orders.", users: 61, system: true },
  { id: "AP-04", name: "Operations User", description: "Purchase orders, documents and messages.", users: 33, system: true },
  { id: "AP-05", name: "Viewer", description: "Read-only access to shared records.", users: 55, system: true },
  { id: "AP-06", name: "AP Contact (Custom)", description: "Custom profile for accounts-payable contacts.", users: 12, system: false },
]

/** Onboarding form builder default sections/fields (SPEC 119 §6). */
export type FormFieldType =
  | "Text" | "Email" | "Phone" | "Number" | "Date" | "Address" | "Country"
  | "Dropdown" | "Multi-select" | "Checkbox" | "Radio" | "Textarea" | "Tax ID"
  | "Registration Number" | "Bank Field" | "File Upload" | "Document Upload" | "Custom Field"

export type FormField = {
  id: string
  label: string
  type: FormFieldType
  required: boolean
  enabled: boolean
}

export type FormSection = {
  id: string
  title: string
  enabled: boolean
  fields: FormField[]
}

export const ONBOARDING_FORM: FormSection[] = [
  {
    id: "sec-basic", title: "Basic Information", enabled: true, fields: [
      { id: "f1", label: "Legal Company Name", type: "Text", required: true, enabled: true },
      { id: "f2", label: "Trade Name", type: "Text", required: false, enabled: true },
      { id: "f3", label: "Primary Email", type: "Email", required: true, enabled: true },
      { id: "f4", label: "Primary Phone", type: "Phone", required: true, enabled: true },
    ],
  },
  {
    id: "sec-business", title: "Business Details", enabled: true, fields: [
      { id: "f5", label: "Business Type", type: "Dropdown", required: true, enabled: true },
      { id: "f6", label: "Year Established", type: "Number", required: false, enabled: true },
      { id: "f7", label: "Registration Number", type: "Registration Number", required: true, enabled: true },
    ],
  },
  {
    id: "sec-address", title: "Registered Address", enabled: true, fields: [
      { id: "f8", label: "Address", type: "Address", required: true, enabled: true },
      { id: "f9", label: "Country", type: "Country", required: true, enabled: true },
    ],
  },
  {
    id: "sec-tax", title: "Tax Information", enabled: true, fields: [
      { id: "f10", label: "GST / VAT Number", type: "Tax ID", required: true, enabled: true },
      { id: "f11", label: "PAN / Tax ID", type: "Tax ID", required: true, enabled: true },
      { id: "f12", label: "MSME Registered", type: "Checkbox", required: false, enabled: true },
    ],
  },
  {
    id: "sec-bank", title: "Bank Details", enabled: true, fields: [
      { id: "f13", label: "Account Holder", type: "Text", required: true, enabled: true },
      { id: "f14", label: "Bank Account", type: "Bank Field", required: true, enabled: true },
      { id: "f15", label: "Cancelled Cheque", type: "Document Upload", required: true, enabled: true },
    ],
  },
  {
    id: "sec-docs", title: "Documents", enabled: true, fields: [
      { id: "f16", label: "Registration Certificate", type: "Document Upload", required: true, enabled: true },
      { id: "f17", label: "Tax Certificate", type: "Document Upload", required: true, enabled: true },
    ],
  },
  {
    id: "sec-terms", title: "Declarations", enabled: true, fields: [
      { id: "f18", label: "Accept Terms & Conditions", type: "Checkbox", required: true, enabled: true },
      { id: "f19", label: "Privacy Consent", type: "Checkbox", required: true, enabled: true },
    ],
  },
]

export const FORM_FIELD_TYPES: FormFieldType[] = [
  "Text", "Email", "Phone", "Number", "Date", "Address", "Country", "Dropdown",
  "Multi-select", "Checkbox", "Radio", "Textarea", "Tax ID", "Registration Number",
  "Bank Field", "File Upload", "Document Upload", "Custom Field",
]

export function vendorName(id: string): string {
  return VENDORS.find((v) => v.id === id)?.name ?? id
}

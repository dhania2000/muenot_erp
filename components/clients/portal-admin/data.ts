/**
 * Client Portal Admin Console — mock data & types.
 *
 * FRONTEND UI ONLY. Every dataset here is realistic mock state so the admin
 * control center renders a complete, dense experience. All actions in the UI
 * mutate this local state (via component state) and are wired with clear
 * frontend states ready for later API/backend integration.
 *
 * This module is the ADMIN control center for the existing external portal
 * (/portal/login, /portal, /portal/[resource]) — it does NOT define a second
 * portal.
 */

export type PortalStatus =
  | "active"
  | "pending"
  | "invited"
  | "suspended"
  | "rejected"
  | "disabled"

export type OnboardingStatus =
  | "not_started"
  | "in_progress"
  | "documents_pending"
  | "review"
  | "complete"

export type PortalUserStatus =
  | "invited"
  | "pending"
  | "active"
  | "suspended"
  | "locked"
  | "disabled"

export type ApplicationStatus =
  | "pending"
  | "under_review"
  | "needs_info"
  | "approved"
  | "rejected"
  | "expired"

export type RequestStatus = "new" | "in_review" | "approved" | "rejected" | "completed"

export type PermissionLevel =
  | "none"
  | "view"
  | "download"
  | "create"
  | "edit"
  | "upload"
  | "comment"
  | "approve"

export const PERMISSION_LEVELS: { value: PermissionLevel; label: string }[] = [
  { value: "none", label: "No Access" },
  { value: "view", label: "View" },
  { value: "download", label: "Download" },
  { value: "create", label: "Create" },
  { value: "edit", label: "Edit" },
  { value: "upload", label: "Upload" },
  { value: "comment", label: "Comment" },
  { value: "approve", label: "Approve" },
]

export const PORTAL_RESOURCE_LIST = [
  "Dashboard",
  "Projects",
  "Orders",
  "Invoices",
  "Payments",
  "Statements",
  "Quotations",
  "Contracts",
  "Documents",
  "Reports",
  "Tickets",
  "Support",
  "Messages",
  "Deliverables",
  "Shared Files",
  "Knowledge Base",
  "Notifications",
  "Profile",
  "Company Details",
  "Team Members",
] as const

export type PortalResourceName = (typeof PORTAL_RESOURCE_LIST)[number]

/* ------------------------------------------------------------------ KPIs */

export type Kpi = {
  key: string
  label: string
  value: number
  delta?: number
  tone?: "default" | "positive" | "warning" | "danger"
  hint?: string
}

export const KPIS: Kpi[] = [
  { key: "total_clients", label: "Total Portal Clients", value: 148, delta: 6, tone: "default" },
  { key: "active_orgs", label: "Active Organizations", value: 112, delta: 4, tone: "positive" },
  { key: "pending_onboarding", label: "Pending Onboarding", value: 14, delta: -2, tone: "warning" },
  { key: "pending_approvals", label: "Pending Approvals", value: 9, tone: "warning" },
  { key: "active_users", label: "Active Portal Users", value: 486, delta: 23, tone: "positive" },
  { key: "suspended_users", label: "Suspended Users", value: 7, tone: "danger" },
  { key: "invited_users", label: "Invited Users", value: 31, tone: "default" },
  { key: "invites_expiring", label: "Invitations Expiring", value: 5, tone: "warning" },
  { key: "rejected_apps", label: "Rejected Applications", value: 4, tone: "danger" },
  { key: "access_requests", label: "Access Requests Pending", value: 12, tone: "warning" },
  { key: "docs_review", label: "Documents Awaiting Review", value: 18, tone: "warning" },
  { key: "open_tickets", label: "Open Portal Tickets", value: 26, tone: "default" },
  { key: "logins_30d", label: "Last 30 Days Logins", value: 3421, delta: 12, tone: "positive" },
  { key: "failed_logins", label: "Failed Login Attempts", value: 63, tone: "danger" },
]

/* ------------------------------------------------------------------ Charts */

export const ADOPTION_TREND = [
  { label: "Apr", value: 78 },
  { label: "May", value: 86 },
  { label: "Jun", value: 94 },
  { label: "Jul", value: 103 },
  { label: "Aug", value: 121 },
  { label: "Sep", value: 148 },
]

export const ACTIVE_USERS_TREND = [
  { label: "Apr", value: 312 },
  { label: "May", value: 344 },
  { label: "Jun", value: 381 },
  { label: "Jul", value: 402 },
  { label: "Aug", value: 448 },
  { label: "Sep", value: 486 },
]

export const LOGIN_ACTIVITY = [
  { label: "Mon", value: 512 },
  { label: "Tue", value: 604 },
  { label: "Wed", value: 578 },
  { label: "Thu", value: 631 },
  { label: "Fri", value: 549 },
  { label: "Sat", value: 214 },
  { label: "Sun", value: 178 },
]

export const ONBOARDING_FUNNEL = [
  { label: "Applications", value: 64 },
  { label: "Email Verified", value: 57 },
  { label: "Company Review", value: 48 },
  { label: "Documents", value: 39 },
  { label: "Approved", value: 33 },
  { label: "Activated", value: 31 },
]

export const APPROVAL_TREND = [
  { label: "Apr", value: 22 },
  { label: "May", value: 27 },
  { label: "Jun", value: 25 },
  { label: "Jul", value: 31 },
  { label: "Aug", value: 29 },
  { label: "Sep", value: 33 },
]

export const RESOURCE_USAGE = [
  { label: "Invoices", value: 1240 },
  { label: "Documents", value: 986 },
  { label: "Projects", value: 742 },
  { label: "Tickets", value: 531 },
  { label: "Statements", value: 402 },
  { label: "Messages", value: 318 },
]

export type PortalEvent = {
  id: string
  actor: string
  action: string
  target: string
  at: string
  kind: "login" | "approve" | "invite" | "document" | "access" | "user" | "security"
}

export const RECENT_EVENTS: PortalEvent[] = [
  { id: "e1", actor: "Priya Nair", action: "signed in to the portal", target: "Acme Interiors", at: "2 min ago", kind: "login" },
  { id: "e2", actor: "Admin · R. Mehta", action: "approved application", target: "Vertex Logistics", at: "18 min ago", kind: "approve" },
  { id: "e3", actor: "Admin · S. Kapoor", action: "sent an invitation to", target: "cfo@northwind.co", at: "42 min ago", kind: "invite" },
  { id: "e4", actor: "Daniel Osei", action: "uploaded a document to", target: "Project Falcon", at: "1 hr ago", kind: "document" },
  { id: "e5", actor: "Admin · R. Mehta", action: "granted Invoices access to", target: "Bluepeak Retail", at: "2 hr ago", kind: "access" },
  { id: "e6", actor: "System", action: "locked account after failed logins", target: "ops@zenithmfg.com", at: "3 hr ago", kind: "security" },
  { id: "e7", actor: "Admin · S. Kapoor", action: "created a portal user for", target: "Harbour Foods", at: "5 hr ago", kind: "user" },
]

/* ------------------------------------------------------------------ Clients */

export type PortalClient = {
  id: string
  name: string
  clientId: string
  company: string
  contact: string
  contactEmail: string
  contactPhone: string
  status: PortalStatus
  onboarding: OnboardingStatus
  users: number
  activeSessions: number
  accessProfile: string
  lastLogin: string | null
  created: string
  approved: string | null
  accountManager: string
  resourcesShared: number
  openRequests: number
}

export const CLIENTS: PortalClient[] = [
  {
    id: "c1", name: "Acme Interiors", clientId: "CL-1042", company: "Acme Interiors Pvt Ltd",
    contact: "Priya Nair", contactEmail: "priya@acmeinteriors.com", contactPhone: "+91 98200 11221",
    status: "active", onboarding: "complete", users: 6, activeSessions: 3, accessProfile: "Client Admin",
    lastLogin: "2026-09-24", created: "2025-11-02", approved: "2025-11-05", accountManager: "R. Mehta",
    resourcesShared: 42, openRequests: 1,
  },
  {
    id: "c2", name: "Vertex Logistics", clientId: "CL-1088", company: "Vertex Logistics LLC",
    contact: "Daniel Osei", contactEmail: "daniel@vertexlog.com", contactPhone: "+1 415 555 0142",
    status: "active", onboarding: "complete", users: 11, activeSessions: 5, accessProfile: "Finance User",
    lastLogin: "2026-09-23", created: "2025-08-14", approved: "2025-08-19", accountManager: "S. Kapoor",
    resourcesShared: 68, openRequests: 0,
  },
  {
    id: "c3", name: "Northwind Traders", clientId: "CL-1120", company: "Northwind Traders Inc",
    contact: "Grace Lin", contactEmail: "cfo@northwind.co", contactPhone: "+1 206 555 0199",
    status: "invited", onboarding: "not_started", users: 0, activeSessions: 0, accessProfile: "—",
    lastLogin: null, created: "2026-09-20", approved: null, accountManager: "R. Mehta",
    resourcesShared: 0, openRequests: 0,
  },
  {
    id: "c4", name: "Bluepeak Retail", clientId: "CL-1101", company: "Bluepeak Retail Group",
    contact: "Marco Rossi", contactEmail: "marco@bluepeak.eu", contactPhone: "+39 06 555 0188",
    status: "pending", onboarding: "review", users: 2, activeSessions: 0, accessProfile: "Viewer",
    lastLogin: null, created: "2026-09-18", approved: null, accountManager: "S. Kapoor",
    resourcesShared: 4, openRequests: 3,
  },
  {
    id: "c5", name: "Zenith Manufacturing", clientId: "CL-0987", company: "Zenith Mfg Co",
    contact: "Aisha Rahman", contactEmail: "ops@zenithmfg.com", contactPhone: "+971 4 555 0177",
    status: "suspended", onboarding: "complete", users: 4, activeSessions: 0, accessProfile: "Project User",
    lastLogin: "2026-08-30", created: "2025-06-11", approved: "2025-06-15", accountManager: "R. Mehta",
    resourcesShared: 51, openRequests: 2,
  },
  {
    id: "c6", name: "Harbour Foods", clientId: "CL-1133", company: "Harbour Foods Ltd",
    contact: "Tom Becker", contactEmail: "tom@harbourfoods.com", contactPhone: "+44 20 5550 0166",
    status: "active", onboarding: "documents_pending", users: 3, activeSessions: 1, accessProfile: "Approver",
    lastLogin: "2026-09-22", created: "2026-07-29", approved: "2026-08-02", accountManager: "S. Kapoor",
    resourcesShared: 19, openRequests: 1,
  },
  {
    id: "c7", name: "Solaris Energy", clientId: "CL-0954", company: "Solaris Energy Partners",
    contact: "Elena Petrova", contactEmail: "elena@solaris.energy", contactPhone: "+49 30 5550 0155",
    status: "disabled", onboarding: "complete", users: 5, activeSessions: 0, accessProfile: "Client Admin",
    lastLogin: "2026-05-14", created: "2024-12-03", approved: "2024-12-08", accountManager: "R. Mehta",
    resourcesShared: 73, openRequests: 0,
  },
  {
    id: "c8", name: "Cedar & Co", clientId: "CL-1150", company: "Cedar & Co Advisory",
    contact: "James Cole", contactEmail: "james@cedar.co", contactPhone: "+1 312 555 0144",
    status: "rejected", onboarding: "not_started", users: 0, activeSessions: 0, accessProfile: "—",
    lastLogin: null, created: "2026-09-12", approved: null, accountManager: "S. Kapoor",
    resourcesShared: 0, openRequests: 0,
  },
]

/* ------------------------------------------------------------------ Portal users */

export type PortalUser = {
  id: string
  firstName: string
  lastName: string
  email: string
  phone: string
  jobTitle: string
  department: string
  clientId: string
  clientName: string
  role: string
  status: PortalUserStatus
  language: string
  timezone: string
  lastLogin: string | null
  lastActivity: string | null
  invitedAt: string | null
  inviteExpiry: string | null
  createdBy: string
  mfa: boolean
  failedLogins: number
}

export const PORTAL_USERS: PortalUser[] = [
  {
    id: "u1", firstName: "Priya", lastName: "Nair", email: "priya@acmeinteriors.com", phone: "+91 98200 11221",
    jobTitle: "Procurement Head", department: "Procurement", clientId: "c1", clientName: "Acme Interiors",
    role: "Client Admin", status: "active", language: "English", timezone: "Asia/Kolkata",
    lastLogin: "2026-09-24 09:12", lastActivity: "2026-09-24 09:40", invitedAt: "2025-11-02", inviteExpiry: null,
    createdBy: "R. Mehta", mfa: true, failedLogins: 0,
  },
  {
    id: "u2", firstName: "Rahul", lastName: "Sharma", email: "rahul@acmeinteriors.com", phone: "+91 98200 11222",
    jobTitle: "Finance Manager", department: "Finance", clientId: "c1", clientName: "Acme Interiors",
    role: "Finance User", status: "active", language: "English", timezone: "Asia/Kolkata",
    lastLogin: "2026-09-23 14:05", lastActivity: "2026-09-23 14:22", invitedAt: "2025-11-06", inviteExpiry: null,
    createdBy: "R. Mehta", mfa: false, failedLogins: 1,
  },
  {
    id: "u3", firstName: "Daniel", lastName: "Osei", email: "daniel@vertexlog.com", phone: "+1 415 555 0142",
    jobTitle: "Operations Director", department: "Operations", clientId: "c2", clientName: "Vertex Logistics",
    role: "Client Admin", status: "active", language: "English", timezone: "America/Los_Angeles",
    lastLogin: "2026-09-23 22:31", lastActivity: "2026-09-23 23:02", invitedAt: "2025-08-14", inviteExpiry: null,
    createdBy: "S. Kapoor", mfa: true, failedLogins: 0,
  },
  {
    id: "u4", firstName: "Grace", lastName: "Lin", email: "cfo@northwind.co", phone: "+1 206 555 0199",
    jobTitle: "CFO", department: "Finance", clientId: "c3", clientName: "Northwind Traders",
    role: "Client Admin", status: "invited", language: "English", timezone: "America/New_York",
    lastLogin: null, lastActivity: null, invitedAt: "2026-09-20", inviteExpiry: "2026-09-27",
    createdBy: "R. Mehta", mfa: false, failedLogins: 0,
  },
  {
    id: "u5", firstName: "Aisha", lastName: "Rahman", email: "ops@zenithmfg.com", phone: "+971 4 555 0177",
    jobTitle: "Plant Manager", department: "Operations", clientId: "c5", clientName: "Zenith Manufacturing",
    role: "Project User", status: "locked", language: "English", timezone: "Asia/Dubai",
    lastLogin: "2026-08-30 06:14", lastActivity: "2026-08-30 06:20", invitedAt: "2025-06-11", inviteExpiry: null,
    createdBy: "R. Mehta", mfa: true, failedLogins: 5,
  },
  {
    id: "u6", firstName: "Tom", lastName: "Becker", email: "tom@harbourfoods.com", phone: "+44 20 5550 0166",
    jobTitle: "Supply Chain Lead", department: "Supply Chain", clientId: "c6", clientName: "Harbour Foods",
    role: "Approver", status: "active", language: "English", timezone: "Europe/London",
    lastLogin: "2026-09-22 11:48", lastActivity: "2026-09-22 12:10", invitedAt: "2026-07-29", inviteExpiry: null,
    createdBy: "S. Kapoor", mfa: false, failedLogins: 0,
  },
  {
    id: "u7", firstName: "Marco", lastName: "Rossi", email: "marco@bluepeak.eu", phone: "+39 06 555 0188",
    jobTitle: "Category Manager", department: "Merchandising", clientId: "c4", clientName: "Bluepeak Retail",
    role: "Viewer", status: "pending", language: "Italian", timezone: "Europe/Rome",
    lastLogin: null, lastActivity: null, invitedAt: "2026-09-18", inviteExpiry: "2026-09-25",
    createdBy: "S. Kapoor", mfa: false, failedLogins: 0,
  },
  {
    id: "u8", firstName: "Elena", lastName: "Petrova", email: "elena@solaris.energy", phone: "+49 30 5550 0155",
    jobTitle: "Head of Projects", department: "Projects", clientId: "c7", clientName: "Solaris Energy",
    role: "Client Admin", status: "disabled", language: "German", timezone: "Europe/Berlin",
    lastLogin: "2026-05-14 08:00", lastActivity: "2026-05-14 08:30", invitedAt: "2024-12-03", inviteExpiry: null,
    createdBy: "R. Mehta", mfa: true, failedLogins: 0,
  },
]

/* ------------------------------------------------------------------ Applications */

export type PortalApplication = {
  id: string
  company: string
  applicant: string
  email: string
  phone: string
  submitted: string
  verification: "verified" | "pending" | "failed"
  documents: number
  reviewer: string | null
  status: ApplicationStatus
  country: string
  industry: string
  employees: string
  notes: { author: string; at: string; text: string }[]
}

export const APPLICATIONS: PortalApplication[] = [
  {
    id: "APP-2041", company: "Northwind Traders Inc", applicant: "Grace Lin", email: "cfo@northwind.co",
    phone: "+1 206 555 0199", submitted: "2026-09-20", verification: "verified", documents: 4, reviewer: null,
    status: "pending", country: "United States", industry: "Wholesale", employees: "51-200",
    notes: [],
  },
  {
    id: "APP-2038", company: "Bluepeak Retail Group", applicant: "Marco Rossi", email: "marco@bluepeak.eu",
    phone: "+39 06 555 0188", submitted: "2026-09-18", verification: "pending", documents: 2, reviewer: "S. Kapoor",
    status: "under_review", country: "Italy", industry: "Retail", employees: "201-500",
    notes: [{ author: "S. Kapoor", at: "2026-09-19", text: "Awaiting VAT registration proof." }],
  },
  {
    id: "APP-2035", company: "Cedar & Co Advisory", applicant: "James Cole", email: "james@cedar.co",
    phone: "+1 312 555 0144", submitted: "2026-09-12", verification: "failed", documents: 1, reviewer: "R. Mehta",
    status: "needs_info", country: "United States", industry: "Consulting", employees: "11-50",
    notes: [{ author: "R. Mehta", at: "2026-09-13", text: "Company name mismatch on tax certificate." }],
  },
  {
    id: "APP-2030", company: "Harbour Foods Ltd", applicant: "Tom Becker", email: "tom@harbourfoods.com",
    phone: "+44 20 5550 0166", submitted: "2026-07-28", verification: "verified", documents: 5, reviewer: "S. Kapoor",
    status: "approved", country: "United Kingdom", industry: "Food & Beverage", employees: "201-500",
    notes: [{ author: "S. Kapoor", at: "2026-08-01", text: "All checks passed. Activated." }],
  },
  {
    id: "APP-2022", company: "Quantum Systems", applicant: "Nadia Haddad", email: "nadia@quantum.io",
    phone: "+1 650 555 0133", submitted: "2026-06-30", verification: "failed", documents: 0, reviewer: "R. Mehta",
    status: "rejected", country: "United States", industry: "Technology", employees: "1-10",
    notes: [{ author: "R. Mehta", at: "2026-07-02", text: "Unable to verify business registration." }],
  },
  {
    id: "APP-2010", company: "Old Mill Textiles", applicant: "Ravi Kumar", email: "ravi@oldmill.in",
    phone: "+91 80 5550 0122", submitted: "2026-05-15", verification: "pending", documents: 3, reviewer: null,
    status: "expired", country: "India", industry: "Textiles", employees: "51-200",
    notes: [],
  },
]

export const APPROVAL_PIPELINE = [
  "Application",
  "Identity / Email Verification",
  "Company Review",
  "Document Review",
  "Admin Approval",
  "Client Record Mapping",
  "Portal Account Activation",
  "Welcome / Activation Notification",
]

/* ------------------------------------------------------------------ Onboarding form builder */

export type FieldType =
  | "text" | "email" | "phone" | "number" | "date" | "dropdown" | "multiselect"
  | "checkbox" | "radio" | "textarea" | "address" | "country" | "state"
  | "tax_id" | "registration_number" | "file" | "document" | "url" | "custom"

export type OnboardingField = {
  id: string
  label: string
  type: FieldType
  required: boolean
  enabled: boolean
  placeholder?: string
  description?: string
  conditional?: string
}

export type OnboardingFormSection = {
  id: string
  title: string
  fields: OnboardingField[]
}

export const ONBOARDING_FORM: OnboardingFormSection[] = [
  {
    id: "s-contact", title: "Contact Information",
    fields: [
      { id: "f1", label: "First Name", type: "text", required: true, enabled: true, placeholder: "Jane" },
      { id: "f2", label: "Last Name", type: "text", required: true, enabled: true, placeholder: "Doe" },
      { id: "f3", label: "Work Email", type: "email", required: true, enabled: true, placeholder: "name@company.com" },
      { id: "f4", label: "Phone", type: "phone", required: false, enabled: true },
    ],
  },
  {
    id: "s-company", title: "Company Information",
    fields: [
      { id: "f5", label: "Company Name", type: "text", required: true, enabled: true },
      { id: "f6", label: "Website", type: "url", required: false, enabled: true },
      { id: "f7", label: "Industry", type: "dropdown", required: false, enabled: true },
      { id: "f8", label: "Company Size", type: "dropdown", required: false, enabled: true },
    ],
  },
  {
    id: "s-address", title: "Registered Address",
    fields: [
      { id: "f9", label: "Address", type: "address", required: true, enabled: true },
      { id: "f10", label: "Country", type: "country", required: true, enabled: true },
      { id: "f11", label: "State / Region", type: "state", required: false, enabled: true },
    ],
  },
  {
    id: "s-tax", title: "Tax Information",
    fields: [
      { id: "f12", label: "Tax ID", type: "tax_id", required: true, enabled: true },
      { id: "f13", label: "Registration Number", type: "registration_number", required: false, enabled: true },
    ],
  },
  {
    id: "s-docs", title: "Documents",
    fields: [
      { id: "f14", label: "Business Registration", type: "document", required: true, enabled: true },
      { id: "f15", label: "Tax Certificate", type: "document", required: false, enabled: true },
    ],
  },
  {
    id: "s-agreement", title: "Agreement & Declaration",
    fields: [
      { id: "f16", label: "Accept Terms of Service", type: "checkbox", required: true, enabled: true },
      { id: "f17", label: "Privacy Consent", type: "checkbox", required: true, enabled: true },
    ],
  },
]

export const FIELD_TYPE_OPTIONS: { value: FieldType; label: string }[] = [
  { value: "text", label: "Text" }, { value: "email", label: "Email" }, { value: "phone", label: "Phone" },
  { value: "number", label: "Number" }, { value: "date", label: "Date" }, { value: "dropdown", label: "Dropdown" },
  { value: "multiselect", label: "Multi-select" }, { value: "checkbox", label: "Checkbox" }, { value: "radio", label: "Radio" },
  { value: "textarea", label: "Textarea" }, { value: "address", label: "Address" }, { value: "country", label: "Country" },
  { value: "state", label: "State" }, { value: "tax_id", label: "Tax ID" }, { value: "registration_number", label: "Registration Number" },
  { value: "file", label: "File Upload" }, { value: "document", label: "Document Upload" }, { value: "url", label: "URL" },
  { value: "custom", label: "Custom Field" },
]

/* ------------------------------------------------------------------ Access profiles */

export type AccessProfile = {
  id: string
  name: string
  description: string
  users: number
  clients: number
  permissions: number
  updated: string
  system: boolean
}

export const ACCESS_PROFILES: AccessProfile[] = [
  { id: "ap1", name: "Client Admin", description: "Full portal access for the client organisation owner.", users: 42, clients: 38, permissions: 20, updated: "2026-09-10", system: true },
  { id: "ap2", name: "Finance User", description: "Invoices, payments and statements.", users: 96, clients: 61, permissions: 8, updated: "2026-09-08", system: true },
  { id: "ap3", name: "Project User", description: "Projects, deliverables and shared files.", users: 74, clients: 52, permissions: 9, updated: "2026-08-30", system: true },
  { id: "ap4", name: "Viewer", description: "Read-only access to shared records.", users: 118, clients: 70, permissions: 6, updated: "2026-08-22", system: true },
  { id: "ap5", name: "Approver", description: "Can review and approve documents and orders.", users: 33, clients: 24, permissions: 11, updated: "2026-09-02", system: false },
  { id: "ap6", name: "Support Contact", description: "Tickets, support and messages only.", users: 47, clients: 40, permissions: 5, updated: "2026-07-19", system: false },
]

/* ------------------------------------------------------------------ Shared resources */

export type SharedResource = {
  id: string
  type: string
  name: string
  client: string
  sharedWith: string
  permission: PermissionLevel
  sharedBy: string
  sharedDate: string
  expiry: string | null
  status: "active" | "expired" | "revoked"
}

export const SHARED_RESOURCES: SharedResource[] = [
  { id: "r1", type: "Invoice", name: "INV-2026-0421", client: "Acme Interiors", sharedWith: "All users", permission: "download", sharedBy: "R. Mehta", sharedDate: "2026-09-20", expiry: null, status: "active" },
  { id: "r2", type: "Project", name: "Project Falcon", client: "Vertex Logistics", sharedWith: "Daniel Osei", permission: "comment", sharedBy: "S. Kapoor", sharedDate: "2026-09-15", expiry: "2026-12-31", status: "active" },
  { id: "r3", type: "Document", name: "MSA 2026.pdf", client: "Harbour Foods", sharedWith: "Approvers", permission: "approve", sharedBy: "S. Kapoor", sharedDate: "2026-09-11", expiry: null, status: "active" },
  { id: "r4", type: "Statement", name: "Aug Statement", client: "Zenith Manufacturing", sharedWith: "All users", permission: "view", sharedBy: "R. Mehta", sharedDate: "2026-08-31", expiry: "2026-09-30", status: "expired" },
  { id: "r5", type: "Deliverable", name: "Design Pack v3", client: "Acme Interiors", sharedWith: "Priya Nair", permission: "download", sharedBy: "R. Mehta", sharedDate: "2026-09-05", expiry: null, status: "revoked" },
  { id: "r6", type: "Report", name: "Q3 Usage Report", client: "Solaris Energy", sharedWith: "Client Admins", permission: "view", sharedBy: "R. Mehta", sharedDate: "2026-09-01", expiry: null, status: "active" },
]

/* ------------------------------------------------------------------ Documents */

export type PortalDocument = {
  id: string
  name: string
  category: string
  client: string
  uploadedBy: string
  uploadedDate: string
  visibility: "shared" | "private" | "internal"
  expiry: string | null
  verification: "verified" | "pending" | "rejected"
}

export const DOCUMENT_CATEGORIES = [
  "Client Documents", "Contracts", "Invoices", "Statements", "Project Files",
  "Deliverables", "Compliance Documents", "Shared Documents", "Onboarding Documents",
]

export const DOCUMENTS: PortalDocument[] = [
  { id: "d1", name: "Master Service Agreement.pdf", category: "Contracts", client: "Acme Interiors", uploadedBy: "R. Mehta", uploadedDate: "2026-09-18", visibility: "shared", expiry: "2027-09-18", verification: "verified" },
  { id: "d2", name: "GST Certificate.pdf", category: "Compliance Documents", client: "Vertex Logistics", uploadedBy: "Daniel Osei", uploadedDate: "2026-09-16", visibility: "internal", expiry: null, verification: "pending" },
  { id: "d3", name: "INV-2026-0421.pdf", category: "Invoices", client: "Acme Interiors", uploadedBy: "System", uploadedDate: "2026-09-20", visibility: "shared", expiry: null, verification: "verified" },
  { id: "d4", name: "Onboarding Form.pdf", category: "Onboarding Documents", client: "Bluepeak Retail", uploadedBy: "Marco Rossi", uploadedDate: "2026-09-18", visibility: "internal", expiry: null, verification: "pending" },
  { id: "d5", name: "Design Pack v3.zip", category: "Deliverables", client: "Acme Interiors", uploadedBy: "R. Mehta", uploadedDate: "2026-09-05", visibility: "shared", expiry: null, verification: "verified" },
  { id: "d6", name: "Tax Certificate.pdf", category: "Compliance Documents", client: "Cedar & Co", uploadedBy: "James Cole", uploadedDate: "2026-09-12", visibility: "internal", expiry: null, verification: "rejected" },
]

/* ------------------------------------------------------------------ Requests */

export type AccessRequest = {
  id: string
  type: string
  client: string
  requestedBy: string
  submitted: string
  reviewer: string | null
  status: RequestStatus
  detail: string
}

export const REQUEST_TYPES = [
  "Portal Access", "Additional Permission", "New User", "Document Access",
  "Resource Access", "Account Change", "Other",
]

export const ACCESS_REQUESTS: AccessRequest[] = [
  { id: "REQ-501", type: "Additional Permission", client: "Acme Interiors", requestedBy: "Rahul Sharma", submitted: "2026-09-23", reviewer: null, status: "new", detail: "Requesting Approve access on Contracts." },
  { id: "REQ-499", type: "New User", client: "Vertex Logistics", requestedBy: "Daniel Osei", submitted: "2026-09-22", reviewer: "S. Kapoor", status: "in_review", detail: "Add finance analyst maria@vertexlog.com." },
  { id: "REQ-495", type: "Document Access", client: "Harbour Foods", requestedBy: "Tom Becker", submitted: "2026-09-21", reviewer: "S. Kapoor", status: "approved", detail: "Access to 2026 contract renewals." },
  { id: "REQ-490", type: "Portal Access", client: "Bluepeak Retail", requestedBy: "Marco Rossi", submitted: "2026-09-19", reviewer: null, status: "new", detail: "Enable portal login for merchandising team." },
  { id: "REQ-488", type: "Account Change", client: "Zenith Manufacturing", requestedBy: "Aisha Rahman", submitted: "2026-09-16", reviewer: "R. Mehta", status: "rejected", detail: "Change registered email domain." },
  { id: "REQ-480", type: "Resource Access", client: "Solaris Energy", requestedBy: "Elena Petrova", submitted: "2026-09-10", reviewer: "R. Mehta", status: "completed", detail: "Share Q3 usage reports." },
]

/* ------------------------------------------------------------------ Invitations */

export type Invitation = {
  id: string
  recipient: string
  client: string
  role: string
  sent: string
  expires: string
  accepted: boolean
  status: "pending" | "accepted" | "expired" | "revoked"
  sentBy: string
}

export const INVITATIONS: Invitation[] = [
  { id: "i1", recipient: "cfo@northwind.co", client: "Northwind Traders", role: "Client Admin", sent: "2026-09-20", expires: "2026-09-27", accepted: false, status: "pending", sentBy: "R. Mehta" },
  { id: "i2", recipient: "maria@vertexlog.com", client: "Vertex Logistics", role: "Finance User", sent: "2026-09-21", expires: "2026-09-28", accepted: false, status: "pending", sentBy: "S. Kapoor" },
  { id: "i3", recipient: "marco@bluepeak.eu", client: "Bluepeak Retail", role: "Viewer", sent: "2026-09-18", expires: "2026-09-25", accepted: false, status: "pending", sentBy: "S. Kapoor" },
  { id: "i4", recipient: "tom@harbourfoods.com", client: "Harbour Foods", role: "Approver", sent: "2026-07-29", expires: "2026-08-05", accepted: true, status: "accepted", sentBy: "S. Kapoor" },
  { id: "i5", recipient: "old@oldmill.in", client: "Old Mill Textiles", role: "Viewer", sent: "2026-05-15", expires: "2026-05-22", accepted: false, status: "expired", sentBy: "R. Mehta" },
  { id: "i6", recipient: "temp@cedar.co", client: "Cedar & Co", role: "Viewer", sent: "2026-09-12", expires: "2026-09-19", accepted: false, status: "revoked", sentBy: "S. Kapoor" },
]

/* ------------------------------------------------------------------ Sessions */

export type PortalSessionRow = {
  id: string
  user: string
  client: string
  device: string
  browser: string
  ip: string
  location: string
  loginTime: string
  lastActivity: string
  status: "active" | "idle" | "expired"
}

export const SESSIONS: PortalSessionRow[] = [
  { id: "s1", user: "Priya Nair", client: "Acme Interiors", device: "MacBook Pro", browser: "Chrome 128", ip: "103.21.44.12", location: "Mumbai, IN", loginTime: "2026-09-24 09:12", lastActivity: "2026-09-24 09:40", status: "active" },
  { id: "s2", user: "Daniel Osei", client: "Vertex Logistics", device: "Windows 11", browser: "Edge 128", ip: "72.14.201.9", location: "San Francisco, US", loginTime: "2026-09-23 22:31", lastActivity: "2026-09-23 23:02", status: "idle" },
  { id: "s3", user: "Rahul Sharma", client: "Acme Interiors", device: "iPhone 15", browser: "Safari Mobile", ip: "103.21.44.55", location: "Mumbai, IN", loginTime: "2026-09-23 14:05", lastActivity: "2026-09-23 14:22", status: "active" },
  { id: "s4", user: "Tom Becker", client: "Harbour Foods", device: "iPad Air", browser: "Safari 17", ip: "81.2.69.144", location: "London, UK", loginTime: "2026-09-22 11:48", lastActivity: "2026-09-22 12:10", status: "expired" },
]

/* ------------------------------------------------------------------ Notifications */

export type NotificationTemplate = {
  id: string
  event: string
  email: boolean
  portal: boolean
  whatsapp: boolean
  sms: boolean
  subject: string
}

export const NOTIFICATION_TEMPLATES: NotificationTemplate[] = [
  { id: "n1", event: "Account Created", email: true, portal: true, whatsapp: false, sms: false, subject: "Welcome to the {{portalName}} client portal" },
  { id: "n2", event: "Invitation", email: true, portal: false, whatsapp: false, sms: false, subject: "You've been invited to the client portal" },
  { id: "n3", event: "Account Approved", email: true, portal: true, whatsapp: false, sms: false, subject: "Your portal account is approved" },
  { id: "n4", event: "Application Rejected", email: true, portal: false, whatsapp: false, sms: false, subject: "Update on your portal application" },
  { id: "n5", event: "Password Reset", email: true, portal: false, whatsapp: false, sms: true, subject: "Reset your portal password" },
  { id: "n6", event: "Document Shared", email: true, portal: true, whatsapp: false, sms: false, subject: "A new document was shared with you" },
  { id: "n7", event: "Invoice Available", email: true, portal: true, whatsapp: true, sms: false, subject: "New invoice {{invoiceNo}} is available" },
  { id: "n8", event: "Payment Received", email: true, portal: true, whatsapp: false, sms: false, subject: "We've received your payment" },
  { id: "n9", event: "Project Update", email: false, portal: true, whatsapp: false, sms: false, subject: "Update on {{projectName}}" },
  { id: "n10", event: "Ticket Update", email: true, portal: true, whatsapp: false, sms: false, subject: "Your support ticket was updated" },
  { id: "n11", event: "Access Changed", email: true, portal: true, whatsapp: false, sms: false, subject: "Your portal access has changed" },
]

/* ------------------------------------------------------------------ Announcements */

export type Announcement = {
  id: string
  title: string
  message: string
  audience: "all" | "specific"
  clients: string[]
  start: string
  end: string | null
  priority: "low" | "normal" | "high"
  status: "draft" | "scheduled" | "published" | "expired"
}

export const ANNOUNCEMENTS: Announcement[] = [
  { id: "a1", title: "Scheduled maintenance this weekend", message: "The portal will be unavailable Sat 02:00–04:00 UTC.", audience: "all", clients: [], start: "2026-09-26", end: "2026-09-28", priority: "high", status: "published" },
  { id: "a2", title: "New statements module available", message: "You can now download monthly statements directly.", audience: "all", clients: [], start: "2026-09-15", end: null, priority: "normal", status: "published" },
  { id: "a3", title: "Holiday support hours", message: "Support will run limited hours during the holidays.", audience: "specific", clients: ["Acme Interiors", "Vertex Logistics"], start: "2026-12-20", end: "2027-01-02", priority: "low", status: "scheduled" },
  { id: "a4", title: "Portal onboarding refresh", message: "Draft announcement for the new onboarding flow.", audience: "all", clients: [], start: "2026-10-01", end: null, priority: "normal", status: "draft" },
]

/* ------------------------------------------------------------------ Activity / audit */

export type ActivityRow = {
  id: string
  event: string
  user: string
  client: string
  ip: string
  at: string
  result: "success" | "failed"
}

export const ACTIVITY_LOG: ActivityRow[] = [
  { id: "al1", event: "Successful Login", user: "Priya Nair", client: "Acme Interiors", ip: "103.21.44.12", at: "2026-09-24 09:12", result: "success" },
  { id: "al2", event: "Document Download", user: "Daniel Osei", client: "Vertex Logistics", ip: "72.14.201.9", at: "2026-09-23 22:40", result: "success" },
  { id: "al3", event: "Failed Login", user: "ops@zenithmfg.com", client: "Zenith Manufacturing", ip: "185.60.12.4", at: "2026-09-23 06:14", result: "failed" },
  { id: "al4", event: "Password Reset", user: "Rahul Sharma", client: "Acme Interiors", ip: "103.21.44.55", at: "2026-09-22 08:02", result: "success" },
  { id: "al5", event: "Permission Change", user: "Admin · R. Mehta", client: "Bluepeak Retail", ip: "10.0.0.4", at: "2026-09-21 15:30", result: "success" },
  { id: "al6", event: "Account Lock", user: "ops@zenithmfg.com", client: "Zenith Manufacturing", ip: "185.60.12.4", at: "2026-08-30 06:20", result: "failed" },
  { id: "al7", event: "Resource View", user: "Tom Becker", client: "Harbour Foods", ip: "81.2.69.144", at: "2026-09-22 11:55", result: "success" },
  { id: "al8", event: "File Upload", user: "Marco Rossi", client: "Bluepeak Retail", ip: "151.38.4.2", at: "2026-09-18 10:11", result: "success" },
]

export const ACTIVITY_EVENTS = [
  "Successful Login", "Failed Login", "Password Reset", "Account Lock",
  "Resource View", "Document Download", "File Upload", "Permission Change",
]

export type AuditRow = {
  id: string
  at: string
  actor: string
  client: string
  user: string
  action: string
  resource: string
  oldValue: string
  newValue: string
  ip: string
  result: "success" | "denied"
}

export const AUDIT_LOG: AuditRow[] = [
  { id: "au1", at: "2026-09-24 09:40", actor: "Admin · R. Mehta", client: "Bluepeak Retail", user: "Marco Rossi", action: "Update permission", resource: "Invoices", oldValue: "View", newValue: "Download", ip: "10.0.0.4", result: "success" },
  { id: "au2", at: "2026-09-23 18:22", actor: "Admin · S. Kapoor", client: "Vertex Logistics", user: "—", action: "Approve application", resource: "APP-2038", oldValue: "Under Review", newValue: "Approved", ip: "10.0.0.7", result: "success" },
  { id: "au3", at: "2026-09-23 06:14", actor: "System", client: "Zenith Manufacturing", user: "Aisha Rahman", action: "Lock account", resource: "Account", oldValue: "Active", newValue: "Locked", ip: "185.60.12.4", result: "success" },
  { id: "au4", at: "2026-09-22 12:00", actor: "Admin · R. Mehta", client: "Acme Interiors", user: "Rahul Sharma", action: "Reset access", resource: "Access Profile", oldValue: "Client Admin", newValue: "Finance User", ip: "10.0.0.4", result: "success" },
  { id: "au5", at: "2026-09-21 09:31", actor: "Client · Daniel Osei", client: "Vertex Logistics", user: "Daniel Osei", action: "Attempt export", resource: "All invoices", oldValue: "—", newValue: "—", ip: "72.14.201.9", result: "denied" },
  { id: "au6", at: "2026-09-20 11:05", actor: "Admin · R. Mehta", client: "Northwind Traders", user: "—", action: "Send invitation", resource: "cfo@northwind.co", oldValue: "—", newValue: "Pending", ip: "10.0.0.4", result: "success" },
]

/* ------------------------------------------------------------------ label maps */

export const STATUS_LABELS: Record<PortalStatus, string> = {
  active: "Active", pending: "Pending", invited: "Invited",
  suspended: "Suspended", rejected: "Rejected", disabled: "Disabled",
}

export const ONBOARDING_LABELS: Record<OnboardingStatus, string> = {
  not_started: "Not started", in_progress: "In progress", documents_pending: "Documents pending",
  review: "In review", complete: "Complete",
}

export const USER_STATUS_LABELS: Record<PortalUserStatus, string> = {
  invited: "Invited", pending: "Pending", active: "Active",
  suspended: "Suspended", locked: "Locked", disabled: "Disabled",
}

export const APPLICATION_LABELS: Record<ApplicationStatus, string> = {
  pending: "Pending Review", under_review: "Under Review", needs_info: "Needs Information",
  approved: "Approved", rejected: "Rejected", expired: "Expired",
}

export const REQUEST_LABELS: Record<RequestStatus, string> = {
  new: "New", in_review: "In Review", approved: "Approved", rejected: "Rejected", completed: "Completed",
}

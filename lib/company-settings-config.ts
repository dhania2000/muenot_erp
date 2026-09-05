// Configuration for the full Company Settings area, modeled on Worksuite's
// account/company-settings screen. Each section maps to a form; each field
// is persisted as a key/value pair in the `company_settings` table.

export type FieldType =
  | "text"
  | "textarea"
  | "number"
  | "email"
  | "password"
  | "select"
  | "toggle"
  | "color"
  | "time"
  | "date"
  | "url"

export type SettingField = {
  key: string
  label: string
  type: FieldType
  options?: string[]
  placeholder?: string
  help?: string
  default?: string
  secret?: boolean
  full?: boolean
}

export type SettingSection = {
  id: string
  label: string
  icon: string
  description: string
  fields: SettingField[]
}

const yesNo = ["Enabled", "Disabled"]

export const companySettingsSections: SettingSection[] = [
  {
    id: "company",
    label: "Company Settings",
    icon: "Building2",
    description: "Core identity of your organisation shown across the workspace.",
    fields: [
      { key: "company.name", label: "Company Name", type: "text", default: "Muenot Business Team", placeholder: "Acme Pvt Ltd" },
      { key: "company.email", label: "Company Email", type: "email", placeholder: "hello@acme.com" },
      { key: "company.phone", label: "Company Phone", type: "text", placeholder: "+91 90000 00000" },
      { key: "company.website", label: "Company Website", type: "url", placeholder: "https://acme.com" },
      { key: "company.logo", label: "Company Logo URL", type: "url", placeholder: "https://.../logo.png", full: true },
      { key: "company.login_logo", label: "Login Screen Logo URL", type: "url", placeholder: "https://.../login-logo.png", full: true },
      { key: "company.favicon", label: "Favicon URL", type: "url", placeholder: "https://.../favicon.ico", full: true },
    ],
  },
  {
    id: "business_address",
    label: "Business Address",
    icon: "MapPin",
    description: "Registered address and legal/tax identifiers.",
    fields: [
      { key: "address.line", label: "Address", type: "textarea", full: true, placeholder: "Street, area, landmark" },
      { key: "address.city", label: "City", type: "text" },
      { key: "address.state", label: "State", type: "text" },
      { key: "address.postal_code", label: "Postal Code", type: "text" },
      { key: "address.country", label: "Country", type: "select", options: ["India", "United States", "United Kingdom", "United Arab Emirates", "Singapore", "Australia", "Canada"], default: "India" },
      { key: "address.tax_name", label: "Tax Name", type: "text", placeholder: "GST" },
      { key: "address.tax_number", label: "Tax / GST Number", type: "text", placeholder: "22AAAAA0000A1Z5" },
    ],
  },
  {
    id: "app",
    label: "App Settings",
    icon: "AppWindow",
    description: "Global application behaviour and locale defaults.",
    fields: [
      { key: "app.name", label: "Application Name", type: "text", default: "Muenot ERP" },
      { key: "app.timezone", label: "Timezone", type: "select", options: ["Asia/Kolkata", "UTC", "America/New_York", "Europe/London", "Asia/Dubai", "Asia/Singapore"], default: "Asia/Kolkata" },
      { key: "app.date_format", label: "Date Format", type: "select", options: ["DD-MM-YYYY", "MM-DD-YYYY", "YYYY-MM-DD", "DD/MM/YYYY"], default: "DD-MM-YYYY" },
      { key: "app.time_format", label: "Time Format", type: "select", options: ["12 Hours", "24 Hours"], default: "12 Hours" },
      { key: "app.week_start", label: "Week Starts On", type: "select", options: ["Sunday", "Monday", "Saturday"], default: "Monday" },
      { key: "app.financial_year_start", label: "Financial Year Start Month", type: "select", options: ["January", "April", "July", "October"], default: "April" },
    ],
  },
  {
    id: "currency",
    label: "Currency Settings",
    icon: "Coins",
    description: "Default currency and formatting rules for money values.",
    fields: [
      { key: "currency.default_code", label: "Default Currency", type: "select", options: ["INR", "USD", "EUR", "GBP", "AED", "SGD", "AUD"], default: "INR" },
      { key: "currency.symbol", label: "Currency Symbol", type: "text", default: "₹" },
      { key: "currency.symbol_position", label: "Symbol Position", type: "select", options: ["Left", "Right", "Left with space", "Right with space"], default: "Left" },
      { key: "currency.decimals", label: "No. of Decimals", type: "number", default: "2" },
      { key: "currency.thousand_separator", label: "Thousand Separator", type: "text", default: "," },
      { key: "currency.decimal_separator", label: "Decimal Separator", type: "text", default: "." },
    ],
  },
  {
    id: "payment",
    label: "Payment Credentials",
    icon: "CreditCard",
    description: "Gateway keys used to collect online payments. Stored securely.",
    fields: [
      { key: "payment.gateway_enabled", label: "Online Payments", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "payment.default_gateway", label: "Default Gateway", type: "select", options: ["Razorpay", "Stripe", "PayPal", "Paytm"], default: "Razorpay" },
      { key: "payment.razorpay_key", label: "Razorpay Key ID", type: "text", secret: true },
      { key: "payment.razorpay_secret", label: "Razorpay Key Secret", type: "password", secret: true },
      { key: "payment.stripe_key", label: "Stripe Publishable Key", type: "text", secret: true },
      { key: "payment.stripe_secret", label: "Stripe Secret Key", type: "password", secret: true },
      { key: "payment.paypal_client", label: "PayPal Client ID", type: "text", secret: true },
      { key: "payment.paypal_secret", label: "PayPal Secret", type: "password", secret: true },
    ],
  },
  {
    id: "notifications",
    label: "Notification Settings",
    icon: "Bell",
    description: "Control which events trigger email and in-app notifications.",
    fields: [
      { key: "notify.email_enabled", label: "Email Notifications", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "notify.push_enabled", label: "In-App Notifications", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "notify.new_task", label: "New Task Assigned", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "notify.new_invoice", label: "New Invoice", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "notify.leave_request", label: "Leave Request", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "notify.new_lead", label: "New Lead", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "notify.ticket_reply", label: "Ticket Reply", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "finance",
    label: "Finance Settings",
    icon: "Wallet",
    description: "Invoice, estimate and billing preferences.",
    fields: [
      { key: "finance.invoice_prefix", label: "Invoice Prefix", type: "text", default: "INV" },
      { key: "finance.invoice_digits", label: "Invoice Number Digits", type: "number", default: "4" },
      { key: "finance.estimate_prefix", label: "Estimate Prefix", type: "text", default: "EST" },
      { key: "finance.payment_prefix", label: "Payment Prefix", type: "text", default: "PMT" },
      { key: "finance.due_days", label: "Default Due (days)", type: "number", default: "15" },
      { key: "finance.invoice_terms", label: "Default Invoice Terms", type: "textarea", full: true, placeholder: "Payment due within 15 days..." },
    ],
  },
  {
    id: "tax",
    label: "Tax Settings",
    icon: "Percent",
    description: "Define tax names and rates applied to documents.",
    fields: [
      { key: "tax.enabled", label: "Enable Tax", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "tax.name", label: "Tax Name", type: "text", default: "GST" },
      { key: "tax.rate", label: "Tax Rate (%)", type: "number", default: "18" },
      { key: "tax.type", label: "Tax Calculation", type: "select", options: ["Exclusive", "Inclusive"], default: "Exclusive" },
      { key: "tax.number_label", label: "Tax Number Label", type: "text", default: "GSTIN" },
    ],
  },
  {
    id: "contract",
    label: "Contract Settings",
    icon: "FileSignature",
    description: "Contract numbering and signature preferences.",
    fields: [
      { key: "contract.prefix", label: "Contract Prefix", type: "text", default: "CON" },
      { key: "contract.digits", label: "Number Digits", type: "number", default: "4" },
      { key: "contract.require_signature", label: "Require Digital Signature", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "contract.default_terms", label: "Default Terms", type: "textarea", full: true },
    ],
  },
  {
    id: "ticket",
    label: "Ticket Settings",
    icon: "TicketCheck",
    description: "Support ticket defaults and routing.",
    fields: [
      { key: "ticket.prefix", label: "Ticket Prefix", type: "text", default: "TKT" },
      { key: "ticket.default_priority", label: "Default Priority", type: "select", options: ["Low", "Medium", "High", "Urgent"], default: "Medium" },
      { key: "ticket.default_status", label: "Default Status", type: "select", options: ["Open", "Pending", "Resolved", "Closed"], default: "Open" },
      { key: "ticket.allow_guest", label: "Allow Guest Tickets", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "ticket.auto_close_days", label: "Auto Close After (days)", type: "number", default: "7" },
    ],
  },
  {
    id: "project",
    label: "Project Settings",
    icon: "FolderKanban",
    description: "Project numbering and member visibility.",
    fields: [
      { key: "project.prefix", label: "Project Prefix", type: "text", default: "PRJ" },
      { key: "project.self_projects", label: "Members See Only Their Projects", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "project.enable_gantt", label: "Enable Gantt Chart", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "project.default_status", label: "Default Status", type: "select", options: ["Not Started", "In Progress", "On Hold", "Finished"], default: "Not Started" },
    ],
  },
  {
    id: "attendance",
    label: "Attendance Settings",
    icon: "Clock",
    description: "Office hours, grace and half-day rules.",
    fields: [
      { key: "attendance.office_start", label: "Office Start Time", type: "time", default: "09:30" },
      { key: "attendance.office_end", label: "Office End Time", type: "time", default: "18:30" },
      { key: "attendance.grace_minutes", label: "Late Grace (minutes)", type: "number", default: "15" },
      { key: "attendance.half_day_hours", label: "Half Day After (hours)", type: "number", default: "4" },
      { key: "attendance.working_days", label: "Working Days / Week", type: "number", default: "5" },
      { key: "attendance.allow_self_clock", label: "Allow Self Clock-in", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "leaves",
    label: "Leaves Settings",
    icon: "CalendarOff",
    description: "Leave policy defaults and approvals.",
    fields: [
      { key: "leaves.annual_quota", label: "Annual Leave Quota", type: "number", default: "24" },
      { key: "leaves.require_document", label: "Require Supporting Document", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "leaves.allow_negative", label: "Allow Negative Balance", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "leaves.approval_levels", label: "Approval Levels", type: "number", default: "1" },
      { key: "leaves.carry_forward", label: "Carry Forward Unused", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "message",
    label: "Message Settings",
    icon: "MessageSquare",
    description: "Internal messaging permissions.",
    fields: [
      { key: "message.enabled", label: "Enable Messaging", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "message.employee_to_employee", label: "Employee to Employee", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "message.allow_attachments", label: "Allow Attachments", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "message.max_attachment_mb", label: "Max Attachment (MB)", type: "number", default: "10" },
    ],
  },
  {
    id: "lead",
    label: "Lead Settings",
    icon: "Target",
    description: "Lead capture and auto-assignment rules.",
    fields: [
      { key: "lead.auto_assign", label: "Auto Assign Leads", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "lead.default_source", label: "Default Source", type: "select", options: ["Website", "Referral", "Advertisement", "Cold Call", "Social Media"], default: "Website" },
      { key: "lead.default_status", label: "Default Status", type: "select", options: ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"], default: "New" },
      { key: "lead.enable_web_form", label: "Enable Web Lead Form", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "timelog",
    label: "Time Log Settings",
    icon: "Timer",
    description: "Time tracking rules for tasks and projects.",
    fields: [
      { key: "timelog.enabled", label: "Enable Time Logs", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "timelog.approval_required", label: "Require Approval", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "timelog.allow_manual", label: "Allow Manual Entry", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "timelog.rounding_minutes", label: "Round To (minutes)", type: "number", default: "15" },
    ],
  },
  {
    id: "task",
    label: "Task Settings",
    icon: "ListChecks",
    description: "Default task behaviour.",
    fields: [
      { key: "task.default_status", label: "Default Status", type: "select", options: ["To Do", "In Progress", "Review", "Completed"], default: "To Do" },
      { key: "task.require_project", label: "Require Project", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "task.allow_dependencies", label: "Allow Dependencies", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "task.self_tasks", label: "Members See Only Their Tasks", type: "toggle", options: yesNo, default: "Disabled" },
    ],
  },
  {
    id: "security",
    label: "Security Settings",
    icon: "ShieldCheck",
    description: "Authentication and password policy.",
    fields: [
      { key: "security.two_factor", label: "Two-Factor Authentication", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "security.session_timeout", label: "Session Timeout (minutes)", type: "number", default: "480" },
      { key: "security.password_min_length", label: "Minimum Password Length", type: "number", default: "8" },
      { key: "security.password_expiry_days", label: "Password Expiry (days)", type: "number", default: "90" },
      { key: "security.max_login_attempts", label: "Max Login Attempts", type: "number", default: "5" },
      { key: "security.force_ssl", label: "Force SSL", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "theme",
    label: "Theme Settings",
    icon: "Palette",
    description: "Workspace appearance and brand colours.",
    fields: [
      { key: "theme.mode", label: "Default Theme", type: "select", options: ["Light", "Dark", "System"], default: "Dark" },
      { key: "theme.primary_color", label: "Primary Color", type: "color", default: "#6d28d9" },
      { key: "theme.sidebar_color", label: "Sidebar Color", type: "color", default: "#0f172a" },
      { key: "theme.login_background", label: "Login Background URL", type: "url", full: true },
    ],
  },
  {
    id: "modules",
    label: "Module Settings",
    icon: "Blocks",
    description: "Enable or disable major modules for the workspace.",
    fields: [
      { key: "module.hr", label: "HR", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "module.finance", label: "Finance", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "module.sales", label: "Sales & CRM", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "module.recruitment", label: "Recruitment", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "module.operations", label: "Operations", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "module.tickets", label: "Tickets", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "module.products", label: "Products", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "storage",
    label: "Storage Settings",
    icon: "HardDrive",
    description: "Where uploaded files are stored.",
    fields: [
      { key: "storage.provider", label: "Storage Provider", type: "select", options: ["Local", "Vercel Blob", "Amazon S3", "Google Cloud"], default: "Vercel Blob" },
      { key: "storage.max_upload_mb", label: "Max Upload Size (MB)", type: "number", default: "25" },
      { key: "storage.allowed_types", label: "Allowed File Types", type: "text", default: "jpg,png,pdf,docx,xlsx", full: true },
      { key: "storage.s3_bucket", label: "S3 Bucket", type: "text" },
      { key: "storage.s3_region", label: "S3 Region", type: "text" },
    ],
  },
  {
    id: "language",
    label: "Language Settings",
    icon: "Languages",
    description: "Default language and localisation.",
    fields: [
      { key: "language.default", label: "Default Language", type: "select", options: ["English", "Hindi", "Spanish", "French", "German", "Arabic"], default: "English" },
      { key: "language.allow_user_switch", label: "Allow Users to Switch", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "language.rtl", label: "Right-to-Left Layout", type: "toggle", options: yesNo, default: "Disabled" },
    ],
  },
  {
    id: "social_login",
    label: "Social Login Settings",
    icon: "LogIn",
    description: "Third-party sign-in providers.",
    fields: [
      { key: "social.google_enabled", label: "Google Login", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "social.google_client_id", label: "Google Client ID", type: "text", secret: true },
      { key: "social.google_secret", label: "Google Client Secret", type: "password", secret: true },
      { key: "social.linkedin_enabled", label: "LinkedIn Login", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "social.facebook_enabled", label: "Facebook Login", type: "toggle", options: yesNo, default: "Disabled" },
    ],
  },
  {
    id: "google_calendar",
    label: "Google Calendar Settings",
    icon: "CalendarDays",
    description: "Sync meetings and events with Google Calendar.",
    fields: [
      { key: "gcal.enabled", label: "Enable Sync", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "gcal.client_id", label: "Client ID", type: "text", secret: true },
      { key: "gcal.client_secret", label: "Client Secret", type: "password", secret: true },
      { key: "gcal.calendar_id", label: "Calendar ID", type: "text" },
    ],
  },
  {
    id: "custom_link",
    label: "Custom Link Settings",
    icon: "Link2",
    description: "Add custom links to the sidebar.",
    fields: [
      { key: "customlink.enabled", label: "Show Custom Link", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "customlink.label", label: "Link Label", type: "text", placeholder: "Help Center" },
      { key: "customlink.url", label: "Link URL", type: "url", placeholder: "https://help.acme.com" },
      { key: "customlink.open_new_tab", label: "Open in New Tab", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "gdpr",
    label: "GDPR Settings",
    icon: "FileLock2",
    description: "Data privacy and consent controls.",
    fields: [
      { key: "gdpr.enabled", label: "Enable GDPR", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "gdpr.cookie_consent", label: "Cookie Consent Banner", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "gdpr.consent_text", label: "Consent Text", type: "textarea", full: true },
      { key: "gdpr.allow_export", label: "Allow Data Export", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "backup",
    label: "Database Backup Settings",
    icon: "DatabaseBackup",
    description: "Automated database backup schedule.",
    fields: [
      { key: "backup.auto_enabled", label: "Automatic Backups", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "backup.frequency", label: "Frequency", type: "select", options: ["Daily", "Weekly", "Monthly"], default: "Daily" },
      { key: "backup.retention_days", label: "Retention (days)", type: "number", default: "30" },
      { key: "backup.time", label: "Backup Time", type: "time", default: "02:00" },
    ],
  },
  {
    id: "signup",
    label: "Sign Up Settings",
    icon: "UserPlus",
    description: "Public registration behaviour.",
    fields: [
      { key: "signup.enabled", label: "Allow Public Sign Up", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "signup.email_verification", label: "Require Email Verification", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "signup.default_role", label: "Default Role", type: "select", options: ["Employee", "Client", "Member"], default: "Employee" },
      { key: "signup.terms_url", label: "Terms & Conditions URL", type: "url" },
    ],
  },
  {
    id: "asset",
    label: "Asset Settings",
    icon: "Boxes",
    description: "Company asset tracking preferences.",
    fields: [
      { key: "asset.prefix", label: "Asset Code Prefix", type: "text", default: "AST" },
      { key: "asset.require_approval", label: "Require Approval to Assign", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "asset.depreciation", label: "Track Depreciation", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "asset.categories", label: "Asset Categories", type: "text", full: true, default: "Laptop,Monitor,Phone,Furniture" },
    ],
  },
  {
    id: "payroll",
    label: "Payroll Settings",
    icon: "Banknote",
    description: "Salary processing defaults.",
    fields: [
      { key: "payroll.enabled", label: "Enable Payroll", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "payroll.cycle", label: "Payroll Cycle", type: "select", options: ["Monthly", "Bi-Weekly", "Weekly"], default: "Monthly" },
      { key: "payroll.pay_day", label: "Pay Day (of month)", type: "number", default: "1" },
      { key: "payroll.currency", label: "Payroll Currency", type: "select", options: ["INR", "USD", "EUR", "GBP", "AED"], default: "INR" },
      { key: "payroll.enable_payslip", label: "Generate Payslips", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "overtime",
    label: "Overtime Settings",
    icon: "AlarmClock",
    description: "Overtime calculation rules.",
    fields: [
      { key: "overtime.enabled", label: "Enable Overtime", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "overtime.rate_multiplier", label: "Rate Multiplier", type: "number", default: "1.5" },
      { key: "overtime.min_minutes", label: "Minimum Minutes to Count", type: "number", default: "30" },
      { key: "overtime.require_approval", label: "Require Approval", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "performance",
    label: "Performance Settings",
    icon: "Gauge",
    description: "Appraisal and review cadence.",
    fields: [
      { key: "performance.enabled", label: "Enable Performance Module", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "performance.cycle", label: "Review Cycle", type: "select", options: ["Quarterly", "Half-Yearly", "Annually"], default: "Quarterly" },
      { key: "performance.rating_scale", label: "Rating Scale", type: "select", options: ["1-5", "1-10", "1-100"], default: "1-5" },
      { key: "performance.self_review", label: "Allow Self Review", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "purchase",
    label: "Purchase Settings",
    icon: "ShoppingCart",
    description: "Purchase order and bill defaults.",
    fields: [
      { key: "purchase.po_prefix", label: "Purchase Order Prefix", type: "text", default: "PO" },
      { key: "purchase.bill_prefix", label: "Bill Prefix", type: "text", default: "BILL" },
      { key: "purchase.require_approval", label: "Require Approval", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "purchase.default_terms", label: "Default Terms", type: "textarea", full: true },
    ],
  },
  {
    id: "recruit",
    label: "Recruit Settings",
    icon: "Users",
    description: "Recruitment pipeline defaults.",
    fields: [
      { key: "recruit.job_prefix", label: "Job Requisition Prefix", type: "text", default: "JOB" },
      { key: "recruit.default_stage", label: "Default Stage", type: "select", options: ["Applied", "Screening", "Interview", "Offer", "Hired", "Rejected"], default: "Applied" },
      { key: "recruit.career_page", label: "Enable Public Career Page", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "recruit.auto_ack", label: "Auto Acknowledge Applications", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
  {
    id: "rest_api",
    label: "Rest API Setting",
    icon: "Webhook",
    description: "Programmatic access to your workspace.",
    fields: [
      { key: "api.enabled", label: "Enable REST API", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "api.key", label: "API Key", type: "text", secret: true },
      { key: "api.rate_limit", label: "Rate Limit (req/min)", type: "number", default: "60" },
      { key: "api.allowed_origins", label: "Allowed Origins (CORS)", type: "text", full: true, placeholder: "https://app.acme.com" },
    ],
  },
  {
    id: "profile",
    label: "Profile Settings",
    icon: "UserCog",
    description: "Defaults for employee profiles.",
    fields: [
      { key: "profile.allow_edit", label: "Allow Employees to Edit Profile", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "profile.require_photo", label: "Require Profile Photo", type: "toggle", options: yesNo, default: "Disabled" },
      { key: "profile.show_birthday", label: "Show Birthdays to Team", type: "toggle", options: yesNo, default: "Enabled" },
      { key: "profile.show_contact", label: "Show Contact Details", type: "toggle", options: yesNo, default: "Enabled" },
    ],
  },
]

export function getSectionDefaults(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const s of companySettingsSections) {
    for (const f of s.fields) {
      if (f.default !== undefined) out[f.key] = f.default
    }
  }
  return out
}

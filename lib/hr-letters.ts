// Shared config + merge logic for the HR Letter feature.

export const LETTER_TYPES = [
  "Offer Letter",
  "Appointment Letter",
  "Confirmation Letter",
  "Experience Letter",
  "Relieving Letter",
  "Promotion Letter",
  "Increment Letter",
  "Warning Letter",
  "Address Proof",
  "No Objection Certificate",
  "Other",
] as const

// Placeholders an author can drop into a template body/subject. Each maps to a
// value resolved from the employee record, company settings, or the letter itself.
export const LETTER_PLACEHOLDERS: { token: string; label: string }[] = [
  { token: "{{employee_name}}", label: "Employee name" },
  { token: "{{employee_code}}", label: "Employee code" },
  { token: "{{designation}}", label: "Designation" },
  { token: "{{department}}", label: "Department" },
  { token: "{{joining_date}}", label: "Joining date" },
  { token: "{{confirmation_date}}", label: "Confirmation date" },
  { token: "{{official_email}}", label: "Official email" },
  { token: "{{work_location}}", label: "Work location" },
  { token: "{{employment_type}}", label: "Employment type" },
  { token: "{{company_name}}", label: "Company name" },
  { token: "{{company_email}}", label: "Company email" },
  { token: "{{company_phone}}", label: "Company phone" },
  { token: "{{company_address}}", label: "Company address" },
  { token: "{{letter_number}}", label: "Letter number" },
  { token: "{{today}}", label: "Today's date" },
]

export type LetterContext = {
  employee?: Record<string, any> | null
  company?: Record<string, string>
  letter_number?: string
}

function formatDate(value: unknown): string {
  if (!value) return ""
  const date = new Date(value as string)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })
}

/** Replace every {{placeholder}} in `text` with values from the context. */
export function renderLetter(text: string, ctx: LetterContext): string {
  const emp = ctx.employee ?? {}
  const company = ctx.company ?? {}
  const map: Record<string, string> = {
    "{{employee_name}}": emp.employee_name ?? "",
    "{{employee_code}}": emp.employee_id ?? "",
    "{{designation}}": emp.designation ?? "",
    "{{department}}": emp.department ?? "",
    "{{joining_date}}": formatDate(emp.joining_date),
    "{{confirmation_date}}": formatDate(emp.confirmation_date),
    "{{official_email}}": emp.official_email ?? "",
    "{{work_location}}": emp.work_location ?? "",
    "{{employment_type}}": emp.employment_type ?? "",
    "{{company_name}}": company["company.name"] ?? "",
    "{{company_email}}": company["company.email"] ?? "",
    "{{company_phone}}": company["company.phone"] ?? "",
    "{{company_address}}": [company["address.line"], company["address.city"], company["address.state"], company["address.country"]].filter(Boolean).join(", "),
    "{{letter_number}}": ctx.letter_number ?? "",
    "{{today}}": formatDate(new Date()),
  }
  return (text ?? "").replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (whole, key) => {
    const token = `{{${String(key).toLowerCase()}}}`
    return token in map ? map[token] : whole
  })
}

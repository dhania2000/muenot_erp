// Imports the Sales CRM Excel workbook into MySQL.
// Run AFTER setup-db.mjs, with DATABASE_URL set:
//   node scripts/import-data.mjs
import mysql from "mysql2/promise"
import { read, utils } from "xlsx"
import fs from "node:fs"
import path from "node:path"

const url = process.env.DATABASE_URL
if (!url) {
  console.error("DATABASE_URL is not set")
  process.exit(1)
}

// Locate the workbook in data/
const dataDir = path.join(process.cwd(), "data")
const file = fs.readdirSync(dataDir).find((f) => f.startsWith("Sales") && f.endsWith(".xlsx"))
if (!file) {
  console.error("Could not find Sales CRM .xlsx in data/")
  process.exit(1)
}
const wb = read(fs.readFileSync(path.join(dataDir, file)), { cellDates: true })

// --- value helpers -------------------------------------------------
function toDate(v) {
  if (v === null || v === undefined || v === "" || v === "#REF!") return null
  let d
  if (v instanceof Date) d = v
  else if (typeof v === "number") d = new Date(Math.round((v - 25569) * 86400 * 1000))
  else d = new Date(v)
  if (isNaN(d.getTime())) return null
  const y = d.getUTCFullYear()
  if (y <= 1900) return null // Excel epoch / empty
  return d.toISOString().slice(0, 10)
}
function toStr(v) {
  if (v === null || v === undefined || v === "#REF!") return null
  const s = String(v).trim()
  return s === "" ? null : s
}
function toNum(v) {
  if (v === null || v === undefined || v === "" || v === "#REF!") return null
  const n = Number(String(v).replace(/[^0-9.-]/g, ""))
  return isNaN(n) ? null : n
}
function toInt(v) {
  const n = toNum(v)
  return n === null ? null : Math.round(n)
}

function rows(sheetName) {
  const ws = wb.Sheets[sheetName]
  if (!ws) return []
  return utils.sheet_to_json(ws, { defval: null })
}

const conn = await mysql.createConnection({ uri: url })
console.log("Connected. Importing from", file)

// Insert helper: batches rows for one table.
async function insertMany(table, cols, records) {
  if (records.length === 0) return
  const placeholders = "(" + cols.map(() => "?").join(",") + ")"
  const chunkSize = 200
  for (let i = 0; i < records.length; i += chunkSize) {
    const chunk = records.slice(i, i + chunkSize)
    const sql = `INSERT INTO ${table} (${cols.join(",")}) VALUES ${chunk.map(() => placeholders).join(",")}`
    const flat = chunk.flatMap((r) => cols.map((c) => r[c] ?? null))
    await conn.query(sql, flat)
  }
  console.log(`  ${table}: ${records.length} rows`)
}

// Wipe sales tables so re-runs are idempotent.
for (const t of [
  "leads",
  "companies",
  "followups",
  "meetings",
  "quotations",
  "contracts",
  "onboarding",
  "deals",
  "revenue_forecast",
  "outreach",
  "email_finder",
]) {
  await conn.query(`DELETE FROM ${t}`)
}

// --- Leads ---------------------------------------------------------
await insertMany(
  "leads",
  ["lead_code","entry_date","contact_person","contact_number","email","designation","source_url","lead_source","company_name","industry","website","company_email","country","assigned_to","status","follow_up_date","remarks","action","last_contact_date","sla_gap_days","next_auto_follow_up","health_score"],
  rows("Leads").filter((r) => toStr(r["Lead ID"])).map((r) => ({
    lead_code: toStr(r["Lead ID"]),
    entry_date: toDate(r["Date"]),
    contact_person: toStr(r["Contact Person"]),
    contact_number: toStr(r["Contact Number"]),
    email: toStr(r["Email"]),
    designation: toStr(r["Designation"]),
    source_url: toStr(r["Source URL (If Available)"]),
    lead_source: toStr(r["Lead Source"]),
    company_name: toStr(r["Company Name"]),
    industry: toStr(r["Industry"]),
    website: toStr(r["Website"]),
    company_email: toStr(r["Company Email"]),
    country: toStr(r["Country"]),
    assigned_to: toStr(r["Assigned To"]),
    status: toStr(r["Status"]),
    follow_up_date: toDate(r["Follow-up Date"]),
    remarks: toStr(r["Remarks"]),
    action: toStr(r["Action"]),
    last_contact_date: toDate(r["Last Contact Date"]),
    sla_gap_days: toInt(r["SLA Gap (Days)"]),
    next_auto_follow_up: toDate(r["Next Auto Follow-Up Date"]),
    health_score: toInt(r["Lead Health Score"]),
  })),
)

// --- Companies -----------------------------------------------------
await insertMany(
  "companies",
  ["company_code","entry_date","name","industry","website","linkedin_url","company_email","country","assigned_to","company_type","status","priority","created_by","last_contact_date","founded_year","num_employees"],
  rows("Companies").filter((r) => toStr(r["Company Name"])).map((r) => ({
    company_code: toStr(r["Company ID"]),
    entry_date: toDate(r["Date"]),
    name: toStr(r["Company Name"]),
    industry: toStr(r["Industry"]),
    website: toStr(r["Website"]),
    linkedin_url: toStr(r["LinkedIn URL"]),
    company_email: toStr(r["Company Email"]),
    country: toStr(r["Country"]),
    assigned_to: toStr(r["Assigned To"]),
    company_type: toStr(r["Company Type"]),
    status: toStr(r["Status"]),
    priority: toStr(r["Priority"]),
    created_by: toStr(r["Created By"]),
    last_contact_date: toDate(r["Last Contact Date"]),
    founded_year: toStr(r["Founded Year"]),
    num_employees: toInt(r["Number of Employees"]),
  })),
)

// --- Follow-ups ----------------------------------------------------
await insertMany(
  "followups",
  ["lead_code","entry_date","contact_person","email","company_name","assigned_to","status","follow_up_date","next_auto_follow_up","health_score","remarks"],
  rows("Follow-ups").filter((r) => toStr(r["Lead ID"])).map((r) => ({
    lead_code: toStr(r["Lead ID"]),
    entry_date: toDate(r["Date"]),
    contact_person: toStr(r["Contact Person"]),
    email: toStr(r["Email"]),
    company_name: toStr(r["Company Name"]),
    assigned_to: toStr(r["Assigned To"]),
    status: toStr(r["Status"]),
    follow_up_date: toDate(r["Follow-up Date"]),
    next_auto_follow_up: toDate(r["Next Auto Follow-Up Date"]),
    health_score: toInt(r["Lead Health Score"]),
    remarks: toStr(r["Remarks"]),
  })),
)

// --- Meetings ------------------------------------------------------
await insertMany(
  "meetings",
  ["meeting_code","entry_date","company_name","meeting_time","contact_person","joining_by","meeting_type","agenda","outcome","next_steps","added_by"],
  rows("Meetings").filter((r) => toStr(r["Meeting ID"])).map((r) => ({
    meeting_code: toStr(r["Meeting ID"]),
    entry_date: toDate(r["Date"]),
    company_name: toStr(r["Company Name"]),
    meeting_time: toStr(r["Time"]),
    contact_person: toStr(r["Contact Person"]),
    joining_by: toStr(r["Meeting Joining By"]),
    meeting_type: toStr(r["Meeting Type"]),
    agenda: toStr(r["Agenda"]),
    outcome: toStr(r["Outcome/Notes"]),
    next_steps: toStr(r["Next Steps"]),
    added_by: toStr(r["Added By"]),
  })),
)

// --- Quotations ----------------------------------------------------
await insertMany(
  "quotations",
  ["quote_code","entry_date","company_name","contact_person","opportunity_name","total_amount","valid_until","status","sent_by","added_by"],
  rows("Quotations").filter((r) => toStr(r["Quote ID"])).map((r) => ({
    quote_code: toStr(r["Quote ID"]),
    entry_date: toDate(r["Date"]),
    company_name: toStr(r["Company Name"]),
    contact_person: toStr(r["Contact Person"]),
    opportunity_name: toStr(r["Opportunity Name"]),
    total_amount: toNum(r["Total Amount"]),
    valid_until: toDate(r["Valid Until"]),
    status: toStr(r["Status"]),
    sent_by: toStr(r["Sent by"]),
    added_by: toStr(r["Added By"]),
  })),
)

// --- Contracts -----------------------------------------------------
await insertMany(
  "contracts",
  ["contract_code","contract_date","company_name","start_date","end_date","duration_days","project_name","value","contract_type","status","added_by","signed_by_client","signed_by_company","notes"],
  rows("Contracts").filter((r) => toStr(r["Contract ID"])).map((r) => ({
    contract_code: toStr(r["Contract ID"]),
    contract_date: toDate(r["Contract Date"]),
    company_name: toStr(r["Company Name"]),
    start_date: toDate(r["Start Date"]),
    end_date: toDate(r["End Date"]),
    duration_days: toInt(r["Contract Duration"]),
    project_name: toStr(r["Project Name"]),
    value: toNum(r["Value"]),
    contract_type: toStr(r["Contract Type"]),
    status: toStr(r["Status"]),
    added_by: toStr(r["Added By"]),
    signed_by_client: toStr(r["Signed By Client"]),
    signed_by_company: toStr(r["Signed By Company"]),
    notes: toStr(r["Notes"]),
  })),
)

// --- Onboarding ----------------------------------------------------
await insertMany(
  "onboarding",
  ["onboarding_code","onboarding_date","company_name","contract_code","start_date","kickoff_date","current_stage","status","onboarding_by","added_by"],
  rows("Client Onboarding").filter((r) => toStr(r["Onboarding ID"])).map((r) => ({
    onboarding_code: toStr(r["Onboarding ID"]),
    onboarding_date: toDate(r["Onboarding Date"]),
    company_name: toStr(r["Company Name"]),
    contract_code: toStr(r["Contract ID"]),
    start_date: toDate(r["Start Date"]),
    kickoff_date: toDate(r["Kickoff Meeting Date"]),
    current_stage: toStr(r["Current Stage"]),
    status: toStr(r["Status"]),
    onboarding_by: toStr(r["Onboarding By"]),
    added_by: toStr(r["Added By"]),
  })),
)

// --- Deals (Won / Lost) -------------------------------------------
function dealRows(sheet, outcome) {
  return rows(sheet).filter((r) => toStr(r["Lead ID"])).map((r) => ({
    lead_code: toStr(r["Lead ID"]),
    entry_date: toDate(r["Date"]),
    contact_person: toStr(r["Contact Person"]),
    email: toStr(r["Email"]),
    company_name: toStr(r["Company Name"]),
    industry: toStr(r["Industry"]),
    assigned_to: toStr(r["Assigned To"]),
    outcome,
    follow_up_date: toDate(r["Follow-up Date"]),
    health_score: toInt(r["Lead Health Score"]),
  }))
}
await insertMany(
  "deals",
  ["lead_code","entry_date","contact_person","email","company_name","industry","assigned_to","outcome","follow_up_date","health_score"],
  [...dealRows("Won Deals", "won"), ...dealRows("Lost Deals", "lost")],
)

// --- Revenue Forecast ---------------------------------------------
await insertMany(
  "revenue_forecast",
  ["forecast_code","forecast_date","quarter","year","expected_revenue","best_case","worst_case","pipeline_coverage","owner"],
  rows("Revenue Forecast").filter((r) => toStr(r["Forecast ID"])).map((r) => ({
    forecast_code: toStr(r["Forecast ID"]),
    forecast_date: toDate(r["Forcast Date"]),
    quarter: toStr(r["Quarter"]),
    year: toInt(r["Year"]),
    expected_revenue: toNum(r["Expected Revenue"]),
    best_case: toNum(r["Best Case"]),
    worst_case: toNum(r["Worst Case"]),
    pipeline_coverage: toStr(r["Pipeline Coverage"]),
    owner: toStr(r["Owner"]),
  })),
)

// --- Outreach (Sales KPIs sheet) ----------------------------------
await insertMany(
  "outreach",
  ["contact_name","email","company_name","designation","owner","subject","personal_intro","company_intro","value_add","status","next_follow_up"],
  rows("Sales KPIs").filter((r) => toStr(r["Email"]) || toStr(r["Contact Name"])).map((r) => ({
    contact_name: toStr(r["Contact Name"]),
    email: toStr(r["Email"]),
    company_name: toStr(r["Company Name"]),
    designation: toStr(r["Designation"]),
    owner: toStr(r["Contact Owner"]),
    subject: toStr(r["Subject"]),
    personal_intro: toStr(r["Personal Intro"]),
    company_intro: toStr(r["Company Intro"]),
    value_add: toStr(r["Value Add"]),
    status: toStr(r["Status"]),
    next_follow_up: toDate(r["Next Follow Up Date"]),
  })),
)

// --- Email Finder --------------------------------------------------
await insertMany(
  "email_finder",
  ["email","verified_email"],
  rows("Email Finder").filter((r) => toStr(r["Email"])).map((r) => ({
    email: toStr(r["Email"]),
    verified_email: toStr(r["__EMPTY"]) ?? toStr(r["Email"]),
  })),
)

await conn.end()
console.log("Import complete.")

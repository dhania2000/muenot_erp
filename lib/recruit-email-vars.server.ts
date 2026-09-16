import { query } from "@/lib/db"

function fmtDate(value: unknown): string {
  if (!value) return ""
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })
}

function fmtDateTime(value: unknown): string {
  if (!value) return ""
  const d = new Date(value as string)
  if (Number.isNaN(d.getTime())) return String(value)
  return d.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function money(amount: unknown, currency: unknown): string {
  if (amount == null || amount === "") return ""
  const n = Number(amount)
  if (Number.isNaN(n)) return String(amount)
  const cur = (currency && String(currency)) || "INR"
  return `${cur} ${n.toLocaleString("en-IN")}`
}

function str(value: unknown): string {
  return value == null ? "" : String(value)
}

/**
 * Resolve every recruitment merge field for one application by walking the
 * unified pipeline. Best-effort per entity: a missing linked record simply
 * leaves those fields blank rather than failing the whole send.
 */
export async function buildRecruitEmailVars(
  applicationId: string | null | undefined,
  fallback?: { candidate_name?: string | null; email?: string | null; job_title?: string | null },
): Promise<Record<string, string>> {
  const vars: Record<string, string> = {}
  // Seed with any known recipient details so ad-hoc emails (no application) still
  // resolve the common placeholders.
  if (fallback?.candidate_name) vars.candidate_name = fallback.candidate_name
  if (fallback?.email) vars.email = fallback.email
  if (fallback?.job_title) vars.job_title = fallback.job_title

  if (!applicationId) return vars

  const [app] = await query<any[]>(
    `SELECT * FROM recruit_applications WHERE application_id = ? LIMIT 1`,
    [applicationId],
  )
  if (!app) return vars

  Object.assign(vars, {
    candidate_name: str(app.candidate_name) || vars.candidate_name || "",
    email: str(app.email) || vars.email || "",
    phone: str(app.phone),
    candidate_location: str(app.location),
    experience: str(app.experience),
    current_company: str(app.current_company),
    expected_salary: str(app.expected_salary),
    source: str(app.source),
    stage: str(app.stage),
    rating: app.rating != null ? String(app.rating) : "",
    application_id: str(app.application_id),
    applied_date: fmtDate(app.applied_at),
    job_title: str(app.job_title) || vars.job_title || "",
  })

  // Job
  if (app.job_id) {
    const [job] = await query<any[]>(
      `SELECT * FROM recruit_jobs WHERE job_id = ? LIMIT 1`,
      [app.job_id],
    )
    if (job) {
      Object.assign(vars, {
        job_title: vars.job_title || str(job.title),
        job_department: str(job.department),
        job_location: str(job.location),
        job_type: str(job.job_type),
        work_mode: str(job.work_mode),
        positions: job.positions != null ? String(job.positions) : "",
        job_experience: str(job.experience),
        salary_range:
          job.salary_from || job.salary_to
            ? `${money(job.salary_from, job.currency)}${job.salary_to ? ` - ${money(job.salary_to, job.currency)}` : ""}`
            : "",
        job_recruiter: str(job.recruiter),
      })
    }
  }

  // Requisition
  if (app.requisition_id) {
    const [req] = await query<any[]>(
      `SELECT * FROM recruitment_requisitions WHERE requisition_id = ? LIMIT 1`,
      [app.requisition_id],
    )
    if (req) {
      Object.assign(vars, {
        requisition_id: str(req.requisition_id),
        requisition_department: str(req.department),
        hiring_manager: str(req.hiring_manager),
        requisition_recruiter: str(req.recruiter),
        priority: str(req.priority),
        target_date: fmtDate(req.target_date),
        employment_type: str(req.employment_type),
      })
    }
  }

  // Interview — prefer the next upcoming, else the most recent.
  const interviews = await query<any[]>(
    `SELECT * FROM recruit_interviews WHERE application_id = ?
     ORDER BY (scheduled_at >= NOW()) DESC,
              CASE WHEN scheduled_at >= NOW() THEN scheduled_at END ASC,
              scheduled_at DESC
     LIMIT 1`,
    [applicationId],
  )
  const iv = interviews[0]
  if (iv) {
    Object.assign(vars, {
      interview_round: str(iv.round),
      interview_mode: str(iv.mode),
      interview_location: str(iv.location),
      interview_datetime: fmtDateTime(iv.scheduled_at),
      interviewer: str(iv.interviewer),
      interview_status: str(iv.status),
    })
  }

  // Offer — latest by creation.
  const offers = await query<any[]>(
    `SELECT * FROM recruit_offers WHERE application_id = ? ORDER BY created_at DESC LIMIT 1`,
    [applicationId],
  )
  const offer = offers[0]
  if (offer) {
    Object.assign(vars, {
      offer_id: str(offer.offer_id),
      offer_salary: money(offer.salary, offer.currency),
      offer_currency: str(offer.currency),
      offer_status: str(offer.status),
      offer_joining_date: fmtDate(offer.joining_date),
      offer_expiry_date: fmtDate(offer.expiry_date),
      // Joining details flow from the accepted offer.
      joining_date: fmtDate(offer.joining_date),
      joining_status:
        str(app.stage) === "hired"
          ? "Joined"
          : offer.status
            ? `Offer ${String(offer.status)}`
            : "",
    })
  }

  return vars
}

import { NextResponse } from "next/server"
import { query } from "@/lib/db"
import type { Job } from "@/lib/recruit-db"

// Public: list open jobs shown on the careers page. No auth.
export async function GET() {
  const jobs = await query<Job[]>(
    `SELECT job_id, public_hash, title, department, location, job_type, work_mode, experience,
            salary_from, salary_to, currency, skills
     FROM recruit_jobs
     WHERE status = 'open' AND show_on_careers = 1
     ORDER BY created_at DESC LIMIT 200`,
  )
  return NextResponse.json({ jobs })
}

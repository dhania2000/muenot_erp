import { NextRequest, NextResponse } from "next/server"
import { getJobByHash, getJobQuestions, createApplication } from "@/lib/recruit-db"

// Public: submit a job application. No auth.
export async function POST(request: NextRequest) {
  const body = await request.json()
  if (!body.hash) return NextResponse.json({ error: "Missing job reference" }, { status: 400 })

  const job = await getJobByHash(body.hash)
  if (!job || job.status !== "open") return NextResponse.json({ error: "This job is no longer accepting applications" }, { status: 404 })

  if (!body.candidate_name?.trim()) return NextResponse.json({ error: "Your name is required" }, { status: 400 })
  if (!body.email?.trim()) return NextResponse.json({ error: "Your email is required" }, { status: 400 })

  // Validate required custom questions.
  const questions = await getJobQuestions(job.job_id)
  const answers = body.answers || {}
  for (const q of questions) {
    if (q.required) {
      const val = answers[String(q.id)]
      const empty = val === undefined || val === null || val === "" || (Array.isArray(val) && val.length === 0)
      if (empty) return NextResponse.json({ error: `Please answer: ${q.question}` }, { status: 400 })
    }
  }

  await createApplication(
    {
      job_id: job.job_id,
      job_title: job.title,
      candidate_name: body.candidate_name,
      email: body.email,
      phone: body.phone,
      location: body.location,
      experience: body.experience,
      current_company: body.current_company,
      expected_salary: body.expected_salary,
      resume_url: body.resume_url,
      cover_letter: body.cover_letter,
      source: "Careers Site",
      stage: "applied",
      answers,
    },
    null,
  )

  return NextResponse.json({ ok: true }, { status: 201 })
}

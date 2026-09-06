import { NextRequest, NextResponse } from "next/server"
import { getJobByHash, getJobQuestions } from "@/lib/recruit-db"

// Public: single job by its public hash + custom questions. No auth.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ hash: string }> }) {
  const { hash } = await params
  const job = await getJobByHash(hash)
  if (!job || job.status !== "open") return NextResponse.json({ error: "Not found" }, { status: 404 })
  const questions = await getJobQuestions(job.job_id)
  return NextResponse.json({ job, questions })
}

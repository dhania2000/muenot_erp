import { NextRequest, NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getJobById, getJobQuestions, updateJob, deleteJob } from "@/lib/recruit-db"

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const job = await getJobById(id)
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 })
  const questions = await getJobQuestions(id)
  return NextResponse.json({ job, questions })
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  const body = await request.json()
  if (!body.title?.trim()) return NextResponse.json({ error: "Job title is required" }, { status: 400 })
  await updateJob(id, body)
  return NextResponse.json({ ok: true })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession()
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  const { id } = await params
  await deleteJob(id)
  return NextResponse.json({ ok: true })
}

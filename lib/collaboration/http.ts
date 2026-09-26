import "server-only"
import { NextResponse } from "next/server"
import { CollabError } from "./model"

export function collabErrorResponse(err: unknown, context: string): NextResponse {
  if (err instanceof CollabError) {
    return NextResponse.json({ error: err.message, fields: err.fields }, { status: err.status })
  }
  console.error(`[collaboration] ${context} failed`, err)
  return NextResponse.json({ error: "Something went wrong" }, { status: 500 })
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    throw new CollabError(400, "Invalid JSON body")
  }
}

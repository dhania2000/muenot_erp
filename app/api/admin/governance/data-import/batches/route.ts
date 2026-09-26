import { NextResponse } from "next/server"
import { createBatchImport, listBatchImports } from "@/lib/data-import-batches-store"
import { adapterCatalogForClient } from "@/lib/import-adapters"
import { batchErrorResponse, batchImportGuard, readIdempotencyKey } from "@/lib/data-import-batches-http"

// Queued, resumable batch imports (100k+ rows). GET lists this tenant's batch
// imports plus the reviewed adapter catalog (Tally / HRMS / CRM). POST creates
// a staged job — idempotent per (tenant, Idempotency-Key): a retried create
// returns the existing job with 200 instead of a duplicate.

export const runtime = "nodejs"
export const maxDuration = 60

export async function GET() {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  try {
    const jobs = await listBatchImports(g.ctx.tenantId)
    return NextResponse.json({ jobs, adapters: adapterCatalogForClient() })
  } catch (err) {
    return batchErrorResponse(err)
  }
}

export async function POST(request: Request) {
  const g = await batchImportGuard()
  if (!g.ok) return g.response
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== "object") return NextResponse.json({ error: "A JSON body is required" }, { status: 400 })
  const idempotencyKey = readIdempotencyKey(request, body)
  if (!idempotencyKey) {
    return NextResponse.json({ error: "An Idempotency-Key (8-120 url-safe characters) is required" }, { status: 400 })
  }
  try {
    const { job, created } = await createBatchImport(g.ctx.tenantId, g.ctx.actor, {
      datasetKey: typeof body.datasetKey === "string" ? body.datasetKey.trim() : undefined,
      adapterKey: typeof body.adapterKey === "string" ? body.adapterKey.trim() : null,
      fileName: typeof body.fileName === "string" ? body.fileName.slice(0, 255) : null,
      headers: body.headers,
      mapping: body.mapping,
      totalRows: body.totalRows,
      batchSize: body.batchSize,
      idempotencyKey,
    })
    return NextResponse.json({ job, created }, { status: created ? 201 : 200 })
  } catch (err) {
    return batchErrorResponse(err)
  }
}

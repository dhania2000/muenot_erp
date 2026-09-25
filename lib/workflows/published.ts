import "server-only"
import type { PoolConnection } from "mysql2/promise"
import { validateWorkflow, type Workflow } from "./model"

const parse = (v: unknown) => typeof v === "string" ? JSON.parse(v) : v

// Runs always execute the *published* version, never an in-progress draft. When a
// published workflow is edited, erp_workflows.definition holds the draft while
// published_version still points at the live snapshot in erp_workflow_versions.
export async function publishedDefinition(c: PoolConnection, tenant: number, row: { id: number; definition: unknown; version?: number | null; published_version?: number | null }): Promise<Workflow> {
  const live = Number(row.published_version || 0), current = Number(row.version || 1)
  if (!live) throw new Error("Workflow is not published; publish it before running")
  if (live === current) return validateWorkflow(parse(row.definition))
  const [result] = await c.query("SELECT definition FROM erp_workflow_versions WHERE tenant_id=? AND workflow_id=? AND version=? LIMIT 1", [tenant, row.id, live])
  const snapshot = (result as any[])[0]
  if (!snapshot) throw new Error("Published version snapshot is missing")
  return validateWorkflow(parse(snapshot.definition))
}

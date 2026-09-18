import { NextResponse } from "next/server"
import { getSession } from "@/lib/auth"
import { getCurrentTenant } from "@/lib/tenant-context"
import { simulateChain } from "@/lib/approval-authority"
import type { ApprovalContext, ApproverTarget } from "@/lib/approval-authority-core"

/** Preview which rule matches a hypothetical request and the resulting chain. */
export async function POST(request: Request) {
  const session = await getSession()
  if (!session || session.role !== "admin") return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  if (!getCurrentTenant()) return NextResponse.json({ error: "Forbidden" }, { status: 403 })

  const body = (await request.json().catch(() => null)) as Partial<ApprovalContext> | null
  if (!body?.moduleKey) return NextResponse.json({ error: "moduleKey is required" }, { status: 400 })

  const { rule, chain } = await simulateChain({
    moduleKey: body.moduleKey,
    amount: body.amount ?? null,
    department: body.department ?? null,
    role: body.role ?? null,
    entityId: body.entityId ?? null,
  })

  // The chain is a flat list of one-approver steps; group them back by level
  // so the UI can show each level's combine-mode and its approver slots.
  const byLevel = new Map<
    number,
    { level: number; levelName: string | null; mode: string; quorum: number | null; approvers: ApproverTarget[] }
  >()
  for (const step of chain) {
    const g =
      byLevel.get(step.levelNo) ??
      { level: step.levelNo, levelName: step.levelName, mode: step.mode, quorum: step.quorum, approvers: [] }
    g.approvers.push(step.target)
    byLevel.set(step.levelNo, g)
  }
  const steps = Array.from(byLevel.values()).sort((a, b) => a.level - b.level)

  return NextResponse.json({
    matchedRule: rule ? { id: rule.id, name: rule.name } : null,
    steps,
    reason: rule ? undefined : "No matching rule — this request would be auto-approved (no configured authority holds it).",
  })
}

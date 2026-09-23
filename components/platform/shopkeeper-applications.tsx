"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"

type Application = {
  id: number; status: "PENDING_APPROVAL" | "APPROVED" | "REJECTED"; businessName: string;
  businessCategory: string; ownerName: string; email: string; mobile: string;
  country: string; state: string | null; city: string; postalCode: string | null;
  submittedAt: string; approvedAt: string | null; rejectedAt: string | null;
  rejectionReason: string | null; tenantId: number | null
}
type Plan = { code: string; name: string }
const tabs = ["Pending", "Approved", "Rejected", "Suspended", "All"] as const

export function ShopkeeperApplications({ applications, plans, suspendedTenantIds }: { applications: Application[]; plans: Plan[]; suspendedTenantIds: number[] }) {
  const router = useRouter()
  const [tab, setTab] = useState<(typeof tabs)[number]>("Pending")
  const [selected, setSelected] = useState<Application | null>(null)
  const [planCode, setPlanCode] = useState(plans[0]?.code ?? "")
  const [trial, setTrial] = useState(false)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)
  const filtered = applications.filter(app => tab === "All" ||
    (tab === "Pending" && app.status === "PENDING_APPROVAL") ||
    (tab === "Approved" && app.status === "APPROVED" && !suspendedTenantIds.includes(app.tenantId ?? -1)) ||
    (tab === "Rejected" && app.status === "REJECTED") ||
    (tab === "Suspended" && app.tenantId != null && suspendedTenantIds.includes(app.tenantId)))

  async function act(action: "approve" | "reject" | "reopen") {
    if (!selected || busy) return
    setBusy(true)
    try {
      const response = await fetch(`/api/platform/shopkeepers/applications/${selected.id}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, planCode, startTrial: trial, reason }),
      })
      const body = await response.json() as { error?: string }
      if (!response.ok) throw new Error(body.error ?? "Could not update application")
      toast.success(`Application ${action === "approve" ? "approved" : action === "reject" ? "rejected" : "reopened"}`)
      setSelected(null); setReason(""); router.refresh()
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not update application") }
    finally { setBusy(false) }
  }

  return <section className="rounded-lg border bg-background p-4 space-y-4">
    <div><h2 className="text-lg font-semibold">Self-registration applications</h2><p className="text-sm text-muted-foreground">Review applications before creating tenant access. Manually created Shopkeepers remain in the directory below.</p></div>
    <div className="flex flex-wrap gap-2">{tabs.map(item => <Button key={item} size="sm" variant={tab === item ? "default" : "outline"} onClick={() => setTab(item)}>{item}</Button>)}</div>
    <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b text-left"><th className="p-2">Business</th><th className="p-2">Category</th><th className="p-2">Owner</th><th className="p-2">Contact</th><th className="p-2">Location</th><th className="p-2">Submitted</th><th className="p-2">Status</th><th className="p-2">Action</th></tr></thead><tbody>
      {filtered.map(app => <tr className="border-b" key={app.id}><td className="p-2 font-medium">{app.businessName}</td><td className="p-2">{app.businessCategory}</td><td className="p-2">{app.ownerName}</td><td className="p-2"><div>{app.email}</div><div>{app.mobile}</div></td><td className="p-2">{[app.city,app.state,app.country].filter(Boolean).join(", ")}</td><td className="p-2">{new Date(app.submittedAt).toLocaleString()}</td><td className="p-2"><Badge variant="secondary">{app.tenantId && suspendedTenantIds.includes(app.tenantId) ? "SUSPENDED" : app.status}</Badge></td><td className="p-2"><Button size="sm" variant="outline" onClick={() => setSelected(app)}>View</Button></td></tr>)}
      {!filtered.length && <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No applications in this view.</td></tr>}
    </tbody></table></div>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open) setSelected(null) }}><DialogContent className="max-h-[90vh] overflow-y-auto"><DialogHeader><DialogTitle>Shopkeeper application</DialogTitle><DialogDescription>Review the application before approval.</DialogDescription></DialogHeader>
      {selected && <div className="space-y-2 text-sm"><p><strong>Business:</strong> {selected.businessName} · {selected.businessCategory}</p><p><strong>Owner:</strong> {selected.ownerName}</p><p><strong>Contact:</strong> {selected.email} · {selected.mobile}</p><p><strong>Location:</strong> {[selected.city,selected.state,selected.postalCode,selected.country].filter(Boolean).join(", ")}</p><p><strong>Submitted:</strong> {new Date(selected.submittedAt).toLocaleString()}</p><p><strong>Status:</strong> {selected.status}</p>{selected.rejectionReason && <p><strong>Rejection reason:</strong> {selected.rejectionReason}</p>}
        {selected.status === "PENDING_APPROVAL" && <><label className="block">Shopkeeper plan<select className="mt-1 w-full rounded-md border bg-background p-2" value={planCode} onChange={event => setPlanCode(event.target.value)}>{plans.map(plan => <option value={plan.code} key={plan.code}>{plan.name}</option>)}</select></label><label className="flex gap-2"><input type="checkbox" checked={trial} onChange={event => setTrial(event.target.checked)} /> Start trial</label><label className="block">Rejection reason (required to reject)<Input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label></>}
      </div>}
      <DialogFooter>{selected?.status === "PENDING_APPROVAL" && <><Button variant="destructive" disabled={busy || reason.trim().length < 3} onClick={() => void act("reject")}>Reject</Button><Button disabled={busy || !planCode} onClick={() => void act("approve")}>Approve</Button></>}{selected?.status === "REJECTED" && <Button disabled={busy} onClick={() => void act("reopen")}>Reopen</Button>}</DialogFooter>
    </DialogContent></Dialog>
  </section>
}

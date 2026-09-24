"use client"

import Link from "next/link"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { Copy, Eye, Loader2, MoreHorizontal, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"

type Shopkeeper = { tenantId: number; businessName: string; ownerName: string | null; ownerEmail: string | null; ownerMobile: string | null; planName: string | null; subscriptionStatus: string | null; accountStatus: string; whatsappConnected: boolean; createdAt: string; lastLoginAt: string | null }
type Plan = { code: string; name: string }
type Form = { businessName: string; displayName: string; businessMobile: string; country: string; timezone: string; currency: string; ownerName: string; ownerEmail: string; ownerMobile: string; planCode: string; generatePassword: boolean; password: string; startTrial: boolean }
type EditForm = { businessName: string; ownerName: string; ownerEmail: string; ownerMobile: string }
type Credentials = { tenantId: number; businessName: string; ownerName: string; ownerEmail: string; password: string; planName: string }

const emptyForm = (planCode = ""): Form => ({ businessName: "", displayName: "", businessMobile: "", country: "", timezone: "UTC", currency: "INR", ownerName: "", ownerEmail: "", ownerMobile: "", planCode, generatePassword: true, password: "", startTrial: false })

export function ShopkeeperManager({ shopkeepers, plans }: { shopkeepers: Shopkeeper[]; plans: Plan[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<Form>(emptyForm(plans[0]?.code))
  const [pending, setPending] = useState(false)
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm((current) => ({ ...current, [key]: value }))
  const submit = async () => {
    if (pending) return
    setPending(true)
    try {
      const response = await fetch("/api/platform/shopkeepers", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) })
      const body: { shopkeeper?: Credentials; error?: string; fieldErrors?: { message: string }[] } = await response.json()
      if (!response.ok || !body.shopkeeper) { toast.error(body.fieldErrors?.[0]?.message ?? body.error ?? "Could not create shopkeeper"); return }
      setCredentials(body.shopkeeper); setOpen(false); setForm(emptyForm(plans[0]?.code)); router.refresh(); toast.success("Shopkeeper created")
    } catch { toast.error("Network error — please try again") } finally { setPending(false) }
  }
  const setStatus = async (id: number, status: "active" | "suspended") => {
    if (pending) return
    setPending(true)
    try { const response = await fetch(`/api/platform/shopkeepers/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }); const body: { error?: string } = await response.json(); if (!response.ok) throw new Error(body.error); toast.success(`Shopkeeper ${status}`); router.refresh() } catch (error) { toast.error(error instanceof Error ? error.message : "Could not update account") } finally { setPending(false) }
  }
  const copyCredentials = async () => { if (!credentials) return; await navigator.clipboard.writeText(`Email: ${credentials.ownerEmail}\nPassword: ${credentials.password}`); toast.success("Login details copied") }
  const [editing, setEditing] = useState<Shopkeeper | null>(null)
  const [editForm, setEditForm] = useState<EditForm>({ businessName: "", ownerName: "", ownerEmail: "", ownerMobile: "" })
  const openEdit = (shop: Shopkeeper) => { setEditing(shop); setEditForm({ businessName: shop.businessName ?? "", ownerName: shop.ownerName ?? "", ownerEmail: shop.ownerEmail ?? "", ownerMobile: shop.ownerMobile ?? "" }) }
  const updateEdit = <K extends keyof EditForm>(key: K, value: EditForm[K]) => setEditForm((current) => ({ ...current, [key]: value }))
  const saveEdit = async () => {
    if (pending || !editing) return
    setPending(true)
    try {
      const response = await fetch(`/api/platform/shopkeepers/${editing.tenantId}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(editForm) })
      const body: { error?: string; fieldErrors?: { message: string }[] } = await response.json()
      if (!response.ok) { toast.error(body.fieldErrors?.[0]?.message ?? body.error ?? "Could not update shopkeeper"); return }
      setEditing(null); router.refresh(); toast.success("Shopkeeper updated")
    } catch { toast.error("Network error — please try again") } finally { setPending(false) }
  }
  const [deleting, setDeleting] = useState<Shopkeeper | null>(null)
  const confirmDelete = async () => {
    if (pending || !deleting) return
    setPending(true)
    try {
      const response = await fetch(`/api/platform/shopkeepers/${deleting.tenantId}`, { method: "DELETE" })
      const body: { error?: string } = await response.json()
      if (!response.ok) { toast.error(body.error ?? "Could not delete shopkeeper"); return }
      setDeleting(null); router.refresh(); toast.success("Shopkeeper deleted")
    } catch { toast.error("Network error — please try again") } finally { setPending(false) }
  }
  return <div className="flex flex-col gap-4">
    <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => router.refresh()} disabled={pending}><RefreshCw data-icon="inline-start" /> Refresh</Button><Button onClick={() => setOpen(true)}><Plus data-icon="inline-start" /> Add Shopkeeper</Button></div>
    <div className="overflow-hidden rounded-lg border bg-background"><Table><TableHeader><TableRow><TableHead>Shop / owner</TableHead><TableHead>Contact</TableHead><TableHead>Plan</TableHead><TableHead>Status</TableHead><TableHead>WhatsApp</TableHead><TableHead>Created</TableHead><TableHead className="text-right">Actions</TableHead></TableRow></TableHeader><TableBody>{shopkeepers.length ? shopkeepers.map((shop) => <TableRow key={shop.tenantId}><TableCell><Link className="font-medium hover:underline" href={`/platform/shopkeepers/${shop.tenantId}`}>{shop.businessName}</Link><div className="text-xs text-muted-foreground">{shop.ownerName || "No owner"} · #{shop.tenantId}</div></TableCell><TableCell><div className="text-sm">{shop.ownerEmail || "—"}</div><div className="text-xs text-muted-foreground">{shop.ownerMobile || "—"}</div></TableCell><TableCell><div>{shop.planName || "—"}</div><div className="text-xs capitalize text-muted-foreground">{shop.subscriptionStatus || "—"}</div></TableCell><TableCell><Badge variant={shop.accountStatus === "active" ? "default" : "destructive"} className="capitalize">{shop.accountStatus}</Badge></TableCell><TableCell><Badge variant="secondary">{shop.whatsappConnected ? "Connected" : "Not connected"}</Badge></TableCell><TableCell className="text-sm text-muted-foreground">{new Date(shop.createdAt).toLocaleDateString()}</TableCell><TableCell className="text-right"><DropdownMenu><DropdownMenuTrigger render={<Button size="icon" variant="ghost" disabled={pending} aria-label={`Actions for ${shop.businessName}`} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem render={<Link href={`/platform/shopkeepers/${shop.tenantId}`} />}><Eye data-icon="inline-start" /> View details</DropdownMenuItem><DropdownMenuItem onClick={() => openEdit(shop)}><Pencil data-icon="inline-start" /> Edit details</DropdownMenuItem><DropdownMenuItem onClick={() => setStatus(shop.tenantId, shop.accountStatus === "active" ? "suspended" : "active")}>{shop.accountStatus === "active" ? "Suspend account" : "Activate account"}</DropdownMenuItem><DropdownMenuSeparator /><DropdownMenuItem variant="destructive" onClick={() => setDeleting(shop)}><Trash2 data-icon="inline-start" /> Delete shopkeeper</DropdownMenuItem></DropdownMenuContent></DropdownMenu></TableCell></TableRow>) : <TableRow><TableCell colSpan={7} className="h-24 text-center text-muted-foreground">No Shopkeeper tenants yet.</TableCell></TableRow>}</TableBody></Table></div>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Add Shopkeeper</DialogTitle><DialogDescription>Creates the tenant, owner login, subscription, and entitlements atomically.</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2">{([['businessName','Shop / business name'],['displayName','Business display name'],['businessMobile','Business mobile'],['country','Country'],['timezone','Timezone'],['currency','Currency'],['ownerName','Owner full name'],['ownerEmail','Owner email'],['ownerMobile','Owner mobile']] as const).map(([key, label]) => <label key={key} className="flex flex-col gap-2 text-sm font-medium">{label}<Input type={key === 'ownerEmail' ? 'email' : 'text'} value={form[key]} onChange={(event) => update(key, event.target.value)} required={['businessName','ownerName','ownerEmail'].includes(key)} /></label>)}<label className="flex flex-col gap-2 text-sm font-medium">Plan<select className="h-9 rounded-md border bg-background px-3 text-sm" value={form.planCode} onChange={(event) => update('planCode', event.target.value)} required>{plans.map((plan) => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select></label><label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.startTrial} onChange={(event) => update('startTrial', event.target.checked)} /> Start trial when supported</label><label className="flex items-center gap-2 text-sm sm:col-span-2"><input type="checkbox" checked={form.generatePassword} onChange={(event) => update('generatePassword', event.target.checked)} /> Generate secure temporary password</label>{!form.generatePassword && <label className="flex flex-col gap-2 text-sm font-medium">Initial password<Input type="password" value={form.password} onChange={(event) => update('password', event.target.value)} required /></label>}</div><DialogFooter><Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>Cancel</Button><Button onClick={submit} disabled={pending || !form.planCode}>{pending && <Loader2 className="animate-spin" data-icon="inline-start" />} Create Shopkeeper</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(credentials)} onOpenChange={(value) => !value && setCredentials(null)}><DialogContent><DialogHeader><DialogTitle>Shopkeeper Created Successfully</DialogTitle><DialogDescription>Save these credentials now. The password will not be shown again.</DialogDescription></DialogHeader>{credentials && <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4 text-sm"><p><strong>Business:</strong> {credentials.businessName}</p><p><strong>Owner:</strong> {credentials.ownerName}</p><p><strong>Login email:</strong> {credentials.ownerEmail}</p><p><strong>Temporary password:</strong> <code>{credentials.password}</code></p><p><strong>Tenant:</strong> {credentials.tenantId}</p><p><strong>Plan:</strong> {credentials.planName}</p></div>}<DialogFooter><Button onClick={copyCredentials}><Copy data-icon="inline-start" /> Copy login details</Button><Button variant="outline" onClick={() => setCredentials(null)}>Done</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(editing)} onOpenChange={(value) => !value && setEditing(null)}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Edit shopkeeper</DialogTitle><DialogDescription>Update the shop and owner details for {editing?.businessName}.</DialogDescription></DialogHeader><div className="grid gap-4 sm:grid-cols-2">{([['businessName','Shop / business name'],['ownerName','Owner full name'],['ownerEmail','Owner email'],['ownerMobile','Owner mobile']] as const).map(([key, label]) => <label key={key} className="flex flex-col gap-2 text-sm font-medium">{label}<Input type={key === 'ownerEmail' ? 'email' : 'text'} value={editForm[key]} onChange={(event) => updateEdit(key, event.target.value)} required={key !== 'ownerMobile'} /></label>)}</div><DialogFooter><Button variant="outline" onClick={() => setEditing(null)} disabled={pending}>Cancel</Button><Button onClick={saveEdit} disabled={pending}>{pending && <Loader2 data-icon="inline-start" className="animate-spin" />} Save changes</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={Boolean(deleting)} onOpenChange={(value) => !value && setDeleting(null)}><DialogContent><DialogHeader><DialogTitle>Delete shopkeeper</DialogTitle><DialogDescription>This permanently removes {deleting?.businessName} — its owner login, profile, and subscription. This cannot be undone. Shopkeepers that already have business data must be deactivated instead.</DialogDescription></DialogHeader><DialogFooter><Button variant="outline" onClick={() => setDeleting(null)} disabled={pending}>Cancel</Button><Button variant="destructive" onClick={confirmDelete} disabled={pending}>{pending && <Loader2 data-icon="inline-start" className="animate-spin" />} Delete permanently</Button></DialogFooter></DialogContent></Dialog>
  </div>
}

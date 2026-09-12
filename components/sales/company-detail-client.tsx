"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { formatDateTime, formatDate } from "@/lib/utils"
import { inr0 } from "@/lib/finance-calc"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { CompanyDialog } from "@/components/sales/company-dialog"
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  CalendarClock,
  FileSignature,
  FileText,
  Globe,
  Handshake,
  Mail,
  MapPin,
  Phone,
  Plus,
  Rocket,
  Star,
  Target,
  Trash2,
  User,
} from "lucide-react"

type CompanyData = {
  company: Record<string, any>
  contacts: any[]
  leads: any[]
  meetings: any[]
  quotations: any[]
  contracts: any[]
  onboarding: any[]
  timeline: any[]
  stats: Record<string, number>
}

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  New: "outline",
  Contacted: "secondary",
  Qualified: "secondary",
  Customer: "default",
  Inactive: "outline",
  Lost: "destructive",
}

function currency(value: any) {
  const n = Number(value)
  if (!value || Number.isNaN(n)) return "—"
  return inr0(n)
}

export function CompanyDetailClient({ id, canManage }: { id: number; canManage: boolean }) {
  const router = useRouter()
  const key = `/api/sales/companies/${id}`
  const { data, isLoading, mutate } = useSWR<CompanyData>(key, fetcher)

  const [editOpen, setEditOpen] = useState(false)
  const [contactOpen, setContactOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)

  if (isLoading || !data) {
    return <div className="text-sm text-muted-foreground">Loading company...</div>
  }

  const { company, contacts, leads, meetings, quotations, contracts, onboarding, timeline, stats } = data
  const status = company.status || "New"
  const isArchived = Boolean(company.archived_at)

  async function archive() {
    const res = await fetch(key, { method: "DELETE" })
    if (res.ok) {
      toast.success("Company archived")
      router.push("/modules/sales/companies")
    } else {
      toast.error("Unable to archive company")
    }
  }

  async function restore() {
    const res = await fetch(key, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "restore" }),
    })
    if (res.ok) {
      toast.success("Company restored")
      mutate()
    } else {
      toast.error("Unable to restore company")
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4">
        <Link
          href="/modules/sales/companies"
          className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back to companies
        </Link>
        <div className="flex flex-col gap-4 rounded-lg border border-border bg-card p-5 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xl font-semibold tracking-tight text-balance">{company.company_name}</h2>
              <Badge variant={STATUS_VARIANT[status] || "outline"}>{status}</Badge>
              {company.priority && <Badge variant="outline">{company.priority}</Badge>}
              {isArchived && <Badge variant="destructive">Archived</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {company.company_code}
              {company.industry ? ` · ${company.industry}` : ""}
              {company.company_type ? ` · ${company.company_type}` : ""}
            </p>
            {company.merged_into_name && (
              <p className="text-xs text-muted-foreground">Merged into {company.merged_into_name}</p>
            )}
          </div>
          {canManage && (
            <div className="flex flex-wrap items-center gap-2">
              {!isArchived ? (
                <>
                  <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setContactOpen(true)}>
                    <Plus data-icon="inline-start" /> Contact
                  </Button>
                  <Button variant="destructive" size="sm" onClick={() => setArchiveOpen(true)}>
                    <Trash2 data-icon="inline-start" /> Archive
                  </Button>
                </>
              ) : (
                <Button size="sm" onClick={restore}>
                  Restore
                </Button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
        <StatCard label="Open pipeline" value={currency(stats.openPipeline)} icon={Target} />
        <StatCard label="Won value" value={currency(stats.wonValue)} icon={Handshake} />
        <StatCard label="Contract value" value={currency(stats.contractValue)} icon={FileSignature} />
        <StatCard label="Leads" value={`${stats.wonLeads}/${stats.leads}`} sub="won / total" icon={Building2} />
        <StatCard label="Contacts" value={String(stats.contacts)} icon={User} />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left: profile */}
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Company details</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3 text-sm">
              <InfoRow icon={Building2} label="Legal name" value={company.legal_name} />
              <InfoRow icon={Globe} label="Website" value={company.website} href={company.website} />
              <InfoRow icon={Mail} label="Email" value={company.company_email} />
              <InfoRow icon={Phone} label="Phone" value={company.phone} />
              <InfoRow
                icon={MapPin}
                label="Location"
                value={[company.city, company.state, company.country].filter(Boolean).join(", ")}
              />
              <InfoRow icon={Target} label="Source" value={company.source} />
              <InfoRow icon={User} label="Account owner" value={company.assigned_to_name || "Unassigned"} />
              <InfoRow
                icon={CalendarClock}
                label="First contact"
                value={company.first_contact_date ? formatDate(company.first_contact_date) : null}
              />
              {company.tags && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {String(company.tags)
                    .split(",")
                    .map((t: string) => t.trim())
                    .filter(Boolean)
                    .map((t: string) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))}
                </div>
              )}
              {company.description && (
                <div className="rounded-md bg-muted p-3 text-muted-foreground">{company.description}</div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right: tabs */}
        <div className="lg:col-span-2">
          <Tabs defaultValue="overview">
            <TabsList className="flex-wrap">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="contacts">
                Contacts{contacts.length > 0 && <Badge variant="secondary" className="ml-1.5">{contacts.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="leads">
                Leads{leads.length > 0 && <Badge variant="secondary" className="ml-1.5">{leads.length}</Badge>}
              </TabsTrigger>
              <TabsTrigger value="deals">Deals</TabsTrigger>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="flex flex-col gap-4 pt-4">
              <LinkedSection
                title="Meetings"
                icon={CalendarClock}
                items={meetings}
                render={(m) => ({
                  href: `/modules/sales/meetings/${m.id}`,
                  primary: m.meeting_code + (m.meeting_type ? ` · ${m.meeting_type}` : ""),
                  secondary: `${m.meeting_date ? formatDate(m.meeting_date) : ""}${m.contact_person ? ` · ${m.contact_person}` : ""}`,
                })}
              />
              <LinkedSection
                title="Quotations"
                icon={FileText}
                items={quotations}
                render={(q) => ({
                  href: `/modules/sales/quotations/${q.id}`,
                  primary: q.quote_code + (q.opportunity_name ? ` · ${q.opportunity_name}` : ""),
                  secondary: `${currency(q.total_amount)}${q.status ? ` · ${q.status}` : ""}`,
                })}
              />
              <LinkedSection
                title="Contracts"
                icon={FileSignature}
                items={contracts}
                render={(c) => ({
                  href: `/modules/sales/contracts/${c.id}`,
                  primary: c.contract_code + (c.contract_type ? ` · ${c.contract_type}` : ""),
                  secondary: `${currency(c.value)}${c.status ? ` · ${c.status}` : ""}`,
                })}
              />
              <LinkedSection
                title="Onboarding"
                icon={Rocket}
                items={onboarding}
                render={(o) => ({
                  href: `/modules/sales/onboarding/${o.id}`,
                  primary: o.onboarding_code + (o.current_stage ? ` · ${o.current_stage}` : ""),
                  secondary: o.status || "",
                })}
              />
            </TabsContent>

            <TabsContent value="contacts" className="flex flex-col gap-3 pt-4">
              {canManage && (
                <div className="flex justify-end">
                  <Button size="sm" variant="outline" onClick={() => setContactOpen(true)}>
                    <Plus data-icon="inline-start" /> Add contact
                  </Button>
                </div>
              )}
              <ContactsList contacts={contacts} companyId={id} canManage={canManage} onChanged={mutate} />
            </TabsContent>

            <TabsContent value="leads" className="pt-4">
              <LeadsList leads={leads} />
            </TabsContent>

            <TabsContent value="deals" className="flex flex-col gap-4 pt-4">
              <LinkedSection
                title="Quotations"
                icon={FileText}
                items={quotations}
                render={(q) => ({
                  href: `/modules/sales/quotations/${q.id}`,
                  primary: q.quote_code + (q.opportunity_name ? ` · ${q.opportunity_name}` : ""),
                  secondary: `${currency(q.total_amount)}${q.status ? ` · ${q.status}` : ""}`,
                })}
              />
              <LinkedSection
                title="Contracts"
                icon={FileSignature}
                items={contracts}
                render={(c) => ({
                  href: `/modules/sales/contracts/${c.id}`,
                  primary: c.contract_code + (c.contract_type ? ` · ${c.contract_type}` : ""),
                  secondary: `${currency(c.value)}${c.status ? ` · ${c.status}` : ""}`,
                })}
              />
            </TabsContent>

            <TabsContent value="timeline" className="pt-4">
              <TimelineList timeline={timeline} />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <CompanyDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        company={company as any}
        onSaved={() => {
          setEditOpen(false)
          toast.success("Company updated")
          mutate()
        }}
      />
      <ContactDialog
        open={contactOpen}
        onOpenChange={setContactOpen}
        companyId={id}
        onDone={() => {
          setContactOpen(false)
          mutate()
        }}
      />
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this company?</AlertDialogTitle>
            <AlertDialogDescription>
              The account and all its linked history are kept but hidden from the active list. You can restore it
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={archive}>Archive</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
}: {
  label: string
  value: string
  sub?: string
  icon: typeof Target
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-4">
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5" /> {label}
        </span>
        <span className="text-lg font-semibold">{value}</span>
        {sub && <span className="text-xs text-muted-foreground">{sub}</span>}
      </CardContent>
    </Card>
  )
}

function InfoRow({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof User
  label: string
  value: any
  href?: string
}) {
  const display = value || "—"
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Icon className="size-3.5" /> {label}
      </span>
      {href && value ? (
        <a
          href={href.startsWith("http") ? href : `https://${href}`}
          target="_blank"
          rel="noopener noreferrer"
          className="truncate text-right font-medium hover:underline"
        >
          {display}
        </a>
      ) : (
        <span className="truncate text-right font-medium">{display}</span>
      )}
    </div>
  )
}

function LinkedSection({
  title,
  icon: Icon,
  items,
  render,
}: {
  title: string
  icon: typeof Target
  items: any[]
  render: (item: any) => { href: string; primary: string; secondary: string }
}) {
  return (
    <Card>
      <CardHeader className="flex-row items-center gap-2 space-y-0">
        <Icon className="size-4 text-muted-foreground" />
        <CardTitle className="text-base">{title}</CardTitle>
        <Badge variant="secondary" className="ml-auto">
          {items.length}
        </Badge>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">None linked yet.</p>
        ) : (
          <div className="flex flex-col">
            {items.map((item) => {
              const r = render(item)
              return (
                <Link
                  key={item.id}
                  href={r.href}
                  className="flex items-center justify-between gap-3 border-b border-border py-2.5 text-sm last:border-b-0 hover:text-foreground"
                >
                  <div className="flex flex-col">
                    <span className="font-medium">{r.primary}</span>
                    {r.secondary && <span className="text-xs text-muted-foreground">{r.secondary}</span>}
                  </div>
                  <ArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
                </Link>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function LeadsList({ leads }: { leads: any[] }) {
  if (leads.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No leads linked to this company.</p>
  }
  return (
    <div className="rounded-md border border-border">
      {leads.map((l) => (
        <Link
          key={l.id}
          href={`/modules/sales/leads/${l.id}`}
          className="flex items-center justify-between gap-3 border-b border-border p-3 text-sm last:border-b-0 hover:bg-muted/50"
        >
          <div className="flex flex-col">
            <span className="font-medium">
              {l.lead_code}
              {l.contact_person ? ` · ${l.contact_person}` : ""}
            </span>
            <span className="text-xs text-muted-foreground">
              {l.assigned_to_name || "Unassigned"}
              {l.estimated_value ? ` · ${currency(l.estimated_value)}` : ""}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <Badge variant="outline">{l.status}</Badge>
            {l.lead_status && <Badge variant="secondary">{l.lead_status}</Badge>}
          </div>
        </Link>
      ))}
    </div>
  )
}

function ContactsList({
  contacts,
  companyId,
  canManage,
  onChanged,
}: {
  contacts: any[]
  companyId: number
  canManage: boolean
  onChanged: () => void
}) {
  async function remove(contactId: number) {
    const res = await fetch(`/api/sales/companies/${companyId}/contacts/${contactId}`, { method: "DELETE" })
    if (res.ok) {
      toast.success("Contact removed")
      onChanged()
    } else {
      toast.error("Unable to remove contact")
    }
  }

  async function makePrimary(contactId: number) {
    const res = await fetch(`/api/sales/companies/${companyId}/contacts/${contactId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_primary: true }),
    })
    if (res.ok) onChanged()
  }

  if (contacts.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No contacts yet.</p>
  }
  return (
    <div className="flex flex-col gap-2">
      {contacts.map((c) => (
        <div key={c.id} className="flex items-center justify-between gap-3 rounded-md border border-border p-3">
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-2 text-sm font-medium">
              {c.name}
              {c.is_primary ? (
                <Badge variant="default" className="gap-1">
                  <Star className="size-3" /> Primary
                </Badge>
              ) : null}
              {c.title && <span className="text-xs font-normal text-muted-foreground">{c.title}</span>}
            </span>
            <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
              {c.email && <span>{c.email}</span>}
              {c.phone && <span>{c.phone}</span>}
            </span>
          </div>
          {canManage && (
            <div className="flex shrink-0 items-center gap-1.5">
              {!c.is_primary && (
                <Button size="sm" variant="ghost" onClick={() => makePrimary(c.id)}>
                  Set primary
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => remove(c.id)}>
                <Trash2 className="size-4" />
              </Button>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function TimelineList({ timeline }: { timeline: any[] }) {
  if (timeline.length === 0) {
    return <p className="py-8 text-center text-sm text-muted-foreground">No activity recorded yet.</p>
  }
  return (
    <ol className="flex flex-col">
      {timeline.map((event, i) => (
        <li key={event.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
              <FileText className="size-4" />
            </span>
            {i < timeline.length - 1 && <span className="w-px flex-1 bg-border" />}
          </div>
          <div className="flex flex-col gap-0.5 pb-6">
            <span className="text-sm font-medium">{event.summary || event.action}</span>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(event.created_at)}
              {event.actor_name ? ` · ${event.actor_name}` : ""}
            </span>
          </div>
        </li>
      ))}
    </ol>
  )
}

function ContactDialog({
  open,
  onOpenChange,
  companyId,
  onDone,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  companyId: number
  onDone: () => void
}) {
  const [form, setForm] = useState<Record<string, any>>({ is_primary: false })
  const [saving, setSaving] = useState(false)

  function set(key: string, value: any) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function submit() {
    if (!form.name?.trim()) {
      toast.error("Contact name is required")
      return
    }
    setSaving(true)
    const res = await fetch(`/api/sales/companies/${companyId}/contacts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (res.ok) {
      toast.success("Contact added")
      setForm({ is_primary: false })
      onDone()
    } else {
      toast.error("Unable to add contact")
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add contact</DialogTitle>
          <DialogDescription>Add a person who works at this company.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field className="sm:col-span-2">
            <FieldLabel>Name</FieldLabel>
            <Input value={form.name || ""} onChange={(e) => set("name", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Title</FieldLabel>
            <Input value={form.title || ""} onChange={(e) => set("title", e.target.value)} />
          </Field>
          <Field>
            <FieldLabel>Phone</FieldLabel>
            <Input value={form.phone || ""} onChange={(e) => set("phone", e.target.value)} />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>Email</FieldLabel>
            <Input type="email" value={form.email || ""} onChange={(e) => set("email", e.target.value)} />
          </Field>
          <Field className="sm:col-span-2">
            <FieldLabel>Notes</FieldLabel>
            <Textarea rows={2} value={form.notes || ""} onChange={(e) => set("notes", e.target.value)} />
          </Field>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox
              checked={form.is_primary}
              onCheckedChange={(v) => set("is_primary", Boolean(v))}
            />
            Primary contact
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={saving}>
            Add contact
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

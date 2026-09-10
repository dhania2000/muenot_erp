"use client"

import { useState } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
  DialogClose,
} from "@/components/ui/dialog"
import { Plus, Search, Users, UserCheck, Mail } from "lucide-react"
import { MarketingHeader, StatCard } from "@/components/marketing/marketing-shared"

type Contact = {
  id: string
  name: string
  email: string
  company: string
  segment: string
  status: "Subscribed" | "Unsubscribed" | "Lead"
}

const SEED: Contact[] = [
  { id: "C-1024", name: "Aarav Mehta", email: "aarav@novacorp.io", company: "NovaCorp", segment: "Enterprise", status: "Subscribed" },
  { id: "C-1025", name: "Priya Sharma", email: "priya@brightlabs.com", company: "BrightLabs", segment: "SMB", status: "Lead" },
  { id: "C-1026", name: "Rohan Gupta", email: "rohan@finedge.co", company: "FinEdge", segment: "Enterprise", status: "Subscribed" },
  { id: "C-1027", name: "Sara Khan", email: "sara@pixelwave.design", company: "PixelWave", segment: "Agency", status: "Subscribed" },
  { id: "C-1028", name: "Vikram Rao", email: "vikram@shopnest.in", company: "ShopNest", segment: "SMB", status: "Unsubscribed" },
  { id: "C-1029", name: "Neha Verma", email: "neha@cloudspire.io", company: "CloudSpire", segment: "Enterprise", status: "Lead" },
]

const STATUS_VARIANT: Record<Contact["status"], "default" | "secondary" | "outline"> = {
  Subscribed: "default",
  Lead: "secondary",
  Unsubscribed: "outline",
}

export function MarketingContactsClient() {
  const [contacts, setContacts] = useState<Contact[]>(SEED)
  const [q, setQ] = useState("")
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({ name: "", email: "", company: "", segment: "" })

  const filtered = contacts.filter((c) =>
    [c.name, c.email, c.company, c.segment].join(" ").toLowerCase().includes(q.toLowerCase()),
  )

  function add() {
    if (!form.name || !form.email) return
    setContacts((prev) => [
      {
        id: `C-${1030 + prev.length}`,
        name: form.name,
        email: form.email,
        company: form.company || "—",
        segment: form.segment || "General",
        status: "Lead",
      },
      ...prev,
    ])
    setForm({ name: "", email: "", company: "", segment: "" })
    setOpen(false)
  }

  const subscribed = contacts.filter((c) => c.status === "Subscribed").length

  return (
    <main className="flex flex-col gap-6 p-6">
      <MarketingHeader
        eyebrow="Marketing"
        title="Contacts"
        description="Your marketing audience of subscribers, leads, and known accounts, organised by segment."
        action={
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger
              render={
                <Button>
                  <Plus className="size-4" />
                  Add Contact
                </Button>
              }
            />
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Add Contact</DialogTitle>
              </DialogHeader>
              <div className="grid gap-4 py-2">
                {(
                  [
                    ["name", "Full name"],
                    ["email", "Email address"],
                    ["company", "Company"],
                    ["segment", "Segment"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key} className="flex flex-col gap-1.5">
                    <Label htmlFor={key} className="text-xs text-muted-foreground">
                      {label}
                    </Label>
                    <Input
                      id={key}
                      value={form[key]}
                      onChange={(e) => setForm({ ...form, [key]: e.target.value })}
                    />
                  </div>
                ))}
              </div>
              <DialogFooter>
                <DialogClose render={<Button variant="outline">Cancel</Button>} />
                <Button onClick={add}>Save contact</Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <StatCard label="Total Contacts" value={contacts.length.toLocaleString()} icon={Users} />
        <StatCard label="Subscribed" value={subscribed} icon={UserCheck} />
        <StatCard label="Deliverability" value="98.2%" hint="Healthy list" icon={Mail} />
      </div>

      <Card>
        <CardContent className="pt-6">
          <div className="relative mb-4 max-w-sm">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search contacts..."
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="pl-8"
            />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="pb-3 font-medium">Contact</th>
                  <th className="pb-3 font-medium">Company</th>
                  <th className="pb-3 font-medium">Segment</th>
                  <th className="pb-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-muted-foreground">
                      No contacts match your search.
                    </td>
                  </tr>
                )}
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-3">
                      <div className="font-medium">{c.name}</div>
                      <div className="text-xs text-muted-foreground">{c.email}</div>
                    </td>
                    <td className="py-3 text-muted-foreground">{c.company}</td>
                    <td className="py-3">
                      <Badge variant="outline">{c.segment}</Badge>
                    </td>
                    <td className="py-3">
                      <Badge variant={STATUS_VARIANT[c.status]}>{c.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}

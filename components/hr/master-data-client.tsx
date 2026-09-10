"use client"
import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Award, Download, Mail } from "lucide-react"

const sections = {
  departments: { label: "Departments", fields: ["department_id", "department_name", "parent_department_id", "head_employee_id", "description", "status"] },
  designations: { label: "Designations", fields: ["designation_id", "designation_name", "parent_designation_id", "level_name", "description", "status"] },
  promotions: { label: "Promotions", fields: ["employee_id", "effective_date", "old_designation_id", "new_designation_id", "old_department_id", "new_department_id", "old_grade", "new_grade", "old_salary", "new_salary", "reason", "approved_by", "approver_name", "status"] },
  awards: { label: "Awards", fields: ["employee_id", "award_name", "award_date", "given_by", "description", "badge_url", "status"] },
  appreciations: { label: "Appreciations", fields: ["employee_id", "title", "message", "given_by", "appreciation_date", "category", "status"] },
  "passport-visa": { label: "Passport Visa", fields: ["employee_id", "passport_number", "passport_issue_date", "passport_expiry_date", "visa_type", "visa_number", "visa_issue_date", "visa_expiry_date", "country", "status", "remarks"] },
  holidays: { label: "Holidays", fields: ["holiday_name", "holiday_date", "holiday_type", "applicable_department_id", "applicable_state_ut", "optional", "description", "status", "year"] },
} as const

type Kind = keyof typeof sections
const CERT_KINDS = new Set<Kind>(["awards", "appreciations"])
const idKeyFor = (kind: Kind) => (kind === "awards" ? "award_id" : "appreciation_id")
const titleFor = (kind: Kind, row: any) => (kind === "awards" ? row.award_name : row.title)

type MailTarget = { kind: Kind; id: number; name: string; title: string; email: string }

export function MasterDataClient({ initialKind = "departments" }: { initialKind?: Kind }) {
  const [kind, setKind] = useState<Kind>(initialKind)
  const [form, setForm] = useState<Record<string, string>>({})
  const c = sections[kind]
  const { data, mutate } = useSWR<any>(`/api/hr/master-data?kind=${kind}`, fetcher)

  const showCert = CERT_KINDS.has(kind)

  // Email dialog state
  const [mail, setMail] = useState<MailTarget | null>(null)
  const [subject, setSubject] = useState("")
  const [message, setMessage] = useState("")
  const [to, setTo] = useState("")
  const [sending, setSending] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  async function save() {
    await fetch("/api/hr/master-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, ...form }),
    })
    setForm({})
    mutate()
  }

  function openMail(row: any) {
    const label = kind === "awards" ? "Certificate of Excellence" : "Certificate of Appreciation"
    const title = titleFor(kind, row)
    const name = row.employee_name || `Employee #${row.employee_id}`
    setMail({ kind, id: row[idKeyFor(kind)], name, title, email: row.employee_email || "" })
    setTo(row.employee_email || "")
    setSubject(`${label} — ${title}`)
    setMessage(
      `Dear ${name},\n\nPlease find attached your ${label.toLowerCase()} for "${title}". Congratulations and thank you for your contribution.`,
    )
    setFeedback(null)
  }

  async function sendMail() {
    if (!mail) return
    setSending(true)
    setFeedback(null)
    try {
      const res = await fetch("/api/hr/master-data/certificate/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: mail.kind, id: mail.id, to, subject, message }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setFeedback(json.error || "Failed to send email.")
      } else {
        setFeedback(null)
        setMail(null)
      }
    } finally {
      setSending(false)
    }
  }

  function certUrl(row: any, download = false) {
    const q = `kind=${kind}&id=${row[idKeyFor(kind)]}${download ? "&download=1" : ""}`
    return `/api/hr/master-data/certificate?${q}`
  }

  return (
    <main className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">HR Master Data</h1>
        <p className="text-muted-foreground">
          Manage promotions, recognition, travel documents, holidays, departments and designations.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {Object.entries(sections).map(([key, v]) => (
          <Button key={key} variant={key === kind ? "default" : "outline"} onClick={() => setKind(key as Kind)}>
            {v.label}
          </Button>
        ))}
      </div>

      <section className="rounded-xl border bg-card p-5">
        <div className="grid gap-3 md:grid-cols-3">
          {c.fields.map((f) => (
            <Input
              key={f}
              placeholder={f.replaceAll("_", " ")}
              value={form[f] || ""}
              onChange={(e) => setForm({ ...form, [f]: e.target.value })}
            />
          ))}
        </div>
        <Button className="mt-4" onClick={save}>
          Add {c.label.slice(0, -1)}
        </Button>
      </section>

      {showCert && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Award className="size-4" />
          Generate a certificate PDF or email it to the employee using the actions on each row.
        </p>
      )}

      <section className="overflow-auto rounded-xl border">
        <table className="w-full text-sm">
          <thead>
            <tr>
              {c.fields.map((f) => (
                <th className="whitespace-nowrap p-3 text-left font-medium" key={f}>
                  {f}
                </th>
              ))}
              {showCert && <th className="whitespace-nowrap p-3 text-right font-medium">Certificate</th>}
            </tr>
          </thead>
          <tbody>
            {(data?.rows || []).map((row: any, i: number) => (
              <tr
                className="border-t"
                key={
                  row.department_id ||
                  row.designation_id ||
                  row.promotion_id ||
                  row.award_id ||
                  row.appreciation_id ||
                  row.record_id ||
                  row.holiday_id ||
                  i
                }
              >
                {c.fields.map((f) => (
                  <td className="whitespace-nowrap p-3" key={f}>
                    {String(row[f] ?? "—")}
                  </td>
                ))}
                {showCert && (
                  <td className="whitespace-nowrap p-3">
                    <div className="flex items-center justify-end gap-2">
                      <a
                        href={certUrl(row)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center rounded-md border px-3 text-xs font-medium hover:bg-accent hover:text-accent-foreground"
                      >
                        <Download className="mr-1 size-3.5" />
                        PDF
                      </a>
                      <Button size="sm" onClick={() => openMail(row)}>
                        <Mail className="mr-1 size-3.5" />
                        Email
                      </Button>
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <Dialog open={!!mail} onOpenChange={(o) => !o && setMail(null)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Email certificate</DialogTitle>
            <DialogDescription>
              {mail ? `Send the certificate PDF for "${mail.title}" to ${mail.name}.` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="cert-to">To</Label>
              <Input
                id="cert-to"
                type="email"
                placeholder="recipient@company.com"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-subject">Subject</Label>
              <Input id="cert-subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cert-message">Message</Label>
              <Textarea id="cert-message" rows={6} value={message} onChange={(e) => setMessage(e.target.value)} />
            </div>
            {feedback && <p className="text-sm text-destructive">{feedback}</p>}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMail(null)} disabled={sending}>
              Cancel
            </Button>
            <Button onClick={sendMail} disabled={sending || !to.trim()}>
              {sending ? "Sending…" : "Send certificate"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  )
}

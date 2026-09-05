"use client"
import { useEffect, useMemo, useRef, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ArrowLeft, FileSignature, Printer } from "lucide-react"
import { LETTER_TYPES, LETTER_PLACEHOLDERS } from "@/lib/hr-letters"

type Template = { id: number; name: string; letter_type: string; subject: string; body: string; status: string }
type Employee = { id: number; employee_id: string; employee_name: string; designation: string; department: string }

const today = () => new Date().toISOString().slice(0, 10)
const emptyForm = {
  employee_id: "",
  template_id: "",
  letter_type: "Offer Letter",
  subject: "",
  body: "",
  issue_date: today(),
  status: "Draft",
}

export function GenerateLetterCreateClient() {
  const router = useRouter()
  const { data: employeeData } = useSWR<{ employees: Employee[] }>("/api/hr/employees", fetcher)
  const { data: templateData } = useSWR<{ templates: Template[] }>("/api/hr/letter-templates", fetcher)

  const [form, setForm] = useState(emptyForm)
  const [rendered, setRendered] = useState<{ subject: string; body: string }>({ subject: "", body: "" })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  const employees = employeeData?.employees || []
  const templates = (templateData?.templates || []).filter((t) => t.status === "Active")
  const selectedEmployee = useMemo(
    () => employees.find((e) => String(e.id) === form.employee_id) || null,
    [employees, form.employee_id],
  )

  function applyTemplate(value: string | null) {
    const id = value || ""
    const t = templates.find((x) => String(x.id) === id)
    setForm((f) => ({
      ...f,
      template_id: id,
      letter_type: t?.letter_type ?? f.letter_type,
      subject: t?.subject ?? f.subject,
      body: t?.body ?? f.body,
    }))
  }
  function insertToken(token: string) {
    setForm((f) => ({ ...f, body: `${f.body}${token}` }))
  }

  // Debounced server-side merge preview — company settings stay server-only.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!form.subject && !form.body) {
      setRendered({ subject: "", body: "" })
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      const res = await fetch("/api/hr/letters/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employee_id: form.employee_id || null, subject: form.subject, body: form.body }),
      })
      if (res.ok) {
        const data = await res.json()
        setRendered({ subject: data.subject, body: data.body })
      }
    }, 350)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [form.subject, form.body, form.employee_id])

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setSaving(true)
    const res = await fetch("/api/hr/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    })
    setSaving(false)
    if (res.ok) {
      router.push("/modules/hr/letters/generate")
      router.refresh()
    } else {
      setError((await res.json().catch(() => ({}))).error || "Failed to generate letter")
    }
  }

  function printPreview() {
    const w = window.open("", "_blank")
    if (!w) return
    w.document.write(
      `<html><head><title>${rendered.subject || "Letter"}</title><style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px;color:#111;line-height:1.7}h2{font-size:18px}.meta{color:#555;font-size:13px;margin-bottom:24px}.body{white-space:pre-wrap}</style></head><body><h2>${rendered.subject}</h2><div class="meta">Date: ${form.issue_date}</div><div class="body">${rendered.body.replace(/</g, "&lt;")}</div></body></html>`,
    )
    w.document.close()
    w.focus()
    w.print()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/modules/hr/letters/generate"
            className="mb-2 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            Back to letters
          </Link>
          <div className="flex items-center gap-3">
            <FileSignature className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Generate Letter</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick an employee and a template, adjust the content, and preview the merged letter live before generating.
          </p>
        </div>
      </div>

      <form onSubmit={save} className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Editor */}
        <div className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Employee</Label>
              <Select value={form.employee_id} onValueChange={(v) => setForm({ ...form, employee_id: v || "" })}>
                <SelectTrigger>
                  <SelectValue placeholder="Select employee" />
                </SelectTrigger>
                <SelectContent>
                  {employees.map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.employee_id} · {e.employee_name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Template</Label>
              <Select value={form.template_id} onValueChange={applyTemplate}>
                <SelectTrigger>
                  <SelectValue placeholder="Start blank" />
                </SelectTrigger>
                <SelectContent>
                  {templates.map((t) => (
                    <SelectItem key={t.id} value={String(t.id)}>
                      {t.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <div className="grid gap-2">
              <Label>Letter type</Label>
              <Select
                value={form.letter_type}
                onValueChange={(v) => setForm({ ...form, letter_type: v || "Offer Letter" })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LETTER_TYPES.map((x) => (
                    <SelectItem key={x} value={x}>
                      {x}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Issue date</Label>
              <Input
                type="date"
                value={form.issue_date}
                onChange={(e) => setForm({ ...form, issue_date: e.target.value })}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label>Subject</Label>
            <Input
              value={form.subject}
              onChange={(e) => setForm({ ...form, subject: e.target.value })}
              placeholder="e.g. Offer of Employment — {{designation}}"
              required
            />
          </div>

          <div className="grid gap-2">
            <Label>Body</Label>
            <Textarea
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
              rows={12}
              placeholder="Dear {{employee_name}}, …"
              required
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {LETTER_PLACEHOLDERS.map((p) => (
                <button
                  type="button"
                  key={p.token}
                  onClick={() => insertToken(p.token)}
                  className="rounded border bg-muted px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
                  title={p.label}
                >
                  {p.token}
                </button>
              ))}
            </div>
          </div>

          <div className="grid gap-2 md:w-1/2">
            <Label>Status</Label>
            <Select value={form.status} onValueChange={(v) => setForm({ ...form, status: v || "Draft" })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="Draft">Draft</SelectItem>
                <SelectItem value="Issued">Issued</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button type="submit" disabled={saving || !form.employee_id}>
              <FileSignature data-icon="inline-start" />
              {saving ? "Generating…" : "Generate letter"}
            </Button>
            <Link href="/modules/hr/letters/generate" className={buttonVariants({ variant: "outline" })}>
              Cancel
            </Link>
          </div>
        </div>

        {/* Live preview */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Live preview</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={printPreview}
              disabled={!rendered.body}
            >
              <Printer data-icon="inline-start" />
              Print
            </Button>
          </div>
          <div className="min-h-[600px] rounded-lg border bg-muted/30 p-4">
            <div className="mx-auto max-w-[640px] rounded-md bg-background p-8 shadow-sm ring-1 ring-border">
              {selectedEmployee && (
                <div className="mb-6 border-b pb-4 text-xs text-muted-foreground">
                  <div className="font-medium text-foreground">{selectedEmployee.employee_name}</div>
                  <div>
                    {selectedEmployee.designation}
                    {selectedEmployee.department ? ` · ${selectedEmployee.department}` : ""}
                  </div>
                  <div className="mt-1">Date: {form.issue_date}</div>
                </div>
              )}
              {rendered.subject && (
                <h2 className="mb-4 font-serif text-lg font-semibold text-foreground">{rendered.subject}</h2>
              )}
              {rendered.body ? (
                <div className="whitespace-pre-wrap font-serif text-sm leading-relaxed text-foreground">
                  {rendered.body}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  Choose a template or start typing to see the merged letter here.
                </p>
              )}
            </div>
          </div>
        </div>
      </form>
    </div>
  )
}

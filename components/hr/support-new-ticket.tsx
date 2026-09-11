"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { toast } from "sonner"

const PRIORITIES = ["Low", "Medium", "High", "Urgent"]

type Category = {
  id: number
  name: string
  slug: string
  default_priority: string
  is_sensitive: number
}

type Context = {
  canManage: boolean
  employee: {
    id: number
    employee_id: string
    employee_name: string
    department: string | null
    designation: string | null
    reporting_manager: string | null
  } | null
  categories: Category[]
  recentRegularisations: any[]
  recentLeaves: any[]
  employees: { id: number; employee_id: string; employee_name: string; department: string | null }[]
}

export function SupportNewTicket({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: () => void
}) {
  const { data: ctx } = useSWR<Context>(open ? "/api/hr/support/context" : null, fetcher)
  const [category, setCategory] = useState("")
  const [priority, setPriority] = useState("Medium")
  const [subject, setSubject] = useState("")
  const [description, setDescription] = useState("")
  const [subcategory, setSubcategory] = useState("")
  const [onBehalf, setOnBehalf] = useState("")
  const [linkReg, setLinkReg] = useState("")
  const [linkLeave, setLinkLeave] = useState("")
  const [attachment, setAttachment] = useState<{ path: string; name: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const categories = ctx?.categories || []
  const selectedCategory = useMemo(() => categories.find((c) => c.name === category), [categories, category])

  const reset = () => {
    setCategory(""); setPriority("Medium"); setSubject(""); setDescription("")
    setSubcategory(""); setOnBehalf(""); setLinkReg(""); setLinkLeave(""); setAttachment(null)
  }

  const onCategoryChange = (value: string) => {
    setCategory(value)
    const cat = categories.find((c) => c.name === value)
    if (cat) setPriority(cat.default_priority)
  }

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const fd = new FormData()
      fd.append("file", file)
      const res = await fetch("/api/hr/support/upload", { method: "POST", body: fd })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Upload failed")
      setAttachment({ path: body.pathname, name: file.name })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!category || !subject.trim() || !description.trim()) {
      toast.error("Category, subject and description are required")
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch("/api/hr/support", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          support_category: category,
          priority,
          subject: subject.trim(),
          description: description.trim(),
          subcategory: subcategory.trim() || undefined,
          employee_id: ctx?.canManage && onBehalf ? Number(onBehalf) : undefined,
          related_regularisation_id: linkReg ? Number(linkReg) : undefined,
          related_leave_id: linkLeave ? Number(linkLeave) : undefined,
          attachment_path: attachment?.path,
          attachment_name: attachment?.name,
        }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || "Could not create ticket")
      toast.success(`Ticket ${body.ticket_id} created`)
      reset()
      onOpenChange(false)
      onCreated()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raise a support ticket</DialogTitle>
          <DialogDescription>
            {ctx?.employee
              ? `Raising as ${ctx.employee.employee_name} · ${ctx.employee.department || "No department"}`
              : "Your request will be routed to the HR helpdesk."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="grid gap-4">
          {ctx?.canManage && (
            <div className="grid gap-2">
              <Label>Raise on behalf of (optional)</Label>
              <Select value={onBehalf} onValueChange={setOnBehalf}>
                <SelectTrigger><SelectValue placeholder="Myself" /></SelectTrigger>
                <SelectContent>
                  {(ctx?.employees || []).map((e) => (
                    <SelectItem key={e.id} value={String(e.id)}>
                      {e.employee_name} · {e.employee_id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Category</Label>
              <Select value={category} onValueChange={onCategoryChange}>
                <SelectTrigger><SelectValue placeholder="Select a category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.name}>
                      {c.name}{c.is_sensitive ? " · Confidential" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map((p) => <SelectItem key={p} value={p}>{p}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>

          {selectedCategory?.is_sensitive ? (
            <p className="rounded-md bg-muted px-3 py-2 text-xs text-muted-foreground">
              This is a confidential case. It is only visible to authorised HR staff.
            </p>
          ) : null}

          <div className="grid gap-2">
            <Label>Subject</Label>
            <Input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Short summary of the issue" maxLength={200} />
          </div>

          <div className="grid gap-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Explain the issue in detail" rows={5} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label>Sub-type (optional)</Label>
              <Input value={subcategory} onChange={(e) => setSubcategory(e.target.value)} placeholder="e.g. Salary discrepancy" />
            </div>
            <div className="grid gap-2">
              <Label>Attachment (optional)</Label>
              <Input type="file" disabled={uploading} onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              {attachment ? <span className="truncate text-xs text-muted-foreground">{attachment.name}</span> : null}
            </div>
          </div>

          {(ctx?.recentRegularisations?.length || ctx?.recentLeaves?.length) ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {ctx?.recentRegularisations?.length ? (
                <div className="grid gap-2">
                  <Label>Link a regularisation (optional)</Label>
                  <Select value={linkReg} onValueChange={setLinkReg}>
                    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      {ctx.recentRegularisations.map((r) => (
                        <SelectItem key={r.id} value={String(r.id)}>
                          {r.request_id} · {String(r.work_date).slice(0, 10)} · {r.status}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
              {ctx?.recentLeaves?.length ? (
                <div className="grid gap-2">
                  <Label>Link a leave (optional)</Label>
                  <Select value={linkLeave} onValueChange={setLinkLeave}>
                    <SelectTrigger><SelectValue placeholder="None" /></SelectTrigger>
                    <SelectContent>
                      {ctx.recentLeaves.map((l) => (
                        <SelectItem key={l.id} value={String(l.id)}>
                          {l.leave_id} · {l.leave_type} · {l.status}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null}
            </div>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button type="submit" disabled={submitting || uploading}>{submitting ? "Creating…" : "Create ticket"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

"use client"
import { useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button, buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { FilePlus2, Eye, Printer, Trash2, Search, FileSignature } from "lucide-react"

type Letter = {
  id: number
  letter_number: string
  employee_name: string
  employee_code: string
  designation: string
  department: string
  letter_type: string
  subject: string
  body: string
  issue_date: string
  status: string
}

function printLetter(l: Letter) {
  const w = window.open("", "_blank")
  if (!w) return
  w.document.write(
    `<html><head><title>${l.letter_number}</title><style>body{font-family:Georgia,serif;max-width:760px;margin:40px auto;padding:0 24px;color:#111;line-height:1.7}h2{font-size:18px}.meta{color:#555;font-size:13px;margin-bottom:24px}.body{white-space:pre-wrap}</style></head><body><h2>${l.subject}</h2><div class="meta">Ref: ${l.letter_number} &nbsp;•&nbsp; Date: ${l.issue_date}</div><div class="body">${l.body.replace(/</g, "&lt;")}</div></body></html>`,
  )
  w.document.close()
  w.focus()
  w.print()
}

export function GenerateLettersClient() {
  const { data, mutate } = useSWR<{ letters: Letter[] }>("/api/hr/letters", fetcher)
  const [preview, setPreview] = useState<Letter | null>(null)
  const [q, setQ] = useState("")

  const letters = (data?.letters || []).filter((l) => {
    if (!q.trim()) return true
    const hay = `${l.letter_number} ${l.employee_name} ${l.employee_code} ${l.letter_type} ${l.subject}`.toLowerCase()
    return hay.includes(q.toLowerCase())
  })

  async function remove(id: number) {
    if (!confirm("Delete this letter?")) return
    await fetch(`/api/hr/letters?id=${id}`, { method: "DELETE" })
    mutate()
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <FileSignature className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Generate Letter</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate letters for employees from a template. Placeholders merge with employee and company details.
          </p>
        </div>
        <Link href="/modules/hr/letters/generate/create" className={buttonVariants()}>
          <FilePlus2 data-icon="inline-start" />
          Generate Letter
        </Link>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search letters…" className="pl-9" />
      </div>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              {["Ref", "Employee", "Type", "Subject", "Issued", "Status", ""].map((x) => (
                <th key={x} className="px-4 py-3 font-medium">
                  {x}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {letters.map((l) => (
              <tr key={l.id} className="border-b last:border-0">
                <td className="px-4 py-3 font-mono text-xs">{l.letter_number}</td>
                <td className="px-4 py-3">
                  <div className="font-medium">{l.employee_name}</div>
                  <div className="text-xs text-muted-foreground">{l.employee_code}</div>
                </td>
                <td className="px-4 py-3">{l.letter_type}</td>
                <td className="px-4 py-3 text-muted-foreground">{l.subject}</td>
                <td className="px-4 py-3">{l.issue_date}</td>
                <td className="px-4 py-3">
                  <Badge variant={l.status === "Issued" ? "default" : "secondary"}>{l.status}</Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setPreview(l)} aria-label="Preview letter">
                      <Eye className="size-4" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => printLetter(l)} aria-label="Print letter">
                      <Printer className="size-4" />
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => remove(l.id)} aria-label="Delete letter">
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {data && letters.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-10 text-center text-muted-foreground">
                  {q ? "No letters match your search." : "No letters generated yet. Click “Generate Letter” to create one."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Dialog open={!!preview} onOpenChange={(v) => !v && setPreview(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{preview?.subject}</DialogTitle>
          </DialogHeader>
          {preview && (
            <div className="grid gap-4">
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                <span>
                  Ref: <span className="font-mono">{preview.letter_number}</span>
                </span>
                <span>Employee: {preview.employee_name}</span>
                <span>Date: {preview.issue_date}</span>
              </div>
              <div className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-5 font-serif text-sm leading-relaxed">
                {preview.body}
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setPreview(null)}>
                  Close
                </Button>
                <Button onClick={() => printLetter(preview)}>
                  <Printer data-icon="inline-start" />
                  Print
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

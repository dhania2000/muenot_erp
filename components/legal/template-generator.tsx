"use client"

import { useMemo, useState } from "react"
import { ArrowLeft, Download, FileText, Search } from "lucide-react"
import {
  type AgreementTemplate,
  type AgreementValues,
  agreementCategories,
  agreementTemplates,
  defaultValues,
  generateAgreementText,
  totalTemplates,
} from "@/lib/legal/agreement-templates"

const partyTypes = ["Company", "Individual", "Partnership", "LLP", "Trust", "Government Body"]

type FieldDef = { name: keyof AgreementValues; label: string; type?: "text" | "date" | "select"; options?: string[]; full?: boolean }

const fieldDefs: FieldDef[] = [
  { name: "effectiveDate", label: "Effective date", type: "date" },
  { name: "governingLaw", label: "Governing jurisdiction (e.g. India / State of Delaware)" },
  { name: "party1Name", label: "First party — name" },
  { name: "party1Type", label: "First party — type", type: "select", options: partyTypes },
  { name: "party1Address", label: "First party — address", full: true },
  { name: "party2Name", label: "Second party — name" },
  { name: "party2Type", label: "Second party — type", type: "select", options: partyTypes },
  { name: "party2Address", label: "Second party — address", full: true },
  { name: "term", label: "Term / duration (e.g. 12 months)" },
  { name: "consideration", label: "Fees / consideration (e.g. USD 10,000 per month)", full: true },
]

export function TemplateGenerator() {
  const [query, setQuery] = useState("")
  const [category, setCategory] = useState<string>("All")
  const [selected, setSelected] = useState<AgreementTemplate | null>(null)
  const [values, setValues] = useState<AgreementValues>(defaultValues)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return agreementTemplates.filter((t) => {
      const inCategory = category === "All" || t.category === category
      const inQuery =
        !q || t.name.toLowerCase().includes(q) || t.blurb.toLowerCase().includes(q) || t.category.toLowerCase().includes(q)
      return inCategory && inQuery
    })
  }, [query, category])

  const previewText = useMemo(
    () => (selected ? generateAgreementText(selected, values) : ""),
    [selected, values],
  )

  function update(name: keyof AgreementValues, value: string) {
    setValues((prev) => ({ ...prev, [name]: value }))
  }

  async function downloadPdf() {
    if (!selected) return
    const { jsPDF } = await import("jspdf")
    const doc = new jsPDF({ unit: "pt", format: "a4" })
    const marginX = 56
    const marginTop = 64
    const marginBottom = 56
    const pageWidth = doc.internal.pageSize.getWidth()
    const pageHeight = doc.internal.pageSize.getHeight()
    const maxWidth = pageWidth - marginX * 2
    let y = marginTop

    const lines = previewText.split("\n")

    const writeParagraph = (text: string, opts: { size: number; bold?: boolean; gap: number }) => {
      doc.setFont("times", opts.bold ? "bold" : "normal")
      doc.setFontSize(opts.size)
      if (text.trim() === "") {
        y += opts.gap
        return
      }
      const wrapped = doc.splitTextToSize(text, maxWidth) as string[]
      const lineHeight = opts.size * 1.35
      for (const w of wrapped) {
        if (y + lineHeight > pageHeight - marginBottom) {
          doc.addPage()
          y = marginTop
        }
        doc.text(w, marginX, y)
        y += lineHeight
      }
      y += opts.gap
    }

    lines.forEach((line, i) => {
      if (i === 0) {
        writeParagraph(line, { size: 16, bold: true, gap: 10 })
        return
      }
      const isHeading = /^\d+\.\s/.test(line)
      const isEmphasis = /^(IN WITNESS|NOW, THEREFORE)/.test(line)
      writeParagraph(line, {
        size: isHeading ? 12 : 11,
        bold: isHeading || isEmphasis,
        gap: line.trim() === "" ? 6 : 4,
      })
    })

    doc.save(`${selected.id}.pdf`)
  }

  if (selected) {
    return (
      <main className="space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <button
              onClick={() => setSelected(null)}
              className="mt-1 inline-flex size-9 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted"
              aria-label="Back to template library"
            >
              <ArrowLeft className="size-4" />
            </button>
            <div>
              <p className="text-sm text-muted-foreground">{selected.category}</p>
              <h1 className="text-2xl font-semibold tracking-tight text-balance">{selected.name}</h1>
              <p className="mt-1 max-w-xl text-sm text-muted-foreground text-pretty">{selected.blurb}</p>
            </div>
          </div>
          <button
            onClick={downloadPdf}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Download className="size-4" />
            Download PDF
          </button>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
          <section className="space-y-4 rounded-xl border border-border bg-card p-5">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Agreement details</h2>
            <div className="grid gap-3">
              {fieldDefs.map((f) => (
                <label key={f.name} className={`flex flex-col gap-1.5 ${f.full ? "" : ""}`}>
                  <span className="text-xs font-medium text-muted-foreground">{f.label}</span>
                  {f.type === "select" ? (
                    <select
                      value={values[f.name]}
                      onChange={(e) => update(f.name, e.target.value)}
                      className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    >
                      {f.options?.map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === "date" ? "date" : "text"}
                      value={values[f.name]}
                      onChange={(e) => update(f.name, e.target.value)}
                      className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
                    />
                  )}
                </label>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">Live preview</h2>
              <span className="text-xs text-muted-foreground">A4 · updates as you type</span>
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-6">
              <article className="mx-auto max-w-[640px] whitespace-pre-wrap font-serif text-[13px] leading-relaxed text-foreground">
                {previewText}
              </article>
            </div>
          </section>
        </div>
      </main>
    )
  }

  return (
    <main className="space-y-6">
      <div className="flex items-start gap-3">
        <span className="flex size-11 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <FileText className="size-5" />
        </span>
        <div>
          <p className="text-sm text-muted-foreground">Legal workspace</p>
          <h1 className="text-2xl font-semibold tracking-tight">Agreement Templates</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Generate a fully drafted legal agreement and download it as a PDF. {totalTemplates} templates available.
          </p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-56">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search agreements (MSA, NDA, SOW, lease...)"
            className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded-md border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="All">All categories</option>
          {agreementCategories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>

      <p className="text-xs text-muted-foreground">
        Showing {filtered.length} of {totalTemplates} templates
      </p>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center text-sm text-muted-foreground">
          No templates match your search.
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setSelected(t)
                setValues(defaultValues)
              }}
              className="group flex h-full flex-col rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
            >
              <span className="mb-2 inline-flex w-fit rounded-full bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
                {t.category}
              </span>
              <span className="font-medium leading-snug text-pretty">{t.name}</span>
              <span className="mt-1.5 text-sm text-muted-foreground text-pretty">{t.blurb}</span>
              <span className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                <FileText className="size-3.5" />
                Draft &amp; download
              </span>
            </button>
          ))}
        </div>
      )}
    </main>
  )
}

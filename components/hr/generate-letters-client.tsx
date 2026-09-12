"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { buttonVariants } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { LetterStatusBadge } from "@/components/hr/letter-status-badge"
import { LetterDetailDialog } from "@/components/hr/letter-detail-dialog"
import { FileSignature, Search, ArrowRight, Sparkles, FileText, Clock } from "lucide-react"
import { eventByKey, type GeneratedLetter, type LetterTemplate } from "@/lib/hr-letters-shared"

type LetterRow = GeneratedLetter & { event_key?: string }

const CREATE = "/modules/hr/letters/generate/create"

export function GenerateLettersClient() {
  const { data: templateData } = useSWR<{ templates: LetterTemplate[] }>("/api/hr/letter-templates", fetcher)
  const { data: letterData, mutate } = useSWR<{ letters: LetterRow[] }>("/api/hr/letters", fetcher)
  const [q, setQ] = useState("")
  const [selected, setSelected] = useState<number | null>(null)

  const templates = useMemo(
    () => (templateData?.templates || []).filter((t) => t.status === "Active"),
    [templateData],
  )
  const filtered = useMemo(() => {
    if (!q.trim()) return templates
    const hay = q.toLowerCase()
    return templates.filter((t) =>
      `${t.name} ${t.letter_type} ${t.category} ${t.description ?? ""} ${eventByKey(t.event_key).label}`
        .toLowerCase()
        .includes(hay),
    )
  }, [templates, q])

  const recent = (letterData?.letters || []).slice(0, 6)

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-3">
            <FileSignature className="size-7 text-primary" />
            <h1 className="text-2xl font-semibold">Generate Letter</h1>
          </div>
          <p className="mt-1 text-sm text-muted-foreground text-pretty">
            Pick a template to start, or generate an ad-hoc letter. Placeholders merge live with the selected employee,
            event record, and company details.
          </p>
        </div>
        <Link href={CREATE} className={buttonVariants()}>
          <Sparkles data-icon="inline-start" />
          Blank letter
        </Link>
      </div>

      {/* Templates */}
      <section className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium text-muted-foreground">Start from a template</h2>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search templates…" className="pl-9" />
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="rounded-lg border border-dashed bg-card px-4 py-12 text-center">
            <FileText className="mx-auto mb-3 size-8 text-muted-foreground/60" />
            <p className="text-sm text-muted-foreground">
              {templates.length === 0 ? (
                <>
                  No active templates yet.{" "}
                  <Link href="/modules/hr/letter-templates" className="text-primary underline-offset-4 hover:underline">
                    Create one
                  </Link>{" "}
                  to speed up generation.
                </>
              ) : (
                "No templates match your search."
              )}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map((t) => (
              <Link
                key={t.id}
                href={`${CREATE}?template=${t.id}`}
                className="group flex flex-col gap-3 rounded-lg border bg-card p-4 transition-colors hover:border-primary/50 hover:bg-accent/40"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-foreground text-pretty">{t.name}</span>
                  <ArrowRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
                </div>
                {t.description && (
                  <p className="line-clamp-2 text-xs text-muted-foreground">{t.description}</p>
                )}
                <div className="mt-auto flex flex-wrap gap-1.5">
                  <Badge variant="secondary" className="font-normal">
                    {t.letter_type}
                  </Badge>
                  <Badge variant="outline" className="font-normal">
                    {eventByKey(t.event_key).label}
                  </Badge>
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* Recent */}
      {recent.length > 0 && (
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
              <Clock className="size-4" /> Recently generated
            </h2>
            <Link
              href="/modules/hr/letters"
              className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              View all
            </Link>
          </div>
          <div className="overflow-x-auto rounded-lg border bg-card">
            <table className="w-full min-w-[640px] text-sm">
              <tbody>
                {recent.map((l) => (
                  <tr
                    key={l.id}
                    onClick={() => setSelected(l.id)}
                    className="cursor-pointer border-b transition-colors last:border-0 hover:bg-accent/50"
                  >
                    <td className="px-4 py-3 font-mono text-xs">{l.letter_number}</td>
                    <td className="px-4 py-3 font-medium">{l.recipient_name || l.employee_name || "—"}</td>
                    <td className="px-4 py-3 text-muted-foreground">{l.letter_type}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-muted-foreground">{l.issue_date}</td>
                    <td className="px-4 py-3">
                      <LetterStatusBadge status={l.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <LetterDetailDialog
        letterId={selected}
        onClose={() => setSelected(null)}
        onChanged={() => mutate()}
        onSelectLetter={(id) => setSelected(id)}
      />
    </div>
  )
}

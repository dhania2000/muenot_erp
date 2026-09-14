"use client"

import * as React from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { RefreshCw, Plus, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"
import { NativeSelect, TabState } from "./shared"
import type { WhatsAppTemplate, WhatsAppCaps } from "./types"

const STATUS_STYLE: Record<string, string> = {
  APPROVED: "border-transparent bg-[#25D366] text-white",
  PENDING: "border-transparent bg-amber-500 text-white",
  REJECTED: "border-transparent bg-destructive text-white",
  DISABLED: "border-transparent bg-muted-foreground text-white",
}

const CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"] as const

/** Common WhatsApp template locales; kept short and practical for our users. */
const LANGUAGES = [
  { code: "en_US", label: "English (US)" },
  { code: "en_GB", label: "English (UK)" },
  { code: "hi", label: "Hindi" },
  { code: "en", label: "English" },
]

function bodyText(t: WhatsAppTemplate): string {
  const comps = (t.components ?? []) as { type?: string; text?: string }[]
  const body = comps.find((c) => (c.type ?? "").toUpperCase() === "BODY")
  return body?.text ?? ""
}

/** Ordered, unique {{n}} placeholder numbers found in the body text. */
function placeholderNumbers(text: string): number[] {
  const found = new Set<number>()
  for (const m of text.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) found.add(Number(m[1]))
  return [...found].sort((a, b) => a - b)
}

/**
 * Dialog that lets an employee author a template and submit it to Meta for
 * review directly from the ERP — no Meta Business Manager login required. The
 * server (POST /templates) validates and forwards it to the Graph API.
 */
function CreateTemplateDialog({ onCreated }: { onCreated: () => void }) {
  const [open, setOpen] = React.useState(false)
  const [saving, setSaving] = React.useState(false)
  const [name, setName] = React.useState("")
  const [category, setCategory] = React.useState<(typeof CATEGORIES)[number]>("UTILITY")
  const [language, setLanguage] = React.useState("en_US")
  const [header, setHeader] = React.useState("")
  const [body, setBody] = React.useState("")
  const [footer, setFooter] = React.useState("")
  const [examples, setExamples] = React.useState<Record<number, string>>({})

  const placeholders = React.useMemo(() => placeholderNumbers(body), [body])

  function reset() {
    setName("")
    setCategory("UTILITY")
    setLanguage("en_US")
    setHeader("")
    setBody("")
    setFooter("")
    setExamples({})
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (saving) return

    const cleanName = name.trim().toLowerCase().replace(/\s+/g, "_")
    if (!/^[a-z0-9_]+$/.test(cleanName)) {
      toast.error("Name may only contain lowercase letters, numbers and underscores.")
      return
    }
    if (!body.trim()) {
      toast.error("The template body is required.")
      return
    }
    const bodyExamples = placeholders.map((n) => (examples[n] ?? "").trim())
    if (placeholders.length > 0 && bodyExamples.some((v) => !v)) {
      toast.error("Provide a sample value for every {{n}} variable.")
      return
    }

    setSaving(true)
    try {
      const res = await fetch("/api/marketing/whatsapp/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: cleanName,
          category,
          language,
          headerText: header.trim() || undefined,
          bodyText: body.trim(),
          footerText: footer.trim() || undefined,
          bodyExamples,
        }),
      })
      const data = (await res.json().catch(() => ({}))) as { status?: string; error?: string }
      if (!res.ok) {
        toast.error(data.error || "Failed to create template.")
        return
      }
      toast.success(
        `Template submitted to Meta${data.status ? ` (${data.status})` : ""}. It will be usable once approved.`,
      )
      reset()
      setOpen(false)
      onCreated()
    } catch (err) {
      toast.error((err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v)
        if (!v) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="size-4" /> Create template
          </Button>
        }
      />
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>Create template</DialogTitle>
            <DialogDescription>
              Author a template here and it is submitted to Meta for review automatically — no Meta login needed. It
              becomes sendable once Meta approves it.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="tpl-name">Name</Label>
            <Input
              id="tpl-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="order_update"
              autoComplete="off"
              required
            />
            <p className="text-xs text-muted-foreground">Lowercase letters, numbers and underscores only.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="tpl-category">Category</Label>
              <NativeSelect
                id="tpl-category"
                value={category}
                onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number])}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c.charAt(0) + c.slice(1).toLowerCase()}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="tpl-language">Language</Label>
              <NativeSelect id="tpl-language" value={language} onChange={(e) => setLanguage(e.target.value)}>
                {LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </NativeSelect>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="tpl-header">Header (optional)</Label>
            <Input
              id="tpl-header"
              value={header}
              onChange={(e) => setHeader(e.target.value)}
              placeholder="Order confirmation"
              maxLength={60}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="tpl-body">Body</Label>
            <Textarea
              id="tpl-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={"Hi {{1}}, your order {{2}} has been shipped."}
              rows={4}
              required
            />
            <p className="text-xs text-muted-foreground">
              {"Use {{1}}, {{2}} … for variables. Provide a sample value for each below."}
            </p>
          </div>

          {placeholders.length > 0 ? (
            <div className="grid gap-2 rounded-md border border-border p-3">
              <p className="text-sm font-medium">Variable samples</p>
              {placeholders.map((n) => (
                <div key={n} className="grid gap-1.5">
                  <Label htmlFor={`tpl-example-${n}`} className="text-xs text-muted-foreground">
                    {`Example for {{${n}}}`}
                  </Label>
                  <Input
                    id={`tpl-example-${n}`}
                    value={examples[n] ?? ""}
                    onChange={(e) => setExamples((prev) => ({ ...prev, [n]: e.target.value }))}
                    placeholder={n === 1 ? "Ravi" : "sample"}
                  />
                </div>
              ))}
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor="tpl-footer">Footer (optional)</Label>
            <Input
              id="tpl-footer"
              value={footer}
              onChange={(e) => setFooter(e.target.value)}
              placeholder="Muenot Technologies"
              maxLength={60}
            />
          </div>

          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline" disabled={saving}>
                  Cancel
                </Button>
              }
            />
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Submit to Meta
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** Template catalog synced from the WABA, plus in-app authoring for employees. */
export function TemplatesTab({ caps }: { caps: WhatsAppCaps | null }) {
  const { data, isLoading, error, mutate } = useSWR<{ templates: WhatsAppTemplate[]; error?: string }>(
    "/api/marketing/whatsapp/templates",
    fetcher,
  )

  const templates = data?.templates ?? []

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {templates.length} template{templates.length === 1 ? "" : "s"} synced from Meta. Only approved templates can be
          sent.
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => mutate()}>
            <RefreshCw className="size-4" /> Sync from Meta
          </Button>
          {caps?.canSendTemplates ? <CreateTemplateDialog onCreated={() => mutate()} /> : null}
        </div>
      </div>

      {isLoading ? (
        <TabState loading>Loading templates…</TabState>
      ) : error || (data && "error" in data && data.error) ? (
        <TabState>Could not load templates. Check the connection in Settings.</TabState>
      ) : templates.length === 0 ? (
        <TabState>No templates found on this WABA yet.</TabState>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <Card key={`${t.name}-${t.language}`}>
              <CardHeader className="gap-1">
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-sm font-semibold break-all">{t.name}</CardTitle>
                  <Badge
                    className={cn(
                      "shrink-0 text-[10px] uppercase",
                      STATUS_STYLE[(t.status || "").toUpperCase()] ?? STATUS_STYLE.DISABLED,
                    )}
                  >
                    {t.status}
                  </Badge>
                </div>
                <CardDescription className="text-xs">
                  {(t.category ?? "—")} · {t.language}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground text-pretty">
                  {bodyText(t) || "No body preview."}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

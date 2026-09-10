"use client"

import { useEffect, useRef, useState } from "react"
import Link from "next/link"
import Image from "next/image"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldLabel } from "@/components/ui/field"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ExternalLink, Globe, ImageUp, Loader2, RotateCcw, Save } from "lucide-react"
import { PageHeader } from "@/components/recruit/recruit-shared"
import { CAREERS_DEFAULTS, type CareersContent } from "@/lib/careers-content"

type ImageField = "headerLogo" | "logoMark" | "heroImage"

function ImagePicker({
  label,
  hint,
  value,
  onChange,
  aspect = "wide",
}: {
  label: string
  hint?: string
  value: string
  onChange: (url: string) => void
  aspect?: "wide" | "square"
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  async function upload(file: File) {
    setUploading(true)
    try {
      const body = new FormData()
      body.append("file", file)
      const res = await fetch("/api/recruit/careers-settings/upload", { method: "POST", body })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Upload failed")
      onChange(data.url)
      toast.success("Image uploaded")
    } catch (err: any) {
      toast.error(err.message || "Upload failed")
    } finally {
      setUploading(false)
    }
  }

  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div
          className={`relative overflow-hidden rounded-md border border-border bg-muted ${
            aspect === "square" ? "size-20 shrink-0" : "h-20 w-36 shrink-0"
          }`}
        >
          {value ? (
            <Image src={value || "/placeholder.svg"} alt={`${label} preview`} fill className="object-contain" />
          ) : (
            <span className="flex h-full items-center justify-center text-xs text-muted-foreground">No image</span>
          )}
        </div>
        <div className="flex flex-1 flex-col gap-2">
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) upload(f)
                e.target.value = ""
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <ImageUp data-icon="inline-start" />}
              {uploading ? "Uploading…" : "Upload image"}
            </Button>
          </div>
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="/image.png or https://…" />
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </div>
    </Field>
  )
}

export function CareerSiteClient() {
  const { data, isLoading, mutate } = useSWR<{ content: CareersContent }>("/api/recruit/careers-settings", fetcher)
  const [form, setForm] = useState<CareersContent>(CAREERS_DEFAULTS)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (data?.content) setForm(data.content)
  }, [data])

  function set<K extends keyof CareersContent>(key: K, value: CareersContent[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  async function save() {
    setSaving(true)
    try {
      const res = await fetch("/api/recruit/careers-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: form }),
      })
      const result = await res.json()
      if (!res.ok) throw new Error(result.error || "Save failed")
      await mutate()
      toast.success("Career site updated")
    } catch (err: any) {
      toast.error(err.message || "Save failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="flex flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Career Site"
        description="Edit the public careers page — branding, hero image and company content."
        icon={Globe}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" render={<Link href="/careers" target="_blank" />}>
              <ExternalLink data-icon="inline-start" /> Preview site
            </Button>
            <Button size="sm" disabled={saving || isLoading} onClick={save}>
              {saving ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
              Save changes
            </Button>
          </div>
        }
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Branding</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ImagePicker
              label="Header logo"
              hint="Wordmark shown in the top navigation bar."
              value={form.headerLogo}
              onChange={(v) => set("headerLogo", v)}
              aspect="wide"
            />
            <ImagePicker
              label="Logo mark"
              hint="Square logo shown on the company card."
              value={form.logoMark}
              onChange={(v) => set("logoMark", v)}
              aspect="square"
            />
            <Field>
              <FieldLabel>Company name</FieldLabel>
              <Input value={form.companyName} onChange={(e) => set("companyName", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Tagline</FieldLabel>
              <Input value={form.tagline} onChange={(e) => set("tagline", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Website URL</FieldLabel>
              <Input value={form.websiteUrl} onChange={(e) => set("websiteUrl", e.target.value)} placeholder="https://…" />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Hero</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <ImagePicker
              label="Hero banner image"
              hint="Large banner at the top of the careers page. Wide images (e.g. 1600×600) look best."
              value={form.heroImage}
              onChange={(v) => set("heroImage", v)}
              aspect="wide"
            />
            <Field>
              <FieldLabel>Footer text</FieldLabel>
              <Input value={form.footerText} onChange={(e) => set("footerText", e.target.value)} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>About</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Section heading</FieldLabel>
              <Input value={form.aboutHeading} onChange={(e) => set("aboutHeading", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>About text</FieldLabel>
              <Textarea rows={6} value={form.aboutText} onChange={(e) => set("aboutText", e.target.value)} />
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>What We Do</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Section heading</FieldLabel>
              <Input value={form.whatWeDoHeading} onChange={(e) => set("whatWeDoHeading", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>List items</FieldLabel>
              <Textarea
                rows={6}
                value={form.whatWeDo}
                onChange={(e) => set("whatWeDo", e.target.value)}
                placeholder="One item per line"
              />
              <p className="text-xs text-muted-foreground">Each line becomes a separate bullet on the careers page.</p>
            </Field>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Our Team</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field>
              <FieldLabel>Section heading</FieldLabel>
              <Input value={form.teamHeading} onChange={(e) => set("teamHeading", e.target.value)} />
            </Field>
            <Field>
              <FieldLabel>Team text</FieldLabel>
              <Textarea rows={5} value={form.teamText} onChange={(e) => set("teamText", e.target.value)} />
            </Field>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setForm(CAREERS_DEFAULTS)}
          disabled={saving}
        >
          <RotateCcw data-icon="inline-start" /> Reset to defaults
        </Button>
        <Button disabled={saving || isLoading} onClick={save}>
          {saving ? <Loader2 className="size-4 animate-spin" data-icon="inline-start" /> : <Save data-icon="inline-start" />}
          Save changes
        </Button>
      </div>
    </main>
  )
}

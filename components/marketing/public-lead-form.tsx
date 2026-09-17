"use client"

import type React from "react"
import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CheckCircle2 } from "lucide-react"

type Field = {
  field_key: string
  label: string
  type: string
  placeholder?: string | null
  help_text?: string | null
  required: boolean
  options?: string[] | null
}

export type PublicFormView = {
  form_code: string
  public_token: string
  name: string
  description?: string | null
  submit_label: string
  success_message?: string | null
  redirect_url?: string | null
  theme_color?: string | null
  fields: Field[]
}

export function PublicLeadForm({ form, embedded = false }: { form: PublicFormView; embedded?: boolean }) {
  const [values, setValues] = useState<Record<string, any>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [honeypot, setHoneypot] = useState("")
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const accent = form.theme_color || undefined

  function setValue(key: string, value: any) {
    setValues((prev) => ({ ...prev, [key]: value }))
    setErrors((prev) => {
      if (!prev[key]) return prev
      const next = { ...prev }
      delete next[key]
      return next
    })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setFormError(null)
    setErrors({})
    try {
      const utm: Record<string, string> = {}
      if (typeof window !== "undefined") {
        new URLSearchParams(window.location.search).forEach((v, k) => {
          if (k.startsWith("utm_")) utm[k] = v
        })
      }
      const res = await fetch(`/api/public/lead-forms/${form.public_token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: values,
          _hp: honeypot,
          utm: Object.keys(utm).length ? utm : null,
          referrer: typeof document !== "undefined" ? document.referrer : null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (body.fields) setErrors(body.fields)
        setFormError(body.error || "Something went wrong. Please try again.")
        return
      }
      if (body.redirect_url) {
        window.location.href = body.redirect_url
        return
      }
      setDone(true)
    } catch {
      setFormError("Network error. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (done) {
    return (
      <Card className="w-full max-w-lg">
        <CardContent className="flex flex-col items-center gap-4 py-14 text-center">
          <CheckCircle2 className="size-12" style={{ color: accent }} />
          <div className="space-y-1">
            <h2 className="text-xl font-semibold">Thank you</h2>
            <p className="text-sm text-muted-foreground text-pretty">
              {form.success_message || "We've received your details and will be in touch shortly."}
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={embedded ? "w-full border-0 shadow-none" : "w-full max-w-lg"}>
      <CardHeader>
        <CardTitle className="text-xl text-balance">{form.name}</CardTitle>
        {form.description ? (
          <CardDescription className="text-pretty">{form.description}</CardDescription>
        ) : null}
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          {/* Honeypot: hidden from real users, catches bots. */}
          <div aria-hidden className="absolute left-[-9999px] h-0 w-0 overflow-hidden" tabIndex={-1}>
            <label>
              Do not fill this field
              <input
                type="text"
                tabIndex={-1}
                autoComplete="off"
                value={honeypot}
                onChange={(e) => setHoneypot(e.target.value)}
              />
            </label>
          </div>

          {form.fields
            .filter((f) => f.type !== "hidden")
            .map((field) => (
              <FieldControl
                key={field.field_key}
                field={field}
                value={values[field.field_key]}
                error={errors[field.field_key]}
                onChange={(v) => setValue(field.field_key, v)}
              />
            ))}

          {formError ? <p className="text-sm text-destructive">{formError}</p> : null}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting}
            style={accent ? { backgroundColor: accent } : undefined}
          >
            {submitting ? "Submitting..." : form.submit_label || "Submit"}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

function FieldControl({
  field,
  value,
  error,
  onChange,
}: {
  field: Field
  value: any
  error?: string
  onChange: (value: any) => void
}) {
  const id = `f_${field.field_key}`

  if (field.type === "checkbox") {
    return (
      <div className="space-y-1.5">
        <div className="flex items-start gap-2">
          <Checkbox id={id} checked={!!value} onCheckedChange={(c) => onChange(!!c)} />
          <Label htmlFor={id} className="text-sm font-normal leading-snug">
            {field.label}
            {field.required ? <span className="text-destructive"> *</span> : null}
          </Label>
        </div>
        {field.help_text ? <p className="text-xs text-muted-foreground">{field.help_text}</p> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {field.label}
        {field.required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {field.type === "textarea" ? (
        <Textarea
          id={id}
          placeholder={field.placeholder || ""}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          rows={4}
        />
      ) : field.type === "select" ? (
        <Select value={value || ""} onValueChange={onChange}>
          <SelectTrigger id={id}>
            <SelectValue placeholder={field.placeholder || "Select an option"} />
          </SelectTrigger>
          <SelectContent>
            {(field.options || []).map((opt) => (
              <SelectItem key={opt} value={opt}>
                {opt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          id={id}
          type={field.type === "number" ? "number" : field.type === "email" ? "email" : field.type === "tel" ? "tel" : "text"}
          placeholder={field.placeholder || ""}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.help_text ? <p className="text-xs text-muted-foreground">{field.help_text}</p> : null}
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  )
}

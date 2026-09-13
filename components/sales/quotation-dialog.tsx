"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Separator } from "@/components/ui/separator"
import { Loader2Icon, Plus, Trash2 } from "lucide-react"
import { toDateInputValue, formatCurrency } from "@/lib/utils"
import {
  computeQuoteTotals,
  DISCOUNT_TYPES,
  GST_RATES,
  GST_TREATMENTS,
  TAX_MODES,
  type DiscountType,
  type GstTreatment,
  type TaxMode,
} from "@/lib/sales/quotation-calc"
import type { QuotationRow } from "@/components/sales/quotations-client"

type LineForm = {
  name: string
  description: string
  hsn_sac: string
  quantity: string
  unit: string
  rate: string
  discount_type: DiscountType
  discount_value: string
  tax_rate: string
}

type FormState = {
  company_id: string
  company_name: string
  contact_person: string
  contact_email: string
  contact_phone: string
  lead_id: string
  meeting_id: string
  opportunity_name: string
  reference: string
  quote_date: string
  valid_until: string
  currency: string
  tax_mode: TaxMode
  gst_treatment: GstTreatment
  place_of_supply: string
  bill_to_address: string
  ship_to_address: string
  discount_type: DiscountType
  discount_value: string
  round_off: boolean
  payment_terms: string
  delivery_terms: string
  terms_text: string
  customer_notes: string
  internal_notes: string
}

const emptyLine = (): LineForm => ({
  name: "",
  description: "",
  hsn_sac: "",
  quantity: "1",
  unit: "",
  rate: "",
  discount_type: "none",
  discount_value: "",
  tax_rate: "18",
})

const todayInput = () => new Date().toISOString().slice(0, 10)

const EMPTY: FormState = {
  company_id: "",
  company_name: "",
  contact_person: "",
  contact_email: "",
  contact_phone: "",
  lead_id: "",
  meeting_id: "",
  opportunity_name: "",
  reference: "",
  quote_date: todayInput(),
  valid_until: "",
  currency: "INR",
  tax_mode: "Exclusive",
  gst_treatment: "Intra",
  place_of_supply: "",
  bill_to_address: "",
  ship_to_address: "",
  discount_type: "none",
  discount_value: "",
  round_off: true,
  payment_terms: "",
  delivery_terms: "",
  terms_text: "",
  customer_notes: "",
  internal_notes: "",
}

const NONE = "__none__"

export function QuotationDialog({
  open,
  onOpenChange,
  quotation,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  quotation: QuotationRow | null
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [lines, setLines] = useState<LineForm[]>([emptyLine()])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [hydrating, setHydrating] = useState(false)

  const isEdit = Boolean(quotation)

  // Reference data for the relational selectors (only fetched while open).
  const { data: companyData } = useSWR<{ companies: any[] }>(open ? "/api/sales/companies" : null, fetcher)
  const { data: leadData } = useSWR<{ leads: any[] }>(open ? "/api/sales/leads" : null, fetcher)
  const { data: meetingData } = useSWR<{ meetings: any[] }>(open ? "/api/sales/meetings" : null, fetcher)
  const companies = companyData?.companies ?? []
  const leads = leadData?.leads ?? []
  const meetings = meetingData?.meetings ?? []

  useEffect(() => {
    if (!open) return
    setError(null)
    if (!quotation) {
      setForm(EMPTY)
      setLines([emptyLine()])
      return
    }
    // Editing a draft — hydrate the full record (with its line items).
    setHydrating(true)
    fetcher(`/api/sales/quotations/${quotation.id}`)
      .then((detail: any) => {
        const q = detail.quotation || {}
        setForm({
          company_id: q.company_id ? String(q.company_id) : "",
          company_name: q.company_name || "",
          contact_person: q.contact_person || "",
          contact_email: q.contact_email || "",
          contact_phone: q.contact_phone || "",
          lead_id: q.lead_id ? String(q.lead_id) : "",
          meeting_id: q.meeting_id ? String(q.meeting_id) : "",
          opportunity_name: q.opportunity_name || "",
          reference: q.reference || "",
          quote_date: toDateInputValue(q.quote_date) || todayInput(),
          valid_until: toDateInputValue(q.valid_until),
          currency: q.currency || "INR",
          tax_mode: TAX_MODES.includes(q.tax_mode) ? q.tax_mode : "Exclusive",
          gst_treatment: GST_TREATMENTS.includes(q.gst_treatment) ? q.gst_treatment : "Intra",
          place_of_supply: q.place_of_supply || "",
          bill_to_address: q.bill_to_address || "",
          ship_to_address: q.ship_to_address || "",
          discount_type: DISCOUNT_TYPES.includes(q.discount_type) ? q.discount_type : "none",
          discount_value: q.discount_value ? String(q.discount_value) : "",
          round_off: q.round_off == null ? true : Boolean(Number(q.round_off)),
          payment_terms: q.payment_terms || "",
          delivery_terms: q.delivery_terms || "",
          terms_text: q.terms_text || "",
          customer_notes: q.customer_notes || "",
          internal_notes: q.internal_notes || "",
        })
        const items: any[] = detail.items || []
        setLines(
          items.length
            ? items.map((it) => ({
                name: it.name || "",
                description: it.description || "",
                hsn_sac: it.hsn_sac || "",
                quantity: String(it.quantity ?? "1"),
                unit: it.unit || "",
                rate: String(it.rate ?? ""),
                discount_type: DISCOUNT_TYPES.includes(it.discount_type) ? it.discount_type : "none",
                discount_value: it.discount_value ? String(it.discount_value) : "",
                tax_rate: it.tax_rate != null ? String(it.tax_rate) : "18",
              }))
            : [emptyLine()],
        )
      })
      .catch(() => setError("Unable to load this quotation for editing."))
      .finally(() => setHydrating(false))
  }, [open, quotation])

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  function updateLine(index: number, patch: Partial<LineForm>) {
    setLines((prev) => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)))
  }

  function addLine() {
    setLines((prev) => [...prev, emptyLine()])
  }

  function removeLine(index: number) {
    setLines((prev) => (prev.length === 1 ? prev : prev.filter((_, i) => i !== index)))
  }

  // Live totals — recomputed with the same engine the server uses.
  const totals = useMemo(
    () =>
      computeQuoteTotals({
        items: lines.map((l) => ({
          quantity: l.quantity,
          rate: l.rate,
          discount_type: l.discount_type,
          discount_value: l.discount_value,
          tax_rate: l.tax_rate,
        })),
        taxMode: form.tax_mode,
        gstTreatment: form.gst_treatment,
        globalDiscountType: form.discount_type,
        globalDiscountValue: form.discount_value,
        roundOff: form.round_off,
      }),
    [lines, form.tax_mode, form.gst_treatment, form.discount_type, form.discount_value, form.round_off],
  )

  const money = (n: number) => formatCurrency(n)

  function handleCompanyChange(value: string) {
    if (value === NONE) {
      update("company_id", "")
      return
    }
    const c = companies.find((x) => String(x.id) === value)
    setForm((prev) => ({
      ...prev,
      company_id: value,
      company_name: c?.company_name || prev.company_name,
      contact_person: c?.contact_person || prev.contact_person,
      contact_email: c?.email || prev.contact_email,
      contact_phone: c?.phone || prev.contact_phone,
      bill_to_address: c?.address || prev.bill_to_address,
    }))
  }

  function handleLeadChange(value: string) {
    if (value === NONE) {
      update("lead_id", "")
      return
    }
    const l = leads.find((x) => String(x.id) === value)
    setForm((prev) => ({
      ...prev,
      lead_id: value,
      company_name: prev.company_name || l?.company_name || "",
      contact_person: prev.contact_person || l?.contact_person || "",
      contact_email: prev.contact_email || l?.email || "",
      contact_phone: prev.contact_phone || l?.phone || "",
      opportunity_name: prev.opportunity_name || l?.requirement || l?.title || "",
    }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!form.company_name.trim()) {
      setError("Company name is required")
      return
    }
    const items = lines.filter((l) => l.name.trim())
    if (items.length === 0) {
      setError("Add at least one line item with a name")
      return
    }
    setLoading(true)
    setError(null)

    const payload = {
      company_id: form.company_id ? Number(form.company_id) : null,
      company_name: form.company_name.trim(),
      contact_person: form.contact_person || null,
      contact_email: form.contact_email || null,
      contact_phone: form.contact_phone || null,
      lead_id: form.lead_id ? Number(form.lead_id) : null,
      meeting_id: form.meeting_id ? Number(form.meeting_id) : null,
      opportunity_name: form.opportunity_name || null,
      reference: form.reference || null,
      quote_date: form.quote_date || null,
      valid_until: form.valid_until || null,
      currency: form.currency || "INR",
      tax_mode: form.tax_mode,
      gst_treatment: form.gst_treatment,
      place_of_supply: form.place_of_supply || null,
      bill_to_address: form.bill_to_address || null,
      ship_to_address: form.ship_to_address || null,
      discount_type: form.discount_type,
      discount_value: form.discount_value ? Number(form.discount_value) : 0,
      round_off: form.round_off,
      payment_terms: form.payment_terms || null,
      delivery_terms: form.delivery_terms || null,
      terms_text: form.terms_text || null,
      customer_notes: form.customer_notes || null,
      internal_notes: form.internal_notes || null,
      items: items.map((l) => ({
        name: l.name.trim(),
        description: l.description || null,
        hsn_sac: l.hsn_sac || null,
        quantity: l.quantity ? Number(l.quantity) : 0,
        unit: l.unit || null,
        rate: l.rate ? Number(l.rate) : 0,
        discount_type: l.discount_type,
        discount_value: l.discount_value ? Number(l.discount_value) : 0,
        tax_rate: l.tax_rate ? Number(l.tax_rate) : 0,
      })),
    }

    try {
      const res = await fetch(quotation ? `/api/sales/quotations/${quotation.id}` : "/api/sales/quotations", {
        method: quotation ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save quotation")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  const gstOn = form.gst_treatment !== "None"

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{quotation ? "Edit quotation" : "Create quotation"}</DialogTitle>
            <DialogDescription>
              {quotation
                ? "Update this draft quotation, its line items and commercial terms."
                : "Build a quotation with line items, GST-aware taxes and terms."}
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-6 py-4">
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            {hydrating ? (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2Icon className="size-4 animate-spin" /> Loading quotation…
              </div>
            ) : (
              <>
                {/* --- Customer & relations --- */}
                <FieldGroup>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel>Company (master)</FieldLabel>
                      <Select value={form.company_id || NONE} onValueChange={handleCompanyChange}>
                        <SelectTrigger>
                          <SelectValue placeholder="Link a company" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Not linked</SelectItem>
                          {companies.map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.company_name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="company_name">Company name *</FieldLabel>
                      <Input
                        id="company_name"
                        value={form.company_name}
                        onChange={(e) => update("company_name", e.target.value)}
                        placeholder="Client company"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="contact_person">Contact person</FieldLabel>
                      <Input
                        id="contact_person"
                        value={form.contact_person}
                        onChange={(e) => update("contact_person", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="contact_email">Contact email</FieldLabel>
                      <Input
                        id="contact_email"
                        type="email"
                        value={form.contact_email}
                        onChange={(e) => update("contact_email", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="contact_phone">Contact phone</FieldLabel>
                      <Input
                        id="contact_phone"
                        value={form.contact_phone}
                        onChange={(e) => update("contact_phone", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Linked lead</FieldLabel>
                      <Select value={form.lead_id || NONE} onValueChange={handleLeadChange}>
                        <SelectTrigger>
                          <SelectValue placeholder="Link a lead" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Not linked</SelectItem>
                          {leads.map((l) => (
                            <SelectItem key={l.id} value={String(l.id)}>
                              {l.company_name || l.contact_person || `Lead #${l.id}`}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>Linked meeting</FieldLabel>
                      <Select
                        value={form.meeting_id || NONE}
                        onValueChange={(v) => update("meeting_id", v === NONE ? "" : v)}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Link a meeting" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value={NONE}>Not linked</SelectItem>
                          {meetings.map((m) => (
                            <SelectItem key={m.id} value={String(m.id)}>
                              {(m.title || m.agenda || `Meeting #${m.id}`) +
                                (m.meeting_date ? ` — ${toDateInputValue(m.meeting_date)}` : "")}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="opportunity_name">Opportunity / subject</FieldLabel>
                      <Input
                        id="opportunity_name"
                        value={form.opportunity_name}
                        onChange={(e) => update("opportunity_name", e.target.value)}
                      />
                    </Field>
                  </div>
                </FieldGroup>

                <Separator />

                {/* --- Dates, reference, tax config --- */}
                <FieldGroup>
                  <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Field>
                      <FieldLabel htmlFor="quote_date">Quote date</FieldLabel>
                      <Input
                        id="quote_date"
                        type="date"
                        value={form.quote_date}
                        onChange={(e) => update("quote_date", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="valid_until">Valid until</FieldLabel>
                      <Input
                        id="valid_until"
                        type="date"
                        value={form.valid_until}
                        onChange={(e) => update("valid_until", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="reference">Reference</FieldLabel>
                      <Input
                        id="reference"
                        value={form.reference}
                        onChange={(e) => update("reference", e.target.value)}
                        placeholder="RFQ / PO ref"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="currency">Currency</FieldLabel>
                      <Input
                        id="currency"
                        value={form.currency}
                        onChange={(e) => update("currency", e.target.value.toUpperCase())}
                        maxLength={3}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Tax mode</FieldLabel>
                      <Select value={form.tax_mode} onValueChange={(v) => update("tax_mode", v as TaxMode)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {TAX_MODES.map((m) => (
                            <SelectItem key={m} value={m}>
                              {m}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel>GST treatment</FieldLabel>
                      <Select
                        value={form.gst_treatment}
                        onValueChange={(v) => update("gst_treatment", v as GstTreatment)}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {GST_TREATMENTS.map((g) => (
                            <SelectItem key={g} value={g}>
                              {g === "Intra" ? "Intra-state (CGST+SGST)" : g === "Inter" ? "Inter-state (IGST)" : "No GST"}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="place_of_supply">Place of supply</FieldLabel>
                      <Input
                        id="place_of_supply"
                        value={form.place_of_supply}
                        onChange={(e) => update("place_of_supply", e.target.value)}
                      />
                    </Field>
                  </div>
                </FieldGroup>

                <Separator />

                {/* --- Line items --- */}
                <div className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold">Line items</h4>
                    <Button type="button" variant="outline" size="sm" onClick={addLine}>
                      <Plus data-icon="inline-start" />
                      Add item
                    </Button>
                  </div>

                  <div className="flex flex-col gap-3">
                    {lines.map((line, i) => {
                      const lineTotal = totals.lines[i]?.lineTotal ?? 0
                      return (
                        <div key={i} className="rounded-md border border-border bg-card p-3">
                          <div className="grid grid-cols-1 gap-3 sm:grid-cols-12">
                            <div className="sm:col-span-5">
                              <Label className="text-xs text-muted-foreground">Item name</Label>
                              <Input
                                value={line.name}
                                onChange={(e) => updateLine(i, { name: e.target.value })}
                                placeholder="Product or service"
                              />
                            </div>
                            <div className="sm:col-span-3">
                              <Label className="text-xs text-muted-foreground">HSN / SAC</Label>
                              <Input
                                value={line.hsn_sac}
                                onChange={(e) => updateLine(i, { hsn_sac: e.target.value })}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <Label className="text-xs text-muted-foreground">Qty</Label>
                              <Input
                                type="number"
                                min="0"
                                step="any"
                                value={line.quantity}
                                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                              />
                            </div>
                            <div className="sm:col-span-2">
                              <Label className="text-xs text-muted-foreground">Unit</Label>
                              <Input value={line.unit} onChange={(e) => updateLine(i, { unit: e.target.value })} />
                            </div>
                            <div className="sm:col-span-12">
                              <Label className="text-xs text-muted-foreground">Description</Label>
                              <Input
                                value={line.description}
                                onChange={(e) => updateLine(i, { description: e.target.value })}
                                placeholder="Optional details"
                              />
                            </div>
                            <div className="sm:col-span-3">
                              <Label className="text-xs text-muted-foreground">Rate</Label>
                              <Input
                                type="number"
                                min="0"
                                step="any"
                                value={line.rate}
                                onChange={(e) => updateLine(i, { rate: e.target.value })}
                              />
                            </div>
                            <div className="sm:col-span-3">
                              <Label className="text-xs text-muted-foreground">Discount</Label>
                              <div className="flex gap-1">
                                <Select
                                  value={line.discount_type}
                                  onValueChange={(v) => updateLine(i, { discount_type: v as DiscountType })}
                                >
                                  <SelectTrigger className="w-20">
                                    <SelectValue />
                                  </SelectTrigger>
                                  <SelectContent>
                                    <SelectItem value="none">—</SelectItem>
                                    <SelectItem value="percent">%</SelectItem>
                                    <SelectItem value="fixed">₹</SelectItem>
                                  </SelectContent>
                                </Select>
                                <Input
                                  type="number"
                                  min="0"
                                  step="any"
                                  disabled={line.discount_type === "none"}
                                  value={line.discount_value}
                                  onChange={(e) => updateLine(i, { discount_value: e.target.value })}
                                />
                              </div>
                            </div>
                            <div className="sm:col-span-3">
                              <Label className="text-xs text-muted-foreground">GST %</Label>
                              <Select
                                value={line.tax_rate}
                                onValueChange={(v) => updateLine(i, { tax_rate: v })}
                                disabled={!gstOn}
                              >
                                <SelectTrigger>
                                  <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                  {GST_RATES.map((r) => (
                                    <SelectItem key={r} value={String(r)}>
                                      {r}%
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <div className="flex items-end justify-between gap-2 sm:col-span-3">
                              <div>
                                <Label className="text-xs text-muted-foreground">Line total</Label>
                                <p className="text-sm font-semibold tabular-nums">{money(lineTotal)}</p>
                              </div>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon-sm"
                                aria-label="Remove item"
                                disabled={lines.length === 1}
                                onClick={() => removeLine(i)}
                              >
                                <Trash2 className="size-4" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* --- Global discount + totals --- */}
                <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
                  <FieldGroup>
                    <Field>
                      <FieldLabel>Quotation-wide discount</FieldLabel>
                      <div className="flex gap-2">
                        <Select
                          value={form.discount_type}
                          onValueChange={(v) => update("discount_type", v as DiscountType)}
                        >
                          <SelectTrigger className="w-28">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            <SelectItem value="percent">Percent</SelectItem>
                            <SelectItem value="fixed">Fixed</SelectItem>
                          </SelectContent>
                        </Select>
                        <Input
                          type="number"
                          min="0"
                          step="any"
                          disabled={form.discount_type === "none"}
                          value={form.discount_value}
                          onChange={(e) => update("discount_value", e.target.value)}
                        />
                      </div>
                    </Field>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 rounded border-border"
                        checked={form.round_off}
                        onChange={(e) => update("round_off", e.target.checked)}
                      />
                      Round grand total to the nearest whole {form.currency}
                    </label>
                  </FieldGroup>

                  <div className="rounded-md border border-border bg-muted/40 p-4">
                    <dl className="flex flex-col gap-1.5 text-sm">
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Subtotal</dt>
                        <dd className="tabular-nums">{money(totals.subtotal)}</dd>
                      </div>
                      {totals.discountTotal > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">Discount</dt>
                          <dd className="tabular-nums">- {money(totals.discountTotal)}</dd>
                        </div>
                      )}
                      <div className="flex justify-between">
                        <dt className="text-muted-foreground">Taxable value</dt>
                        <dd className="tabular-nums">{money(totals.taxableValue)}</dd>
                      </div>
                      {totals.cgstTotal > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">CGST</dt>
                          <dd className="tabular-nums">{money(totals.cgstTotal)}</dd>
                        </div>
                      )}
                      {totals.sgstTotal > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">SGST</dt>
                          <dd className="tabular-nums">{money(totals.sgstTotal)}</dd>
                        </div>
                      )}
                      {totals.igstTotal > 0 && (
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">IGST</dt>
                          <dd className="tabular-nums">{money(totals.igstTotal)}</dd>
                        </div>
                      )}
                      {totals.roundOff !== 0 && (
                        <div className="flex justify-between">
                          <dt className="text-muted-foreground">Round off</dt>
                          <dd className="tabular-nums">{money(totals.roundOff)}</dd>
                        </div>
                      )}
                      <Separator className="my-1" />
                      <div className="flex justify-between text-base font-semibold">
                        <dt>Grand total</dt>
                        <dd className="tabular-nums">{money(totals.grandTotal)}</dd>
                      </div>
                    </dl>
                  </div>
                </div>

                <Separator />

                {/* --- Terms & notes --- */}
                <FieldGroup>
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor="payment_terms">Payment terms</FieldLabel>
                      <Input
                        id="payment_terms"
                        value={form.payment_terms}
                        onChange={(e) => update("payment_terms", e.target.value)}
                        placeholder="e.g. 50% advance, balance on delivery"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="delivery_terms">Delivery terms</FieldLabel>
                      <Input
                        id="delivery_terms"
                        value={form.delivery_terms}
                        onChange={(e) => update("delivery_terms", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="bill_to_address">Bill to address</FieldLabel>
                      <Textarea
                        id="bill_to_address"
                        rows={2}
                        value={form.bill_to_address}
                        onChange={(e) => update("bill_to_address", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="ship_to_address">Ship to address</FieldLabel>
                      <Textarea
                        id="ship_to_address"
                        rows={2}
                        value={form.ship_to_address}
                        onChange={(e) => update("ship_to_address", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="terms_text">Terms &amp; conditions</FieldLabel>
                      <Textarea
                        id="terms_text"
                        rows={3}
                        value={form.terms_text}
                        onChange={(e) => update("terms_text", e.target.value)}
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="customer_notes">Customer notes</FieldLabel>
                      <Textarea
                        id="customer_notes"
                        rows={3}
                        value={form.customer_notes}
                        onChange={(e) => update("customer_notes", e.target.value)}
                      />
                    </Field>
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="internal_notes">Internal notes (not printed)</FieldLabel>
                      <Textarea
                        id="internal_notes"
                        rows={2}
                        value={form.internal_notes}
                        onChange={(e) => update("internal_notes", e.target.value)}
                      />
                    </Field>
                  </div>
                </FieldGroup>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || hydrating}>
              {loading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {quotation ? "Save changes" : "Create quotation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import {
  Loader2,
  Check,
  ChevronLeft,
  ChevronRight,
  Building2,
  Globe,
  Receipt,
  Palette,
  UserCog,
  Server,
  ShieldCheck,
  ClipboardCheck,
  CircleCheckBig,
  KeyRound,
  Copy,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"

// Keep this in sync with lib/tenant-onboarding.ts
export type OnboardingData = {
  companyName?: string
  legalEntity?: string
  industry?: string
  companySize?: string
  country?: string
  currency?: string
  timezone?: string
  fiscalYearStart?: string
  language?: string
  taxId?: string
  taxScheme?: string
  addressLine1?: string
  addressLine2?: string
  city?: string
  state?: string
  postalCode?: string
  addressCountry?: string
  primaryColor?: string
  accentColor?: string
  logoUrl?: string
  adminName?: string
  adminEmail?: string
  slug?: string
  customDomain?: string
  plan?: string
  deploymentModel?: string
  storageRegion?: string
  storageQuotaGb?: number
  requireMfa?: boolean
  passwordPolicy?: string
  sessionTimeoutMinutes?: number
  ipAllowlist?: string
}

export type OnboardingSession = {
  id: number
  status: "draft" | "in_progress" | "completed" | "failed"
  currentStep: number
  data: OnboardingData
  createdTenantId: number | null
  errorMessage: string | null
}

const CURRENCIES = ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "AED", "JPY", "CNY"]
const COMPANY_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1000+"]
const FISCAL_MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
]
const PLANS = ["starter", "growth", "enterprise"]
const DEPLOYMENTS = [
  { value: "shared_database", label: "Shared database" },
  { value: "separate_schema", label: "Separate schema" },
  { value: "dedicated_database", label: "Dedicated database" },
]
const PASSWORD_POLICIES = [
  { value: "standard", label: "Standard (8+ chars)" },
  { value: "strong", label: "Strong (12+, mixed)" },
  { value: "enterprise", label: "Enterprise (16+, rotation)" },
]

const STEPS = [
  { key: "company", label: "Company", icon: Building2 },
  { key: "localization", label: "Localization", icon: Globe },
  { key: "tax_address", label: "Tax & address", icon: Receipt },
  { key: "branding", label: "Branding", icon: Palette },
  { key: "admin", label: "Admin user", icon: UserCog },
  { key: "domain_subscription", label: "Domain & plan", icon: Server },
  { key: "storage_security", label: "Storage & security", icon: ShieldCheck },
  { key: "review", label: "Review", icon: ClipboardCheck },
] as const

const LAST = STEPS.length - 1

function slugify(v: string) {
  return v.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
}

export function OnboardingWizard({ session, canManage }: { session: OnboardingSession; canManage: boolean }) {
  const router = useRouter()
  const [data, setData] = useState<OnboardingData>(session.data ?? {})
  const [step, setStep] = useState(session.status === "completed" ? LAST : Math.min(session.currentStep, LAST))
  const [saving, setSaving] = useState(false)
  const [finalizing, setFinalizing] = useState(false)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [tempPassword, setTempPassword] = useState<string | null>(null)
  const completed = session.status === "completed"

  const set = <K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) => {
    setData((d) => ({ ...d, [key]: value }))
    setFieldErrors((e) => (e[key as string] ? { ...e, [key as string]: "" } : e))
  }

  async function persist(targetStep: number) {
    if (completed) return true
    setSaving(true)
    try {
      const res = await fetch(`/api/platform/onboarding/${session.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ step: targetStep, data }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(json.error || "Could not save progress")
        return false
      }
      return true
    } catch {
      toast.error("Network error — progress not saved")
      return false
    } finally {
      setSaving(false)
    }
  }

  async function goNext() {
    const ok = await persist(Math.min(step + 1, LAST))
    if (ok) setStep((s) => Math.min(s + 1, LAST))
  }

  async function goBack() {
    // Save silently, but move even if the save fails so the user isn't trapped.
    await persist(step)
    setStep((s) => Math.max(s - 1, 0))
  }

  async function jumpTo(target: number) {
    if (target === step) return
    if (target < step) {
      await persist(step)
      setStep(target)
      return
    }
    const ok = await persist(target)
    if (ok) setStep(target)
  }

  async function finalize() {
    const saved = await persist(LAST)
    if (!saved) return
    setFinalizing(true)
    setFieldErrors({})
    try {
      const res = await fetch(`/api/platform/onboarding/${session.id}/finalize`, { method: "POST" })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        if (Array.isArray(json.fieldErrors) && json.fieldErrors.length > 0) {
          const map: Record<string, string> = {}
          for (const fe of json.fieldErrors) map[fe.field] = fe.message
          setFieldErrors(map)
          toast.error("Some required details are missing — please review the highlighted fields")
        } else {
          toast.error(json.error || "Could not finalize onboarding")
        }
        router.refresh()
        return
      }
      setTempPassword(json.adminTempPassword ?? null)
      toast.success("Organization provisioned successfully")
      router.refresh()
    } catch {
      toast.error("Network error — please try again")
    } finally {
      setFinalizing(false)
    }
  }

  const CurrentIcon = STEPS[step].icon

  if (completed || tempPassword !== null) {
    return (
      <CompletionPanel
        data={data}
        tenantId={session.createdTenantId}
        tempPassword={tempPassword}
        adminEmail={data.adminEmail}
        onDone={() => router.push("/platform/onboarding")}
      />
    )
  }

  const readOnly = !canManage

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      {/* Stepper */}
      <ol className="flex shrink-0 gap-1 overflow-x-auto lg:w-56 lg:flex-col lg:gap-1">
        {STEPS.map((s, i) => {
          const Icon = s.icon
          const done = i < step
          const active = i === step
          return (
            <li key={s.key} className="min-w-max lg:min-w-0">
              <button
                type="button"
                onClick={() => jumpTo(i)}
                disabled={saving}
                className={cn(
                  "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors",
                  active
                    ? "bg-primary/10 font-medium text-primary"
                    : done
                      ? "text-foreground hover:bg-muted"
                      : "text-muted-foreground hover:bg-muted",
                )}
              >
                <span
                  className={cn(
                    "flex size-6 shrink-0 items-center justify-center rounded-full border text-xs",
                    active
                      ? "border-primary bg-primary text-primary-foreground"
                      : done
                        ? "border-primary/40 bg-primary/10 text-primary"
                        : "border-border text-muted-foreground",
                  )}
                >
                  {done ? <Check className="size-3.5" /> : i + 1}
                </span>
                <span className="truncate">{s.label}</span>
              </button>
            </li>
          )
        })}
      </ol>

      {/* Panel */}
      <div className="flex min-w-0 flex-1 flex-col gap-5 rounded-lg border border-border bg-background p-5 sm:p-6">
        <header className="flex items-center gap-3 border-b border-border pb-4">
          <span className="flex size-9 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <CurrentIcon className="size-4.5" />
          </span>
          <div className="flex flex-col leading-tight">
            <h2 className="text-lg font-semibold tracking-tight">{STEPS[step].label}</h2>
            <p className="text-xs text-muted-foreground">
              Step {step + 1} of {STEPS.length}
            </p>
          </div>
        </header>

        {session.status === "failed" && session.errorMessage ? (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            Previous provisioning attempt failed: {session.errorMessage}. Adjust the details and try again — already
            created resources will be reused.
          </p>
        ) : null}

        <fieldset disabled={readOnly} className="flex flex-col gap-5">
          {step === 0 ? <CompanyStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 1 ? <LocalizationStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 2 ? <TaxAddressStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 3 ? <BrandingStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 4 ? <AdminStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 5 ? <DomainStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 6 ? <StorageSecurityStep data={data} set={set} errors={fieldErrors} /> : null}
          {step === 7 ? <ReviewStep data={data} errors={fieldErrors} onJump={jumpTo} /> : null}
        </fieldset>

        <footer className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <Button variant="outline" onClick={goBack} disabled={step === 0 || saving || finalizing}>
            <ChevronLeft className="size-4" />
            Back
          </Button>
          <div className="flex items-center gap-2">
            {saving ? (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Saving
              </span>
            ) : null}
            {step < LAST ? (
              <Button onClick={goNext} disabled={saving || readOnly}>
                Next
                <ChevronRight className="size-4" />
              </Button>
            ) : (
              <Button onClick={finalize} disabled={finalizing || saving || readOnly}>
                {finalizing ? <Loader2 className="size-4 animate-spin" /> : <CircleCheckBig className="size-4" />}
                Provision organization
              </Button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared field helpers
// ---------------------------------------------------------------------------

type StepProps = {
  data: OnboardingData
  set: <K extends keyof OnboardingData>(key: K, value: OnboardingData[K]) => void
  errors: Record<string, string>
}

function Field({
  label,
  htmlFor,
  error,
  hint,
  children,
}: {
  label: string
  htmlFor?: string
  error?: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? <p className="text-xs text-destructive">{error}</p> : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}

function CompanyStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <Field label="Company name" htmlFor="companyName" error={errors.companyName}>
          <Input
            id="companyName"
            value={data.companyName ?? ""}
            onChange={(e) => set("companyName", e.target.value)}
            placeholder="Acme Corporation"
          />
        </Field>
      </div>
      <Field label="Legal entity" htmlFor="legalEntity" error={errors.legalEntity} hint="Registered legal name">
        <Input
          id="legalEntity"
          value={data.legalEntity ?? ""}
          onChange={(e) => set("legalEntity", e.target.value)}
          placeholder="Acme Corp Pvt. Ltd."
        />
      </Field>
      <Field label="Industry" htmlFor="industry" error={errors.industry}>
        <Input
          id="industry"
          value={data.industry ?? ""}
          onChange={(e) => set("industry", e.target.value)}
          placeholder="Manufacturing"
        />
      </Field>
      <Field label="Company size" error={errors.companySize}>
        <Select value={data.companySize ?? ""} onValueChange={(v) => set("companySize", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select size" />
          </SelectTrigger>
          <SelectContent>
            {COMPANY_SIZES.map((s) => (
              <SelectItem key={s} value={s}>
                {s} employees
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}

function LocalizationStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Country" htmlFor="country" error={errors.country}>
        <Input
          id="country"
          value={data.country ?? ""}
          onChange={(e) => set("country", e.target.value)}
          placeholder="United States"
        />
      </Field>
      <Field label="Default currency" error={errors.currency}>
        <Select value={data.currency ?? ""} onValueChange={(v) => set("currency", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select currency" />
          </SelectTrigger>
          <SelectContent>
            {CURRENCIES.map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Timezone" htmlFor="timezone" error={errors.timezone} hint="IANA name, e.g. America/New_York">
        <Input
          id="timezone"
          value={data.timezone ?? ""}
          onChange={(e) => set("timezone", e.target.value)}
          placeholder="America/New_York"
        />
      </Field>
      <Field label="Fiscal year starts" error={errors.fiscalYearStart}>
        <Select value={data.fiscalYearStart ?? ""} onValueChange={(v) => set("fiscalYearStart", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select month" />
          </SelectTrigger>
          <SelectContent>
            {FISCAL_MONTHS.map((m) => (
              <SelectItem key={m} value={m}>
                {m}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Default language" htmlFor="language" error={errors.language} hint="e.g. English (en-US)">
        <Input
          id="language"
          value={data.language ?? ""}
          onChange={(e) => set("language", e.target.value)}
          placeholder="English (en-US)"
        />
      </Field>
    </div>
  )
}

function TaxAddressStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Tax ID / VAT" htmlFor="taxId" error={errors.taxId} hint="Optional">
        <Input id="taxId" value={data.taxId ?? ""} onChange={(e) => set("taxId", e.target.value)} placeholder="US-123456789" />
      </Field>
      <Field label="Tax scheme" htmlFor="taxScheme" error={errors.taxScheme} hint="e.g. GST, VAT, Sales Tax">
        <Input id="taxScheme" value={data.taxScheme ?? ""} onChange={(e) => set("taxScheme", e.target.value)} placeholder="VAT" />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Address line 1" htmlFor="addressLine1" error={errors.addressLine1}>
          <Input id="addressLine1" value={data.addressLine1 ?? ""} onChange={(e) => set("addressLine1", e.target.value)} placeholder="123 Market Street" />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Address line 2" htmlFor="addressLine2" error={errors.addressLine2} hint="Optional">
          <Input id="addressLine2" value={data.addressLine2 ?? ""} onChange={(e) => set("addressLine2", e.target.value)} placeholder="Suite 400" />
        </Field>
      </div>
      <Field label="City" htmlFor="city" error={errors.city}>
        <Input id="city" value={data.city ?? ""} onChange={(e) => set("city", e.target.value)} placeholder="San Francisco" />
      </Field>
      <Field label="State / region" htmlFor="state" error={errors.state}>
        <Input id="state" value={data.state ?? ""} onChange={(e) => set("state", e.target.value)} placeholder="California" />
      </Field>
      <Field label="Postal code" htmlFor="postalCode" error={errors.postalCode}>
        <Input id="postalCode" value={data.postalCode ?? ""} onChange={(e) => set("postalCode", e.target.value)} placeholder="94105" />
      </Field>
      <Field label="Address country" htmlFor="addressCountry" error={errors.addressCountry} hint="Defaults to company country">
        <Input id="addressCountry" value={data.addressCountry ?? ""} onChange={(e) => set("addressCountry", e.target.value)} placeholder="United States" />
      </Field>
    </div>
  )
}

function BrandingStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Primary color" htmlFor="primaryColor" error={errors.primaryColor} hint="Hex, used for the tenant theme">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Primary color picker"
            value={data.primaryColor ?? "#4f46e5"}
            onChange={(e) => set("primaryColor", e.target.value)}
            className="size-9 shrink-0 cursor-pointer rounded-md border border-border bg-background"
          />
          <Input id="primaryColor" value={data.primaryColor ?? ""} onChange={(e) => set("primaryColor", e.target.value)} placeholder="#4f46e5" />
        </div>
      </Field>
      <Field label="Accent color" htmlFor="accentColor" error={errors.accentColor} hint="Hex, optional">
        <div className="flex items-center gap-2">
          <input
            type="color"
            aria-label="Accent color picker"
            value={data.accentColor ?? "#06b6d4"}
            onChange={(e) => set("accentColor", e.target.value)}
            className="size-9 shrink-0 cursor-pointer rounded-md border border-border bg-background"
          />
          <Input id="accentColor" value={data.accentColor ?? ""} onChange={(e) => set("accentColor", e.target.value)} placeholder="#06b6d4" />
        </div>
      </Field>
      <div className="sm:col-span-2">
        <Field label="Logo URL" htmlFor="logoUrl" error={errors.logoUrl} hint="Optional — link to the organization logo">
          <Input id="logoUrl" value={data.logoUrl ?? ""} onChange={(e) => set("logoUrl", e.target.value)} placeholder="https://acme.com/logo.png" />
        </Field>
      </div>
    </div>
  )
}

function AdminStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Admin full name" htmlFor="adminName" error={errors.adminName}>
        <Input id="adminName" value={data.adminName ?? ""} onChange={(e) => set("adminName", e.target.value)} placeholder="Jane Doe" />
      </Field>
      <Field label="Admin email" htmlFor="adminEmail" error={errors.adminEmail} hint="Receives owner access & a temporary password">
        <Input id="adminEmail" type="email" value={data.adminEmail ?? ""} onChange={(e) => set("adminEmail", e.target.value)} placeholder="jane@acme.com" />
      </Field>
      <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground sm:col-span-2">
        This person becomes the organization&apos;s <strong>owner</strong>. A one-time password is generated at
        provisioning and must be changed on first sign-in.
      </p>
    </div>
  )
}

function DomainStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Subdomain / slug" htmlFor="slug" error={errors.slug} hint="Lowercase letters, digits and hyphens">
        <Input
          id="slug"
          value={data.slug ?? ""}
          onChange={(e) => set("slug", slugify(e.target.value))}
          placeholder="acme"
        />
      </Field>
      <Field label="Custom domain" htmlFor="customDomain" error={errors.customDomain} hint="Optional">
        <Input id="customDomain" value={data.customDomain ?? ""} onChange={(e) => set("customDomain", e.target.value)} placeholder="erp.acme.com" />
      </Field>
      <Field label="Subscription plan" error={errors.plan}>
        <Select value={data.plan ?? ""} onValueChange={(v) => set("plan", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select plan" />
          </SelectTrigger>
          <SelectContent>
            {PLANS.map((p) => (
              <SelectItem key={p} value={p} className="capitalize">
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Deployment model" error={errors.deploymentModel}>
        <Select value={data.deploymentModel ?? ""} onValueChange={(v) => set("deploymentModel", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select model" />
          </SelectTrigger>
          <SelectContent>
            {DEPLOYMENTS.map((d) => (
              <SelectItem key={d.value} value={d.value}>
                {d.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </div>
  )
}

function StorageSecurityStep({ data, set, errors }: StepProps) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <Field label="Storage region" htmlFor="storageRegion" error={errors.storageRegion} hint="e.g. us-east-1">
        <Input id="storageRegion" value={data.storageRegion ?? ""} onChange={(e) => set("storageRegion", e.target.value)} placeholder="us-east-1" />
      </Field>
      <Field label="Storage quota (GB)" htmlFor="storageQuotaGb" error={errors.storageQuotaGb}>
        <Input
          id="storageQuotaGb"
          type="number"
          min={0}
          value={data.storageQuotaGb ?? ""}
          onChange={(e) => set("storageQuotaGb", e.target.value === "" ? undefined : Number(e.target.value))}
          placeholder="100"
        />
      </Field>
      <Field label="Password policy" error={errors.passwordPolicy}>
        <Select value={data.passwordPolicy ?? "standard"} onValueChange={(v) => set("passwordPolicy", v)}>
          <SelectTrigger>
            <SelectValue placeholder="Select policy" />
          </SelectTrigger>
          <SelectContent>
            {PASSWORD_POLICIES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Session timeout (minutes)" htmlFor="sessionTimeoutMinutes" error={errors.sessionTimeoutMinutes}>
        <Input
          id="sessionTimeoutMinutes"
          type="number"
          min={5}
          value={data.sessionTimeoutMinutes ?? ""}
          onChange={(e) => set("sessionTimeoutMinutes", e.target.value === "" ? undefined : Number(e.target.value))}
          placeholder="60"
        />
      </Field>
      <div className="sm:col-span-2">
        <Field label="IP allowlist" htmlFor="ipAllowlist" error={errors.ipAllowlist} hint="Optional — comma separated CIDRs">
          <Textarea
            id="ipAllowlist"
            value={data.ipAllowlist ?? ""}
            onChange={(e) => set("ipAllowlist", e.target.value)}
            placeholder="203.0.113.0/24, 198.51.100.4/32"
            rows={2}
          />
        </Field>
      </div>
      <label className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2.5 sm:col-span-2">
        <span className="flex flex-col">
          <span className="text-sm font-medium">Require multi-factor authentication</span>
          <span className="text-xs text-muted-foreground">Enforce MFA for every user in this organization</span>
        </span>
        <Switch checked={data.requireMfa ?? false} onCheckedChange={(v) => set("requireMfa", v)} />
      </label>
    </div>
  )
}

function ReviewRow({ label, value }: { label: string; value?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-right text-sm font-medium">{value || <span className="text-muted-foreground">—</span>}</span>
    </div>
  )
}

function ReviewStep({
  data,
  errors,
  onJump,
}: {
  data: OnboardingData
  errors: Record<string, string>
  onJump: (i: number) => void
}) {
  const hasErrors = Object.values(errors).some(Boolean)
  const sections: { title: string; step: number; rows: [string, React.ReactNode][] }[] = [
    {
      title: "Company",
      step: 0,
      rows: [
        ["Company name", data.companyName],
        ["Legal entity", data.legalEntity],
        ["Industry", data.industry],
        ["Company size", data.companySize],
      ],
    },
    {
      title: "Localization",
      step: 1,
      rows: [
        ["Country", data.country],
        ["Currency", data.currency],
        ["Timezone", data.timezone],
        ["Fiscal year", data.fiscalYearStart],
        ["Language", data.language],
      ],
    },
    {
      title: "Admin owner",
      step: 4,
      rows: [
        ["Name", data.adminName],
        ["Email", data.adminEmail],
      ],
    },
    {
      title: "Domain & plan",
      step: 5,
      rows: [
        ["Slug", data.slug],
        ["Custom domain", data.customDomain],
        ["Plan", data.plan],
        ["Deployment", DEPLOYMENTS.find((d) => d.value === data.deploymentModel)?.label ?? data.deploymentModel],
      ],
    },
    {
      title: "Security",
      step: 6,
      rows: [
        ["MFA required", data.requireMfa ? "Yes" : "No"],
        ["Password policy", data.passwordPolicy],
        ["Session timeout", data.sessionTimeoutMinutes ? `${data.sessionTimeoutMinutes} min` : undefined],
        ["Storage quota", data.storageQuotaGb ? `${data.storageQuotaGb} GB` : undefined],
      ],
    },
  ]

  return (
    <div className="flex flex-col gap-4">
      {hasErrors ? (
        <p className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Some required fields are missing. Use the steps above to complete them before provisioning.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Review the organization profile below, then provision. This creates the tenant, its subscription and the
          owner account.
        </p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {sections.map((sec) => (
          <div key={sec.title} className="rounded-md border border-border p-4">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold">{sec.title}</h3>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => onJump(sec.step)}>
                Edit
              </Button>
            </div>
            <div className="divide-y divide-border/60">
              {sec.rows.map(([label, value]) => (
                <ReviewRow key={label} label={label} value={value} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

function CompletionPanel({
  data,
  tenantId,
  tempPassword,
  adminEmail,
  onDone,
}: {
  data: OnboardingData
  tenantId: number | null
  tempPassword: string | null
  adminEmail?: string
  onDone: () => void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!tempPassword) return
    try {
      await navigator.clipboard.writeText(tempPassword)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      toast.error("Could not copy to clipboard")
    }
  }

  return (
    <div className="mx-auto flex max-w-lg flex-col items-center gap-5 rounded-lg border border-border bg-background p-8 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-primary/10 text-primary">
        <CircleCheckBig className="size-7" />
      </span>
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold tracking-tight">{data.companyName || "Organization"} is live</h2>
        <p className="text-sm text-muted-foreground">
          The tenant has been provisioned{tenantId ? ` (tenant #${tenantId})` : ""} with its owner account and
          subscription.
        </p>
      </div>

      {tempPassword ? (
        <div className="w-full rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-left">
          <div className="mb-2 flex items-center gap-2 text-amber-700 dark:text-amber-400">
            <KeyRound className="size-4" />
            <span className="text-sm font-medium">One-time owner password</span>
          </div>
          <p className="mb-3 text-xs text-muted-foreground">
            Share this securely with <strong>{adminEmail}</strong>. It is shown only once and must be changed on first
            sign-in.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded bg-background px-3 py-2 font-mono text-sm">{tempPassword}</code>
            <Button variant="outline" size="sm" onClick={copy}>
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        </div>
      ) : (
        <Badge variant="secondary">Owner credentials were issued previously</Badge>
      )}

      <div className="flex gap-2">
        <Button onClick={onDone}>Back to onboarding</Button>
      </div>
    </div>
  )
}

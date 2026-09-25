"use client"

import { useEffect, useMemo, useState } from "react"
import {
  Building2,
  Image as ImageIcon,
  Palette,
  LogIn,
  Mail,
  FileText,
  Globe,
  Save,
  Check,
  Loader2,
  RotateCcw,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { cn } from "@/lib/utils"

/**
 * SPEC 155 — Branding Engine.
 *
 * A focused, tenant-scoped surface to configure every branded surface of the
 * workspace (logo, favicon, colours, company name, email, PDF, login, custom
 * domain) with a live preview. It is a thin client over the existing tenant
 * settings API (/api/admin/company-settings), so it inherits that layer's
 * tenant isolation, short-lived caching and write-through invalidation for
 * free — this component never talks to another tenant's data or persists
 * anything outside the acting tenant's override store.
 */

type FieldDef = {
  key: string
  label: string
  type: "text" | "url" | "textarea" | "color" | "select"
  options?: string[]
  placeholder?: string
  help?: string
}

type GroupDef = {
  id: string
  label: string
  icon: LucideIcon
  description: string
  fields: FieldDef[]
}

const GROUPS: GroupDef[] = [
  {
    id: "identity",
    label: "Identity",
    icon: Building2,
    description: "Names shown across the workspace and in the browser tab.",
    fields: [
      { key: "company.name", label: "Company Name", type: "text", placeholder: "Acme Pvt Ltd" },
      {
        key: "app.name",
        label: "Application Name",
        type: "text",
        placeholder: "Acme ERP",
        help: "Shown in the browser tab and the app header.",
      },
      { key: "company.website", label: "Website", type: "url", placeholder: "https://acme.com" },
    ],
  },
  {
    id: "logo",
    label: "Logo & Favicon",
    icon: ImageIcon,
    description: "Brand marks used in the app chrome and the browser tab.",
    fields: [
      { key: "company.logo", label: "Primary Logo URL", type: "url", placeholder: "https://.../logo.png" },
      {
        key: "company.favicon",
        label: "Favicon URL",
        type: "url",
        placeholder: "https://.../favicon.ico",
        help: "Small square icon shown in the browser tab. 32×32 or 48×48 works best.",
      },
    ],
  },
  {
    id: "colors",
    label: "Colors",
    icon: Palette,
    description: "Primary and sidebar colours applied to the live theme.",
    fields: [
      { key: "theme.primary_color", label: "Primary Color", type: "color", placeholder: "#6d28d9" },
      { key: "theme.sidebar_color", label: "Sidebar Color", type: "color", placeholder: "#0f172a" },
      { key: "theme.mode", label: "Default Theme", type: "select", options: ["Light", "Dark", "System"] },
    ],
  },
  {
    id: "login",
    label: "Login",
    icon: LogIn,
    description: "How the sign-in screen looks before a user authenticates.",
    fields: [
      { key: "company.login_logo", label: "Login Logo URL", type: "url", placeholder: "https://.../login-logo.png" },
      {
        key: "theme.login_background",
        label: "Login Background URL",
        type: "url",
        placeholder: "https://.../bg.jpg",
        help: "Full-bleed image behind the marketing panel of the login screen.",
      },
    ],
  },
  {
    id: "email",
    label: "Email",
    icon: Mail,
    description: "Branding wrapped around every outbound email.",
    fields: [
      { key: "email.brand_logo", label: "Email Logo URL", type: "url", placeholder: "https://.../email-logo.png" },
      { key: "email.brand_color", label: "Header Color", type: "color", placeholder: "#6d28d9" },
      { key: "email.button_color", label: "Button Color", type: "color", placeholder: "#6d28d9" },
      {
        key: "email.footer_text",
        label: "Footer Text",
        type: "textarea",
        placeholder: "© Acme Pvt Ltd. All rights reserved.",
      },
    ],
  },
  {
    id: "pdf",
    label: "Documents",
    icon: FileText,
    description: "Branding applied to generated PDFs such as invoices.",
    fields: [
      { key: "pdf.brand_logo", label: "PDF Logo URL", type: "url", placeholder: "https://.../pdf-logo.png" },
      { key: "pdf.accent_color", label: "Accent Color", type: "color", placeholder: "#6d28d9" },
      { key: "pdf.footer_text", label: "Footer Text", type: "textarea", placeholder: "Thank you for your business." },
    ],
  },
  {
    id: "domain",
    label: "Custom Domain",
    icon: Globe,
    description: "Serve the workspace from your own hostname.",
    fields: [
      {
        key: "company.custom_domain",
        label: "Custom Domain",
        type: "text",
        placeholder: "portal.acme.com",
        help: "Point this hostname at the app via CNAME. The login screen resolves branding from it before sign-in.",
      },
    ],
  },
]

const DEFAULT_PRIMARY = "#6d28d9"

const ALL_BRANDING_KEYS = Array.from(new Set(GROUPS.flatMap((g) => g.fields.map((f) => f.key))))

type Derived = ReturnType<typeof deriveBranding>

/** Client mirror of lib/branding.ts fallbacks, used purely to drive the preview. */
function deriveBranding(v: Record<string, string>) {
  const val = (k: string) => (v[k] ?? "").trim()
  const companyName = val("company.name") || "Muenot Business Suite"
  const appName = val("app.name") || companyName
  const primary = val("theme.primary_color") || DEFAULT_PRIMARY
  const sidebar = val("theme.sidebar_color") || primary
  const logo = val("company.logo")
  const year = new Date().getFullYear()
  return {
    companyName,
    appName,
    website: val("company.website"),
    primary,
    sidebar,
    mode: val("theme.mode") || "Dark",
    logo,
    loginLogo: val("company.login_logo") || logo,
    favicon: val("company.favicon"),
    loginBackground: val("theme.login_background"),
    customDomain: val("company.custom_domain").toLowerCase(),
    email: {
      logo: val("email.brand_logo") || logo,
      header: val("email.brand_color") || primary,
      button: val("email.button_color") || primary,
      footer: val("email.footer_text") || `© ${year} ${companyName}. All rights reserved.`,
    },
    pdf: {
      logo: val("pdf.brand_logo") || logo,
      accent: val("pdf.accent_color") || primary,
      footer: val("pdf.footer_text"),
    },
  }
}

export function BrandingEngine() {
  const [activeId, setActiveId] = useState(GROUPS[0].id)
  const [values, setValues] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set())
  const [overriddenKeys, setOverriddenKeys] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/admin/company-settings")
      .then((r) => (r.ok ? r.json() : { values: {} }))
      .then((data) => {
        if (cancelled) return
        const incoming: Record<string, string> = {}
        for (const key of ALL_BRANDING_KEYS) {
          const raw = data?.values?.[key]
          if (raw != null) incoming[key] = String(raw)
        }
        setValues(incoming)
        setOverriddenKeys(new Set((data?.meta?.overriddenKeys ?? []).filter((k: string) => ALL_BRANDING_KEYS.includes(k))))
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const active = useMemo(() => GROUPS.find((g) => g.id === activeId) ?? GROUPS[0], [activeId])
  const derived = useMemo(() => deriveBranding(values), [values])
  const dirty = dirtyKeys.size > 0

  function setValue(key: string, value: string) {
    setValues((prev) => ({ ...prev, [key]: value }))
    setDirtyKeys((prev) => new Set(prev).add(key))
    setSavedAt(0)
  }

  function resetField(key: string) {
    setValue(key, "")
  }

  async function save() {
    const payload: Record<string, string> = {}
    for (const key of dirtyKeys) payload[key] = values[key] ?? ""
    if (Object.keys(payload).length === 0) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/company-settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ values: payload }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(body?.error || "Unable to save branding")
      }
      setOverriddenKeys((prev) => {
        const next = new Set(prev)
        for (const [key, value] of Object.entries(payload)) {
          if (value.trim() === "") next.delete(key)
          else next.add(key)
        }
        return next
      })
      setDirtyKeys(new Set())
      setSavedAt(Date.now())
      setTimeout(() => setSavedAt(0), 2500)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save branding")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-4 md:p-6">
      <header className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div className="flex items-start gap-4">
          <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Palette className="size-5" />
          </span>
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 155</span>
            <h1 className="text-2xl font-semibold tracking-tight text-balance">Branding Engine</h1>
            <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
              Configure logos, favicon, colours, company name, and email, document, login and custom-domain branding.
              Changes apply to this tenant only.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {savedAt > 0 && (
            <span className="flex items-center gap-1 text-sm text-emerald-500">
              <Check className="size-4" /> Saved
            </span>
          )}
          {error && <span className="max-w-[220px] text-sm text-destructive">{error}</span>}
          <Button onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save changes
          </Button>
        </div>
      </header>

      <div className="rounded-lg border border-primary/20 bg-primary/5 px-3.5 py-3 text-sm text-muted-foreground">
        These settings belong to the active tenant. Inherited platform values are shown until you save an override;
        clearing a field restores the inherited value. {overriddenKeys.size} branding override
        {overriddenKeys.size === 1 ? "" : "s"} currently active.
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Editor */}
        <div className="flex flex-col gap-4">
          <nav className="flex flex-wrap gap-1.5" aria-label="Branding sections">
            {GROUPS.map((g) => {
              const isActive = g.id === active.id
              const Icon = g.icon
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setActiveId(g.id)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-sm transition-colors",
                    isActive
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                >
                  <Icon className="size-4" />
                  {g.label}
                </button>
              )
            })}
          </nav>

          <section className="flex flex-col rounded-xl border border-border bg-card">
            <header className="flex items-start gap-3 border-b border-border p-5">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <active.icon className="size-5" />
              </span>
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-foreground">{active.label}</h2>
                <p className="text-sm text-muted-foreground">{active.description}</p>
              </div>
            </header>

            <div className="flex flex-col gap-5 p-5">
              {loading
                ? active.fields.map((f) => <div key={f.key} className="h-16 animate-pulse rounded-lg bg-muted" />)
                : active.fields.map((field) => (
                    <BrandingField
                      key={field.key}
                      field={field}
                      value={values[field.key] ?? ""}
                      overridden={overriddenKeys.has(field.key) || dirtyKeys.has(field.key)}
                      onChange={(v) => setValue(field.key, v)}
                      onReset={() => resetField(field.key)}
                    />
                  ))}
            </div>
          </section>
        </div>

        {/* Live preview */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <BrandingPreview groupId={active.id} b={derived} />
        </div>
      </div>
    </div>
  )
}

function BrandingField({
  field,
  value,
  overridden,
  onChange,
  onReset,
}: {
  field: FieldDef
  value: string
  overridden: boolean
  onChange: (v: string) => void
  onReset: () => void
}) {
  const id = `brand-${field.key}`
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{field.label}</Label>
        {overridden && value.trim() !== "" && (
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            <RotateCcw className="size-3" />
            Reset
          </button>
        )}
      </div>

      {field.type === "textarea" ? (
        <Textarea id={id} rows={3} placeholder={field.placeholder} value={value} onChange={(e) => onChange(e.target.value)} />
      ) : field.type === "select" ? (
        <select
          id={id}
          value={value || field.options?.[0] || ""}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
        >
          {field.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : field.type === "color" ? (
        <div className="flex items-center gap-2">
          <input
            id={id}
            type="color"
            value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-12 shrink-0 cursor-pointer rounded-lg border border-input bg-transparent p-0.5"
            aria-label={`${field.label} colour picker`}
          />
          <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} />
        </div>
      ) : (
        <Input
          id={id}
          type={field.type === "url" ? "url" : "text"}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}

      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
    </div>
  )
}

/** Small logo renderer with a graceful text fallback when the URL is empty/broken. */
function LogoOrName({
  logo,
  name,
  className,
  textClassName,
}: {
  logo: string
  name: string
  className?: string
  textClassName?: string
}) {
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [logo])
  if (logo && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={logo || "/placeholder.svg"} alt={name} className={className} onError={() => setFailed(true)} />
  }
  return <span className={textClassName}>{name}</span>
}

function BrandingPreview({ groupId, b }: { groupId: string; b: Derived }) {
  const showLogin = groupId === "login"
  const showEmail = groupId === "email"
  const showPdf = groupId === "pdf"
  const showDomain = groupId === "domain"
  const showApp = !showLogin && !showEmail && !showPdf && !showDomain

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Live preview</p>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {showApp && <AppPreview b={b} />}
        {showLogin && <LoginPreview b={b} />}
        {showEmail && <EmailPreview b={b} />}
        {showPdf && <PdfPreview b={b} />}
        {showDomain && <DomainPreview b={b} />}
      </div>
    </div>
  )
}

function AppPreview({ b }: { b: Derived }) {
  return (
    <div className="flex h-[320px]">
      <aside className="flex w-28 flex-col gap-3 p-3 text-white" style={{ background: b.sidebar }}>
        <LogoOrName
          logo={b.logo}
          name={b.appName}
          className="h-6 w-auto max-w-full object-contain"
          textClassName="truncate text-sm font-semibold"
        />
        <div className="mt-2 flex flex-col gap-1.5">
          <span className="rounded-md px-2 py-1 text-xs font-medium" style={{ background: b.primary }}>
            Dashboard
          </span>
          {["Finance", "HR", "Sales"].map((s) => (
            <span key={s} className="rounded-md px-2 py-1 text-xs text-white/70">
              {s}
            </span>
          ))}
        </div>
      </aside>
      <div className="flex flex-1 flex-col bg-background">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <span className="text-sm font-semibold text-foreground">{b.appName}</span>
          <span className="size-6 rounded-full" style={{ background: b.primary }} />
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div className="rounded-lg border border-border p-3">
            <p className="text-xs text-muted-foreground">Company</p>
            <p className="text-sm font-medium text-foreground">{b.companyName}</p>
          </div>
          <button
            type="button"
            className="w-fit rounded-md px-3 py-1.5 text-xs font-semibold text-white"
            style={{ background: b.primary }}
          >
            Primary action
          </button>
        </div>
      </div>
    </div>
  )
}

function LoginPreview({ b }: { b: Derived }) {
  return (
    <div className="flex h-[320px]">
      <div
        className="relative hidden flex-1 flex-col justify-between p-5 text-white sm:flex"
        style={
          b.loginBackground
            ? { backgroundImage: `url(${b.loginBackground})`, backgroundSize: "cover", backgroundPosition: "center" }
            : { background: b.sidebar }
        }
      >
        {b.loginBackground && <div className="absolute inset-0" style={{ background: `${b.sidebar}cc` }} aria-hidden />}
        <div className="relative inline-flex w-fit items-center rounded-lg bg-white px-2.5 py-1.5 shadow-sm">
          <LogoOrName
            logo={b.loginLogo}
            name={b.companyName}
            className="h-5 w-auto max-w-[120px] object-contain"
            textClassName="text-sm font-semibold text-slate-900"
          />
        </div>
        <p className="relative max-w-[200px] text-sm font-medium leading-snug">
          One workspace to run every part of the business.
        </p>
      </div>
      <div className="flex flex-1 flex-col justify-center gap-3 bg-background p-5">
        <p className="text-base font-semibold text-foreground">Sign in</p>
        <div className="h-8 rounded-md border border-border bg-muted/40" />
        <div className="h-8 rounded-md border border-border bg-muted/40" />
        <button type="button" className="h-8 rounded-md text-xs font-semibold text-white" style={{ background: b.primary }}>
          Sign in
        </button>
      </div>
    </div>
  )
}

function EmailPreview({ b }: { b: Derived }) {
  return (
    <div className="flex flex-col gap-3 bg-muted/40 p-5">
      <div className="mx-auto w-full max-w-[360px] overflow-hidden rounded-xl bg-white shadow-sm">
        <div className="px-5 py-4" style={{ background: b.email.header }}>
          <LogoOrName
            logo={b.email.logo}
            name={b.companyName}
            className="h-6 w-auto max-w-[160px] object-contain"
            textClassName="text-base font-bold text-white"
          />
        </div>
        <div className="flex flex-col gap-3 px-5 py-5 text-sm text-slate-700">
          <p className="font-medium text-slate-900">Hi there,</p>
          <p>Your invoice is ready. You can review and pay it using the button below.</p>
          <button
            type="button"
            className="w-fit rounded-lg px-4 py-2 text-xs font-semibold text-white"
            style={{ background: b.email.button }}
          >
            View invoice
          </button>
        </div>
        <div className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">{b.email.footer}</div>
      </div>
    </div>
  )
}

function PdfPreview({ b }: { b: Derived }) {
  return (
    <div className="flex flex-col gap-3 bg-muted/40 p-5">
      <div className="mx-auto flex aspect-[1/1.2] w-full max-w-[300px] flex-col bg-white p-5 shadow-sm">
        <div className="flex items-start justify-between">
          <LogoOrName
            logo={b.pdf.logo}
            name={b.companyName}
            className="h-7 w-auto max-w-[120px] object-contain"
            textClassName="text-sm font-bold text-slate-900"
          />
          <span className="text-lg font-bold uppercase tracking-wide" style={{ color: b.pdf.accent }}>
            Invoice
          </span>
        </div>
        <div className="mt-1 h-1 w-full rounded" style={{ background: b.pdf.accent }} />
        <div className="mt-4 flex flex-col gap-1.5 text-[11px] text-slate-600">
          <p className="font-semibold text-slate-900">{b.companyName}</p>
          <div className="mt-2 flex justify-between border-b border-slate-100 pb-1">
            <span>Services</span>
            <span>₹ 12,000.00</span>
          </div>
          <div className="flex justify-between border-b border-slate-100 pb-1">
            <span>Tax (18%)</span>
            <span>₹ 2,160.00</span>
          </div>
          <div className="flex justify-between font-semibold text-slate-900">
            <span>Total</span>
            <span style={{ color: b.pdf.accent }}>₹ 14,160.00</span>
          </div>
        </div>
        <div className="mt-auto border-t border-slate-100 pt-2 text-[10px] text-slate-400">
          {b.pdf.footer || `${b.companyName} — generated document`}
        </div>
      </div>
    </div>
  )
}

function DomainPreview({ b }: { b: Derived }) {
  const domain = b.customDomain || "portal.yourcompany.com"
  return (
    <div className="flex flex-col gap-4 p-5">
      <div className="overflow-hidden rounded-lg border border-border">
        <div className="flex items-center gap-2 border-b border-border bg-muted/60 px-3 py-2">
          <span className="size-2.5 rounded-full bg-red-400" />
          <span className="size-2.5 rounded-full bg-amber-400" />
          <span className="size-2.5 rounded-full bg-emerald-400" />
          <div className="ml-2 flex flex-1 items-center gap-2 rounded-md bg-background px-2.5 py-1 text-xs text-muted-foreground">
            {b.favicon ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.favicon || "/placeholder.svg"} alt="" className="size-3.5 rounded-sm object-contain" />
            ) : (
              <span className="size-3.5 rounded-sm" style={{ background: b.primary }} />
            )}
            <span className="truncate">https://{domain}/login</span>
          </div>
        </div>
        <div className="flex items-center gap-2 bg-background px-3 py-3">
          <div className="inline-flex items-center rounded-md bg-white px-2 py-1 shadow-sm">
            <LogoOrName
              logo={b.loginLogo}
              name={b.companyName}
              className="h-4 w-auto max-w-[90px] object-contain"
              textClassName="text-xs font-semibold text-slate-900"
            />
          </div>
          <span className="text-xs text-muted-foreground">{b.appName}</span>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {b.customDomain
          ? "Add a CNAME record pointing this hostname at the app. Branding resolves from the domain before sign-in."
          : "Enter a custom domain to serve the workspace from your own hostname."}
      </p>
    </div>
  )
}

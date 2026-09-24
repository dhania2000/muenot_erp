"use client"

import { useState } from "react"
import {
  Globe,
  Plus,
  Loader2,
  Trash2,
  ShieldCheck,
  Lock,
  Copy,
  Check,
  RefreshCw,
  CircleCheck,
  Power,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import type { PublicTenantDomain } from "@/lib/custom-domain-store"
import type { DomainStatus } from "@/lib/custom-domain"

type TlsInfo = { summary: string; points: readonly string[] }

const STATUS_META: Record<DomainStatus, { label: string; className: string }> = {
  pending: { label: "Pending verification", className: "bg-amber-500/15 text-amber-700 dark:text-amber-400" },
  verified: { label: "Verified", className: "bg-sky-500/15 text-sky-700 dark:text-sky-400" },
  active: { label: "Active", className: "bg-emerald-600 text-white" },
  disabled: { label: "Disabled", className: "bg-muted text-muted-foreground" },
  failed: { label: "Verification failed", className: "bg-destructive/15 text-destructive" },
}

function StatusBadge({ status }: { status: DomainStatus }) {
  const meta = STATUS_META[status]
  return <Badge className={`border-transparent ${meta.className}`}>{meta.label}</Badge>
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          /* clipboard unavailable */
        }
      }}
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? <Check className="size-3.5 text-emerald-600" /> : <Copy className="size-3.5" />}
    </Button>
  )
}

function Header() {
  return (
    <header className="flex items-start gap-4">
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-xl bg-muted text-primary">
        <Globe className="size-5" />
      </span>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">SPEC 157</span>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">Custom Domain</h1>
        <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
          Serve your workspace from your own domain, e.g. <code className="font-mono">erp.yourcompany.com</code>, with
          automatic HTTPS and DNS-based ownership verification.
        </p>
      </div>
    </header>
  )
}

export function CustomDomainClient({
  entitled,
  initialDomains,
  cnameTarget,
  tls,
}: {
  entitled: boolean
  initialDomains: PublicTenantDomain[]
  cnameTarget: string
  tls: TlsInfo
}) {
  const [domains, setDomains] = useState<PublicTenantDomain[]>(initialDomains)
  const [hostname, setHostname] = useState("")
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  function upsert(domain: PublicTenantDomain) {
    setDomains((prev) => {
      const idx = prev.findIndex((d) => d.id === domain.id)
      if (idx === -1) return [domain, ...prev]
      const next = [...prev]
      next[idx] = domain
      return next
    })
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault()
    if (!hostname.trim()) return
    setAdding(true)
    setError(null)
    try {
      const res = await fetch("/api/admin/custom-domain", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostname }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Could not add domain.")
        return
      }
      upsert(data.domain)
      setHostname("")
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setAdding(false)
    }
  }

  async function act(id: number, path: string, body?: unknown) {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/custom-domain/${id}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.error ?? "Action failed.")
        return
      }
      if (data.domain) upsert(data.domain)
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusyId(null)
    }
  }

  async function remove(id: number) {
    setBusyId(id)
    setError(null)
    try {
      const res = await fetch(`/api/admin/custom-domain/${id}`, { method: "DELETE" })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setError(data.error ?? "Could not remove domain.")
        return
      }
      setDomains((prev) => prev.filter((d) => d.id !== id))
    } catch {
      setError("Network error. Please try again.")
    } finally {
      setBusyId(null)
    }
  }

  if (!entitled) {
    return (
      <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
        <Header />
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <span className="inline-flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
              <Lock className="size-5" />
            </span>
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold">Available on the Enterprise plan</h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Custom domains let you serve the workspace from your own hostname with managed TLS. Upgrade your plan to
                enable this feature.
              </p>
            </div>
            <Button asChild className="mt-2">
              <a href="/admin/billing">View plans</a>
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col gap-6 p-4 md:p-6">
      <Header />

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Add a domain</CardTitle>
          <CardDescription>
            Enter the exact hostname your users will visit. Subdomains such as{" "}
            <code className="font-mono">erp.yourcompany.com</code> are recommended.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAdd} className="flex flex-col gap-3 sm:flex-row">
            <Input
              value={hostname}
              onChange={(e) => setHostname(e.target.value)}
              placeholder="erp.yourcompany.com"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="font-mono"
              disabled={adding}
            />
            <Button type="submit" disabled={adding || !hostname.trim()} className="sm:w-auto">
              {adding ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
              Add domain
            </Button>
          </form>
        </CardContent>
      </Card>

      {domains.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
            <Globe className="size-6" />
            <p className="text-sm">No custom domains yet. Add one above to get started.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-4">
          {domains.map((d) => (
            <Card key={d.id}>
              <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
                <div className="flex flex-col gap-1">
                  <CardTitle className="flex items-center gap-2 font-mono text-base">{d.hostname}</CardTitle>
                  <div className="flex items-center gap-2">
                    <StatusBadge status={d.status} />
                    {d.lastError && d.status === "failed" && (
                      <span className="text-xs text-muted-foreground">{d.lastError}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {d.status !== "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => act(d.id, "/verify")}
                      disabled={busyId === d.id}
                    >
                      {busyId === d.id ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
                      Verify
                    </Button>
                  )}
                  {(d.status === "verified" || d.status === "disabled") && (
                    <Button size="sm" onClick={() => act(d.id, "/activate", { active: true })} disabled={busyId === d.id}>
                      <CircleCheck className="size-4" />
                      Activate
                    </Button>
                  )}
                  {d.status === "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => act(d.id, "/activate", { active: false })}
                      disabled={busyId === d.id}
                    >
                      <Power className="size-4" />
                      Deactivate
                    </Button>
                  )}
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="ghost" size="icon" className="size-8 text-muted-foreground" disabled={busyId === d.id}>
                        <Trash2 className="size-4" />
                        <span className="sr-only">Remove domain</span>
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>Remove {d.hostname}?</AlertDialogTitle>
                        <AlertDialogDescription>
                          This stops serving the workspace on this domain and deletes its verification record. You can
                          add it again later.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>Cancel</AlertDialogCancel>
                        <AlertDialogAction
                          onClick={() => remove(d.id)}
                          className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                        >
                          Remove
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              </CardHeader>

              {d.status !== "active" && (
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm text-muted-foreground">
                    Add these records at your DNS provider, then click <span className="font-medium">Verify</span>.
                  </p>
                  <div className="overflow-hidden rounded-lg border">
                    {d.dns.map((rec, i) => (
                      <div
                        key={rec.type}
                        className={`flex flex-col gap-2 p-3 sm:flex-row sm:items-center ${i > 0 ? "border-t" : ""}`}
                      >
                        <Badge variant="outline" className="w-fit font-mono">
                          {rec.type}
                        </Badge>
                        <div className="grid flex-1 gap-1">
                          <div className="flex items-center gap-1">
                            <span className="truncate font-mono text-sm">{rec.host}</span>
                            <CopyButton value={rec.host} />
                            <span className="text-muted-foreground">→</span>
                            <span className="truncate font-mono text-sm">{rec.value}</span>
                            <CopyButton value={rec.value} />
                          </div>
                          <span className="text-xs text-muted-foreground">{rec.purpose}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="size-4 text-emerald-600" />
            TLS &amp; certificates
          </CardTitle>
          <CardDescription>{tls.summary}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2">
            {tls.points.map((p) => (
              <li key={p} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-emerald-600" />
                <span>{p}</span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-xs text-muted-foreground">
            All custom domains route to <code className="font-mono">{cnameTarget}</code>.
          </p>
        </CardContent>
      </Card>
    </div>
  )
}

"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
import { FileText, Lock, Eye, Download, ShieldAlert, Loader2, LogIn } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  shareDenialMessage,
  type ShareDecision,
  type ShareDenialReason,
} from "@/lib/dms/model"

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">{children}</Card>
    </main>
  )
}

/** Terminal states where nothing can be done (bad token, revoked, expired…). */
export function ShareUnavailable({ reason }: { reason: ShareDenialReason | "not_found" | string }) {
  const message = reason === "not_found" ? "This link is not available." : shareDenialMessage(reason as ShareDenialReason)
  return (
    <Shell>
      <CardHeader className="items-center text-center">
        <span className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-destructive/10 text-destructive">
          <ShieldAlert className="size-6" />
        </span>
        <CardTitle>Link unavailable</CardTitle>
        <CardDescription>{message}</CardDescription>
      </CardHeader>
    </Shell>
  )
}

export function ShareLanding({
  token,
  title,
  recipientLabel,
  canDownload,
  hasPassword,
  unlocked,
  decision,
  redirectError,
}: {
  token: string
  title: string
  recipientLabel: string
  canDownload: boolean
  hasPassword: boolean
  unlocked: boolean
  decision: ShareDecision
  redirectError: string | null
}) {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A denial that came back from the signed route (e.g. the download cap was hit
  // between page load and the click) always wins over the initial evaluation.
  const reason: ShareDenialReason | null = redirectError
    ? (redirectError as ShareDenialReason)
    : decision.ok
      ? null
      : decision.reason

  const needsPassword = reason === "password_required" || (hasPassword && !unlocked)
  const loginRequired = reason === "login_required"

  // Hard blocks that the visitor cannot resolve from this page.
  if (reason && !needsPassword && !loginRequired) {
    return <ShareUnavailable reason={reason} />
  }

  if (loginRequired) {
    return (
      <Shell>
        <CardHeader className="items-center text-center">
          <span className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <LogIn className="size-6" />
          </span>
          <CardTitle>Sign-in required</CardTitle>
          <CardDescription>{shareDenialMessage("login_required")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild className="w-full">
            <a href={`/login?redirect=${encodeURIComponent(`/d/${token}`)}`}>Sign in to continue</a>
          </Button>
        </CardContent>
      </Shell>
    )
  }

  async function unlock(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/dms/share/${token}/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body?.error || "Incorrect password")
      setPassword("")
      router.refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (needsPassword) {
    return (
      <Shell>
        <CardHeader className="items-center text-center">
          <span className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Lock className="size-6" />
          </span>
          <CardTitle>Password protected</CardTitle>
          <CardDescription className="truncate">{title}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={unlock} className="grid gap-3">
            <div className="grid gap-1.5 text-left">
              <Label htmlFor="share-password">Enter password to continue</Label>
              <Input
                id="share-password"
                type="password"
                autoComplete="off"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                aria-invalid={error ? true : undefined}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
            </div>
            <Button type="submit" disabled={busy || !password}>
              {busy ? <Loader2 className="mr-1.5 size-4 animate-spin" /> : <Lock className="mr-1.5 size-4" />}
              Unlock
            </Button>
          </form>
        </CardContent>
      </Shell>
    )
  }

  // Access granted — offer the allowed actions. Both open in a new tab so the
  // signed redirect (and any resulting denial) never replaces this page.
  function open(intent: "view" | "download") {
    window.open(`/api/dms/share/${token}?intent=${intent}`, "_blank", "noopener,noreferrer")
  }

  return (
    <Shell>
      <CardHeader className="items-center text-center">
        <span className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-primary/10 text-primary">
          <FileText className="size-6" />
        </span>
        <CardTitle className="truncate">{title}</CardTitle>
        <CardDescription>Someone has shared this document with you.</CardDescription>
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <Badge variant="outline">{recipientLabel}</Badge>
          <Badge variant="outline">{canDownload ? "Download allowed" : "View only"}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-2">
        <Button onClick={() => open("view")}>
          <Eye className="mr-1.5 size-4" /> View document
        </Button>
        {canDownload && (
          <Button variant="outline" onClick={() => open("download")}>
            <Download className="mr-1.5 size-4" /> Download
          </Button>
        )}
      </CardContent>
    </Shell>
  )
}

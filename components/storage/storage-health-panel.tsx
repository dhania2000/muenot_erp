"use client"

import { useState } from "react"
import { Activity, CheckCircle2, XCircle, MinusCircle, Loader2, Stethoscope } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { cn } from "@/lib/utils"
import type { HealthCheckResult } from "@/lib/storage/types"

type HealthState = {
  ok: boolean
  message: string
  target?: string
  checks?: HealthCheckResult[]
}

export function StorageHealthPanel() {
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<HealthState | null>(null)

  async function runCheck() {
    setRunning(true)
    setResult(null)
    try {
      const res = await fetch("/api/admin/storage/health")
      const data = await res.json()
      setResult({
        ok: Boolean(data.ok),
        message: data.message || data.error || "Unknown result",
        target: data.target,
        checks: data.report?.checks,
      })
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || "Request failed" })
    } finally {
      setRunning(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Stethoscope className="size-5 text-primary" />
              Storage Health Checkup
            </CardTitle>
            <CardDescription className="mt-1 max-w-2xl">
              Run a full diagnostic against your active storage — connectivity, credentials, bucket access, and
              read / write / delete / multipart capability — to confirm uploads will work before you rely on it.
            </CardDescription>
          </div>
          <Button size="sm" onClick={runCheck} disabled={running}>
            {running ? <Loader2 className="size-4 animate-spin" /> : <Activity className="size-4" />}
            Run health check
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {!result && !running && (
          <div className="rounded-lg border border-dashed border-border py-10 text-center text-sm text-muted-foreground">
            No checkup run yet. Click “Run health check” to diagnose your active storage.
          </div>
        )}

        {running && (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Running diagnostics…
          </div>
        )}

        {result && (
          <div className="flex flex-col gap-3">
            {result.target && (
              <p className="text-sm text-muted-foreground">
                Target: <span className="font-medium text-foreground">{result.target}</span>
              </p>
            )}
            <div
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm",
                result.ok
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                  : "bg-destructive/10 text-destructive",
              )}
            >
              {result.ok ? <CheckCircle2 className="size-4 shrink-0" /> : <XCircle className="size-4 shrink-0" />}
              {result.message}
            </div>
            {result.checks && result.checks.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-md border border-border p-2">
                {result.checks.map((c) => (
                  <li key={c.id} className="flex items-start gap-2 px-1 py-1 text-sm">
                    {c.status === "pass" ? (
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                    ) : c.status === "fail" ? (
                      <XCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
                    ) : (
                      <MinusCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-medium">{c.label}</span>
                        {c.status !== "skip" && c.durationMs > 0 && (
                          <span className="shrink-0 text-xs text-muted-foreground">{c.durationMs} ms</span>
                        )}
                      </div>
                      {c.detail && (
                        <p
                          className={cn(
                            "text-xs",
                            c.status === "fail" ? "text-destructive" : "text-muted-foreground",
                          )}
                        >
                          {c.detail}
                        </p>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

import { useState } from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { HealthDetail } from "@/components/customer-success/health-detail"
import type { TenantHealthDetail } from "@/lib/customer-success/store"

const fetcher = async (url: string) => {
  const res = await fetch(url, { cache: "no-store" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(body.error ?? "Request failed")
  return body
}

export function TenantCustomerSuccess() {
  const { data, error, mutate } = useSWR<TenantHealthDetail>("/api/admin/customer-success", fetcher)
  const [retention, setRetention] = useState<string>("")
  const [message, setMessage] = useState("")
  const [saving, setSaving] = useState(false)

  async function save(patch: Record<string, unknown>) {
    setSaving(true)
    setMessage("")
    try {
      const res = await fetch("/api/admin/customer-success/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error ?? "Failed to save")
      setMessage(body.changed ? `Saved.${body.purgedEvents ? ` ${body.purgedEvents} raw event(s) purged.` : ""}` : "No changes.")
      await mutate()
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Failed to save")
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 p-6 md:p-8">
      <header>
        <h1 className="text-2xl font-semibold text-balance">Customer health</h1>
        <p className="text-sm text-muted-foreground text-pretty">
          Your organization&apos;s health score and product usage. Only your own tenant is shown.
        </p>
      </header>
      {error ? (
        <p className="text-sm text-destructive" role="alert">{error.message}</p>
      ) : !data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <HealthDetail data={data} />
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Analytics privacy</CardTitle>
              <CardDescription>
                Usage events store only module, feature and action with a pseudonymous user id — never record content.
                Opting out erases stored raw events immediately.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="text-sm">
                  Usage analytics are <strong>{data.settings.analyticsOptOut ? "disabled" : "enabled"}</strong> for your organization.
                </div>
                <Button
                  variant={data.settings.analyticsOptOut ? "default" : "outline"}
                  disabled={saving}
                  onClick={() => save({ analyticsOptOut: !data.settings.analyticsOptOut })}
                >
                  {data.settings.analyticsOptOut ? "Enable analytics" : "Opt out of analytics"}
                </Button>
              </div>
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  const n = Number(retention)
                  if (Number.isInteger(n)) void save({ retentionDays: n })
                }}
              >
                <label className="flex flex-col gap-1 text-xs font-medium">
                  Raw event retention (days, 30-730)
                  <Input
                    type="number"
                    min={30}
                    max={730}
                    className="w-40"
                    placeholder={String(data.settings.retentionDays)}
                    value={retention}
                    onChange={(e) => setRetention(e.target.value)}
                  />
                </label>
                <Button type="submit" variant="outline" disabled={saving || !retention}>Save retention</Button>
              </form>
              {message && <p className="text-sm text-muted-foreground" role="status">{message}</p>}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

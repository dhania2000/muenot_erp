"use client"

import { useEffect } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Mail, MailCheck } from "lucide-react"

type GoogleStatus = {
  oauthConfigured: boolean
  connected: boolean
  email: string | null
  mailboxConnected: boolean
}

/**
 * Lets an employee connect their own Google mailbox so this department's emails
 * are sent from their personal account — no per-department SMTP env vars needed.
 * Reuses the same Google OAuth flow as Calendar / Meet; `scope=email` requests
 * the gmail.send permission and `include_granted_scopes` keeps it additive.
 */
export function ConnectEmailPanel({ returnPath }: { returnPath: string }) {
  const { data, mutate } = useSWR<GoogleStatus>("/api/sales/google/status", fetcher)

  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const status = params.get("google")
    if (!status) return
    if (status === "connected") toast.success("Email account connected")
    else if (status === "notconfigured")
      toast.error("Google is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.")
    else if (status === "noretoken") toast.error("Google did not grant access. Please try connecting again.")
    else toast.error("Could not connect your email account")
    params.delete("google")
    const next = params.toString()
    window.history.replaceState({}, "", window.location.pathname + (next ? `?${next}` : ""))
    mutate()
  }, [mutate])

  async function disconnect() {
    await fetch("/api/sales/google/disconnect", { method: "POST" })
    toast.success("Email account disconnected")
    mutate()
  }

  if (!data?.oauthConfigured) return null

  const connectHref = `/api/sales/google/connect?scope=email&return=${encodeURIComponent(returnPath)}`
  const connected = data.mailboxConnected

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card px-4 py-3">
      <div className="flex items-start gap-2 text-sm">
        {connected ? (
          <MailCheck className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
        ) : (
          <Mail className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        {connected ? (
          <span>
            Sending as <span className="font-medium">{data.email}</span>. Emails you send from here go out
            from your own connected mailbox.
          </span>
        ) : (
          <span className="text-muted-foreground">
            Connect your email account to send emails from your own mailbox — no environment variables needed.
          </span>
        )}
      </div>
      {connected ? (
        <Button variant="outline" size="sm" onClick={disconnect}>
          Disconnect
        </Button>
      ) : (
        <Button size="sm" onClick={() => (window.location.href = connectHref)}>
          Connect your email
        </Button>
      )}
    </div>
  )
}

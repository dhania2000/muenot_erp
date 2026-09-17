"use client"

import { useCallback, useEffect, useState } from "react"
import { CheckCircle2, XCircle, Clock, LogOut, Loader2, ShieldAlert } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"

type Verification = {
  result: string
  approved: boolean
  title: string
  message: string
  event?: { name: string; venue: string | null; startAt: string; endAt: string; status: string }
  employee?: {
    name: string | null
    designation: string | null
    department: string | null
    employmentStatus: string | null
    dob: string | null
    photoUrl: string | null
  }
  accessStatus?: string
  checkedInAt?: string | null
  checkedOutAt?: string | null
}

function fmt(dt?: string | null) {
  if (!dt) return "—"
  const d = new Date(String(dt).replace(" ", "T"))
  if (Number.isNaN(d.getTime())) return String(dt)
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

export function ScanClient({ token }: { token: string }) {
  const [state, setState] = useState<Verification | null>(null)
  const [loading, setLoading] = useState(true)
  const [acting, setActing] = useState(false)

  const call = useCallback(
    async (action: "verify" | "checkin" | "checkout") => {
      const res = await fetch(`/api/event-access/scan/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      })
      return (await res.json()) as Verification
    },
    [token],
  )

  useEffect(() => {
    let active = true
    setLoading(true)
    call("verify")
      .then((v) => active && setState(v))
      .catch(() =>
        active &&
        setState({ result: "INVALID_TOKEN", approved: false, title: "Error", message: "Could not verify this QR. Please try again." }),
      )
      .finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [call])

  const doAction = async (action: "checkin" | "checkout") => {
    setActing(true)
    try {
      setState(await call(action))
    } finally {
      setActing(false)
    }
  }

  const approved = state?.approved
  const canCheckIn = state && (state.result === "APPROVED" && state.accessStatus !== "checked_in" && state.accessStatus !== "checked_out")
  const canCheckOut = state && (state.accessStatus === "checked_in")

  const Accent = () => {
    if (loading) return <Loader2 className="size-16 animate-spin text-muted-foreground" />
    if (!state) return null
    if (state.result === "ALREADY_CHECKED_IN") return <Clock className="size-16 text-amber-500" />
    if (state.result === "CHECKED_OUT") return <LogOut className="size-16 text-sky-500" />
    if (approved) return <CheckCircle2 className="size-16 text-emerald-500" />
    if (state.result === "INACTIVE_EMPLOYEE" || state.result === "NOT_AUTHORIZED" || state.result === "QR_REVOKED")
      return <ShieldAlert className="size-16 text-destructive" />
    return <XCircle className="size-16 text-destructive" />
  }

  return (
    <Card className="w-full max-w-md overflow-hidden shadow-lg">
      <CardHeader className="items-center gap-3 border-b bg-card pb-6 pt-8 text-center">
        <div className="flex flex-col items-center gap-3">
          <Accent />
          <div>
            <h1 className="text-xl font-semibold tracking-tight">{loading ? "Verifying…" : state?.title}</h1>
            {!loading && <p className="mt-1 text-sm text-muted-foreground">{state?.message}</p>}
          </div>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-5 p-6">
        {state?.event && (
          <section className="rounded-lg border bg-muted/30 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Event</p>
            <p className="mt-1 font-medium">{state.event.name}</p>
            <p className="text-sm text-muted-foreground">{fmt(state.event.startAt)}</p>
            {state.event.venue && <p className="text-sm text-muted-foreground">{state.event.venue}</p>}
          </section>
        )}

        {state?.employee && (
          <section className="flex items-center gap-4">
            {state.employee.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={state.employee.photoUrl || "/placeholder.svg"}
                alt={state.employee.name ?? "Employee photo"}
                className="size-16 rounded-full object-cover ring-2 ring-border"
              />
            ) : (
              <div className="flex size-16 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground">
                {(state.employee.name ?? "?").slice(0, 1).toUpperCase()}
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate font-medium">{state.employee.name}</p>
              <p className="truncate text-sm text-muted-foreground">
                {[state.employee.designation, state.employee.department].filter(Boolean).join(" · ") || "—"}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <Badge variant={state.employee.employmentStatus?.toLowerCase() === "active" ? "secondary" : "destructive"}>
                  {state.employee.employmentStatus ?? "Unknown"}
                </Badge>
                {state.employee.dob && <span className="text-xs text-muted-foreground">DOB {fmt(state.employee.dob)}</span>}
              </div>
            </div>
          </section>
        )}

        {(state?.checkedInAt || state?.checkedOutAt) && (
          <section className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Checked in</p>
              <p className="font-medium">{fmt(state.checkedInAt)}</p>
            </div>
            <div className="rounded-md border p-3">
              <p className="text-xs text-muted-foreground">Checked out</p>
              <p className="font-medium">{fmt(state.checkedOutAt)}</p>
            </div>
          </section>
        )}

        {(canCheckIn || canCheckOut) && (
          <div className="flex flex-col gap-2">
            {canCheckIn && (
              <Button size="lg" disabled={acting} onClick={() => doAction("checkin")}>
                {acting ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                Confirm Check-In
              </Button>
            )}
            {canCheckOut && (
              <Button size="lg" variant="outline" disabled={acting} onClick={() => doAction("checkout")}>
                {acting ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
                Check Out
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

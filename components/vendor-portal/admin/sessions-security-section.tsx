"use client"

import { useState } from "react"
import { toast } from "sonner"
import { MonitorSmartphone, ShieldCheck, LogOut, Lock } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { SectionHeader, StatusBadge, EmptyState, AdminTable, type Column } from "./shared"
import { PORTAL_SESSIONS } from "./mock-data"

const SESSION_COLUMNS: Column[] = [
  { key: "vendor", header: "Vendor" },
  { key: "user", header: "User" },
  { key: "device", header: "Device" },
  { key: "browser", header: "Browser" },
  { key: "ip", header: "IP" },
  { key: "login", header: "Login" },
  { key: "lastActivity", header: "Last Activity" },
  { key: "status", header: "Status" },
  { key: "actions", header: "" },
]

const TOGGLES = [
  { label: "Require multi-factor authentication", desc: "Enforce MFA for all vendor portal users", on: true },
  { label: "Require email verification", desc: "Users must verify email before first login", on: true },
  { label: "Enforce account lockout", desc: "Lock accounts after repeated failed logins", on: true },
  { label: "Limit concurrent sessions", desc: "Restrict simultaneous active sessions per user", on: false },
  { label: "Restrict to trusted domains", desc: "Only allow logins from approved email domains", on: false },
]

const NUMERIC = [
  { label: "Failed login threshold", value: "5", suffix: "attempts" },
  { label: "Session timeout", value: "30", suffix: "minutes" },
  { label: "Concurrent sessions", value: "3", suffix: "per user" },
  { label: "Invitation expiry", value: "7", suffix: "days" },
]

export function SessionsSecuritySection() {
  const [tab, setTab] = useState("sessions")

  return (
    <div className="grid gap-4">
      <SectionHeader
        title="Sessions & Security"
        description="Monitor active vendor portal sessions and configure portal-wide security policies."
        icon={MonitorSmartphone}
        actions={
          tab === "sessions" ? (
            <Button variant="destructive" size="sm" onClick={() => toast.success("All sessions revoked")}>
              <LogOut className="size-4" /> Revoke All Sessions
            </Button>
          ) : (
            <Button size="sm" onClick={() => toast.success("Security settings saved")}>
              Save settings
            </Button>
          )
        }
      />

      <Tabs value={tab} onValueChange={(v) => setTab(v as string)} className="gap-4">
        <TabsList variant="line">
          <TabsTrigger value="sessions">
            <MonitorSmartphone className="size-4" /> Active Sessions
          </TabsTrigger>
          <TabsTrigger value="security">
            <ShieldCheck className="size-4" /> Security Settings
          </TabsTrigger>
        </TabsList>

        <TabsContent value="sessions">
          <AdminTable
            columns={SESSION_COLUMNS}
            rows={PORTAL_SESSIONS}
            empty={<EmptyState icon={MonitorSmartphone} title="No active sessions" />}
            render={(s, key) => {
              switch (key) {
                case "vendor":
                  return <span className="font-medium">{s.vendor}</span>
                case "user":
                  return <span className="text-muted-foreground">{s.user}</span>
                case "device":
                  return s.device
                case "browser":
                  return <span className="text-muted-foreground">{s.browser}</span>
                case "ip":
                  return <span className="font-mono text-xs">{s.ip}</span>
                case "login":
                  return <span className="text-muted-foreground">{s.login}</span>
                case "lastActivity":
                  return <span className="text-muted-foreground">{s.lastActivity}</span>
                case "status":
                  return <StatusBadge status={s.status === "idle" ? "pending" : s.status === "expired" ? "neutral" : "active"} label={s.status} />
                case "actions":
                  return (
                    <Button size="xs" variant="ghost" onClick={() => toast.success("Session revoked")}>
                      <LogOut className="size-3.5" /> Revoke
                    </Button>
                  )
                default:
                  return null
              }
            }}
          />
        </TabsContent>

        <TabsContent value="security" className="grid gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Authentication policies</CardTitle>
              <CardDescription>Portal-wide login and account protection rules</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2">
              {TOGGLES.map((t) => (
                <div
                  key={t.label}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5"
                >
                  <div className="grid gap-0.5">
                    <span className="text-sm font-medium">{t.label}</span>
                    <span className="text-xs text-muted-foreground">{t.desc}</span>
                  </div>
                  <Switch defaultChecked={t.on} onCheckedChange={() => toast.success("Setting updated")} />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Thresholds</CardTitle>
              <CardDescription>Password policy, lockout and session limits</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {NUMERIC.map((n) => (
                <div key={n.label} className="grid gap-1.5">
                  <Label className="text-xs">{n.label}</Label>
                  <div className="flex items-center gap-2">
                    <Input defaultValue={n.value} className="w-20" />
                    <span className="text-xs text-muted-foreground">{n.suffix}</span>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Password policy</CardTitle>
              <CardDescription>Minimum requirements for vendor passwords</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {["Min 12 characters", "1 uppercase", "1 number", "1 special char", "No reuse (last 5)", "Expiry 90 days"].map(
                (p) => (
                  <span
                    key={p}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs"
                  >
                    <Lock className="size-3" /> {p}
                  </span>
                ),
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}

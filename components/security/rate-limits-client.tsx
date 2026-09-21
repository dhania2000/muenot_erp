"use client"

import { useState } from "react"
import { Gauge, Plus } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { EmptyState } from "@/components/security/security-ui"

type Scope = "tenant" | "api_key" | "endpoint"

type RateLimitRule = {
  id: string
  scope: Scope
  target: string
  minuteLimit: number
  hourLimit: number
  dayLimit: number
  burstLimit: number
}

const SCOPE_LABEL: Record<Scope, string> = { tenant: "Tenant", api_key: "API Key", endpoint: "Endpoint" }

/**
 * SPEC 53 — Rate limit configuration. No request-metering backend exists yet
 * (lib/rate-limit.ts only guards pre-auth login), so this is a frontend-only
 * prototype: rules are authored and previewed in local state, not persisted.
 * Current usage/remaining/status are always "Not connected" — never faked.
 */
export function RateLimitsClient() {
  const [rules, setRules] = useState<RateLimitRule[]>([])

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium">Rate limit rules (preview)</h2>
          <p className="text-sm text-muted-foreground">
            Configured here for review only — nothing is enforced until Codex wires request metering.
          </p>
        </div>
        <CreateRuleDialog onCreate={(rule) => setRules((r) => [...r, rule])} />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Gauge className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">Configured limits</CardTitle>
          </div>
          <CardDescription>Minute / hour / day / burst ceilings per scope.</CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <EmptyState icon={<Gauge className="size-5" />} title="No rate limit rules configured">
              Add a rule to preview how tenant, API key, or endpoint limits would be presented once enforcement
              exists.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Scope</TableHead>
                    <TableHead>Minute limit</TableHead>
                    <TableHead>Hour limit</TableHead>
                    <TableHead>Day limit</TableHead>
                    <TableHead>Burst limit</TableHead>
                    <TableHead>Current usage</TableHead>
                    <TableHead>Remaining</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>
                        <Badge variant="outline">{SCOPE_LABEL[r.scope]}</Badge>{" "}
                        <span className="text-sm text-muted-foreground">{r.target}</span>
                      </TableCell>
                      <TableCell>{r.minuteLimit}</TableCell>
                      <TableCell>{r.hourLimit}</TableCell>
                      <TableCell>{r.dayLimit}</TableCell>
                      <TableCell>{r.burstLimit}</TableCell>
                      <TableCell className="text-muted-foreground">Not connected</TableCell>
                      <TableCell className="text-muted-foreground">Not connected</TableCell>
                      <TableCell>
                        <Badge variant="outline">Unknown</Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function CreateRuleDialog({ onCreate }: { onCreate: (rule: RateLimitRule) => void }) {
  const [open, setOpen] = useState(false)
  const [scope, setScope] = useState<Scope>("tenant")
  const [target, setTarget] = useState("")
  const [minuteLimit, setMinuteLimit] = useState(60)
  const [hourLimit, setHourLimit] = useState(1000)
  const [dayLimit, setDayLimit] = useState(10000)
  const [burstLimit, setBurstLimit] = useState(20)

  function submit() {
    onCreate({
      id: crypto.randomUUID(),
      scope,
      target: target || "Default",
      minuteLimit,
      hourLimit,
      dayLimit,
      burstLimit,
    })
    setOpen(false)
    setTarget("")
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" /> Add rule
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure rate limit rule</DialogTitle>
          <DialogDescription>Preview only — this is not enforced until the backend exists.</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="grid gap-2">
            <Label>Scope</Label>
            <Select value={scope} onValueChange={(v) => setScope((v as Scope) ?? "tenant")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tenant">Tenant</SelectItem>
                <SelectItem value="api_key">API Key</SelectItem>
                <SelectItem value="endpoint">Endpoint</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="target">Target (name / key / path)</Label>
            <Input id="target" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="e.g. /api/v1/clients" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-2">
              <Label>Minute limit</Label>
              <Input type="number" min={1} value={minuteLimit} onChange={(e) => setMinuteLimit(Number(e.target.value))} />
            </div>
            <div className="grid gap-2">
              <Label>Hour limit</Label>
              <Input type="number" min={1} value={hourLimit} onChange={(e) => setHourLimit(Number(e.target.value))} />
            </div>
            <div className="grid gap-2">
              <Label>Day limit</Label>
              <Input type="number" min={1} value={dayLimit} onChange={(e) => setDayLimit(Number(e.target.value))} />
            </div>
            <div className="grid gap-2">
              <Label>Burst limit</Label>
              <Input type="number" min={1} value={burstLimit} onChange={(e) => setBurstLimit(Number(e.target.value))} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit}>Save rule</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

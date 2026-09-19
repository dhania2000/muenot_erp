"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Search } from "lucide-react"
import { toast } from "sonner"

export type Stat = { label: string; value: string; hint?: string }
export type Column = { key: string; label: string }
export type Row = Record<string, string>
export type ToggleGroup = { title: string; items: { label: string; description: string; enabled: boolean }[] }
export type ReportCard = { title: string; description: string; meta: string }

export type BillingModuleConfig = {
  title: string
  description: string
  primaryAction?: string
  actionKind?: "connect-gateway"
  layout: "table" | "settings" | "reports"
  stats?: Stat[]
  columns?: Column[]
  rows?: Row[]
  statusKey?: string
  toggleGroups?: ToggleGroup[]
  reports?: ReportCard[]
}

const STATUS_TONE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  paid: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  succeeded: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  connected: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  reconciled: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  matched: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  trialing: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  pending: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  "past due": "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  unmatched: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  processing: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  overdue: "bg-red-500/15 text-red-600 dark:text-red-400",
  failed: "bg-red-500/15 text-red-600 dark:text-red-400",
  canceled: "bg-red-500/15 text-red-600 dark:text-red-400",
  cancelled: "bg-red-500/15 text-red-600 dark:text-red-400",
  refunded: "bg-red-500/15 text-red-600 dark:text-red-400",
  expired: "bg-muted text-muted-foreground",
  draft: "bg-muted text-muted-foreground",
  disabled: "bg-muted text-muted-foreground",
}

function StatusBadge({ value }: { value: string }) {
  const tone = STATUS_TONE[value.toLowerCase()] ?? "bg-muted text-muted-foreground"
  return <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-medium ${tone}`}>{value}</span>
}

export function BillingModuleView({ config }: { config: BillingModuleConfig }) {
  const [query, setQuery] = useState("")
  const [rows, setRows] = useState<Row[]>(config.rows ?? [])
  const [actionOpen, setActionOpen] = useState(false)

  const filteredRows = rows.filter((row) =>
    query.trim() === ""
      ? true
      : Object.values(row).some((v) => v.toLowerCase().includes(query.trim().toLowerCase())),
  )

  function handleGatewayConnect(next: Row) {
    setRows((current) => {
      const idx = current.findIndex((r) => r.gateway?.toLowerCase() === next.gateway?.toLowerCase())
      if (idx === -1) return [...current, next]
      const copy = [...current]
      copy[idx] = { ...copy[idx], ...next }
      return copy
    })
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">{config.title}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{config.description}</p>
        </div>
        {config.primaryAction ? (
          <Button className="shrink-0" onClick={() => setActionOpen(true)}>
            {config.primaryAction}
          </Button>
        ) : null}
      </header>

      {config.actionKind === "connect-gateway" ? (
        <ConnectGatewayDialog
          open={actionOpen}
          onOpenChange={setActionOpen}
          existingGateways={rows.map((r) => r.gateway).filter(Boolean)}
          onConnect={handleGatewayConnect}
        />
      ) : config.primaryAction ? (
        <Dialog open={actionOpen} onOpenChange={setActionOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{config.primaryAction}</DialogTitle>
              <DialogDescription>
                This action isn&apos;t available in this environment yet.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setActionOpen(false)}>
                Close
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {config.stats && config.stats.length > 0 ? (
        <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
          {config.stats.map((stat) => (
            <Card key={stat.label}>
              <CardHeader className="pb-2">
                <CardTitle className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {stat.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-semibold text-foreground">{stat.value}</div>
                {stat.hint ? <p className="mt-1 text-xs text-muted-foreground">{stat.hint}</p> : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {config.layout === "table" ? (
        <Card className="mt-6">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base font-medium">Records</CardTitle>
            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search"
                className="pl-9"
              />
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    {(config.columns ?? []).map((col) => (
                      <TableHead key={col.key}>{col.label}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={(config.columns ?? []).length} className="h-24 text-center text-muted-foreground">
                        No records found.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredRows.map((row, i) => (
                      <TableRow key={i}>
                        {(config.columns ?? []).map((col) => (
                          <TableCell key={col.key}>
                            {config.statusKey === col.key ? (
                              <StatusBadge value={row[col.key] ?? ""} />
                            ) : (
                              <span className="text-sm text-foreground">{row[col.key] ?? "—"}</span>
                            )}
                          </TableCell>
                        ))}
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      ) : null}

      {config.layout === "settings" ? (
        <div className="mt-6 space-y-6">
          {(config.toggleGroups ?? []).map((group) => (
            <Card key={group.title}>
              <CardHeader>
                <CardTitle className="text-base font-medium">{group.title}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {group.items.map((item, idx) => (
                  <div key={item.label}>
                    {idx > 0 ? <Separator className="mb-4" /> : null}
                    <div className="flex items-start justify-between gap-4">
                      <div className="space-y-0.5">
                        <Label className="text-sm font-medium text-foreground">{item.label}</Label>
                        <p className="text-xs text-muted-foreground">{item.description}</p>
                      </div>
                      <Switch defaultChecked={item.enabled} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {config.layout === "reports" ? (
        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(config.reports ?? []).map((report) => (
            <Card key={report.title} className="flex flex-col">
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base font-medium">{report.title}</CardTitle>
                  <Badge variant="secondary" className="text-xs">
                    {report.meta}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-4">
                <p className="text-sm text-muted-foreground">{report.description}</p>
                <Button variant="outline" size="sm" className="w-fit">
                  View report
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  )
}

const GATEWAY_PRESETS: Record<string, { currencies: string; methods: string }> = {
  Stripe: { currencies: "USD, EUR, GBP", methods: "Card, UPI" },
  Razorpay: { currencies: "INR", methods: "Card, UPI, Netbanking" },
  PayPal: { currencies: "USD, EUR", methods: "Card, Wallet" },
}

function ConnectGatewayDialog({
  open,
  onOpenChange,
  existingGateways,
  onConnect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  existingGateways: string[]
  onConnect: (row: Row) => void
}) {
  const options = Object.keys(GATEWAY_PRESETS)
  const [gateway, setGateway] = useState(options[0])
  const [mode, setMode] = useState<"Test" | "Live">("Test")
  const [apiKey, setApiKey] = useState("")
  const [makeDefault, setMakeDefault] = useState(false)

  function reset() {
    setGateway(options[0])
    setMode("Test")
    setApiKey("")
    setMakeDefault(false)
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (apiKey.trim() === "") {
      toast.error("Enter an API key to connect the gateway.")
      return
    }
    const preset = GATEWAY_PRESETS[gateway]
    onConnect({
      gateway,
      mode,
      currencies: preset?.currencies ?? "—",
      methods: preset?.methods ?? "—",
      status: "Connected",
    })
    toast.success(`${gateway} connected in ${mode.toLowerCase()} mode.`)
    reset()
    onOpenChange(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset()
        onOpenChange(next)
      }}
    >
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Connect gateway</DialogTitle>
            <DialogDescription>
              Add API credentials for a payment processor to start collecting payments.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="gateway-select">Gateway</Label>
              <Select value={gateway} onValueChange={setGateway}>
                <SelectTrigger id="gateway-select">
                  <SelectValue placeholder="Select gateway" />
                </SelectTrigger>
                <SelectContent>
                  {options.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                      {existingGateways.some((g) => g.toLowerCase() === name.toLowerCase())
                        ? " (reconfigure)"
                        : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="gateway-mode">Environment</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as "Test" | "Live")}>
                <SelectTrigger id="gateway-mode">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Test">Test</SelectItem>
                  <SelectItem value="Live">Live</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label htmlFor="gateway-key">API secret key</Label>
              <Input
                id="gateway-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk_..."
                autoComplete="off"
              />
            </div>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border p-3">
              <div className="space-y-0.5">
                <Label className="text-sm font-medium">Set as default</Label>
                <p className="text-xs text-muted-foreground">
                  Use this gateway for new subscription and invoice charges.
                </p>
              </div>
              <Switch checked={makeDefault} onCheckedChange={setMakeDefault} />
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Connect</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

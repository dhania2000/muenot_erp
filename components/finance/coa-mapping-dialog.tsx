"use client"

import { useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Loader2Icon } from "lucide-react"

type Row = Record<string, any>
type RoleMappingRow = {
  role: string
  account_id: string | null
  effective_account_id: string | null
  effective_account_code: string | null
  effective_account_name: string | null
  default_code: string
  overridden: boolean
  active: boolean
}
type ConfigShape = {
  mappings: RoleMappingRow[]
  roleGroups: { group: string; roles: { role: string; label: string }[] }[]
  companyDefaults: { role: string; label: string; hint: string }[]
}

const CONFIG_ENDPOINT = "/api/finance/chart-of-accounts/config"

/**
 * Account mapping + company defaults. Both tabs write the SAME role rows through
 * the config endpoint (DB override wins over the seeded code default), so they
 * can never disagree. Only Active accounts are selectable as a mapping target.
 */
export function CoaMappingDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  accounts: Row[]
}) {
  const { data, mutate, isLoading } = useSWR<ConfigShape>(open ? CONFIG_ENDPOINT : null, fetcher)
  const [savingRole, setSavingRole] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const activeAccounts = accounts
    .filter((a) => String(a.active_status ?? "Active") === "Active")
    .sort((a, b) => String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")))

  const byRole = new Map<string, RoleMappingRow>()
  for (const m of data?.mappings ?? []) byRole.set(m.role, m)

  async function save(role: string, accountId: string | null) {
    setSavingRole(role)
    setError(null)
    try {
      const res = await fetch(CONFIG_ENDPOINT, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role, account_id: accountId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save this mapping.")
        return
      }
      await mutate()
    } finally {
      setSavingRole(null)
    }
  }

  function RoleSelect({ role }: { role: string }) {
    const m = byRole.get(role)
    const value = m?.account_id ?? "__default__"
    return (
      <div className="flex flex-col gap-1">
        <Select
          value={value}
          onValueChange={(v) => save(role, v === "__default__" ? null : v)}
          disabled={savingRole === role}
        >
          <SelectTrigger className="w-full">
            <SelectValue placeholder="Use default" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">
              Use default{m?.default_code ? ` (code ${m.default_code})` : ""}
            </SelectItem>
            {activeAccounts.map((a) => (
              <SelectItem key={a.account_id} value={String(a.account_id)}>
                {a.account_code ? `${a.account_code} · ` : ""}{a.account_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {savingRole === role && <Loader2Icon className="size-3 animate-spin" />}
          {m?.effective_account_name ? (
            <span>
              Currently posts to <span className="font-medium text-foreground">{m.effective_account_name}</span>
              {m.effective_account_code ? ` (${m.effective_account_code})` : ""}
            </span>
          ) : (
            <span className="text-destructive">No account resolves for this role.</span>
          )}
          {m?.overridden && <Badge variant="secondary" className="text-[10px]">Overridden</Badge>}
        </div>
      </div>
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Account mapping &amp; defaults</DialogTitle>
          <DialogDescription>
            Map the posting engine&apos;s roles to specific heads. A saved mapping overrides the built-in default code
            and is used everywhere — Journal, Ledger, Invoices, Bills, Expenses, GST and TDS.
          </DialogDescription>
        </DialogHeader>

        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {isLoading || !data ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2Icon className="size-5 animate-spin" />
          </div>
        ) : (
          <Tabs defaultValue="defaults" className="w-full">
            <TabsList>
              <TabsTrigger value="defaults">Company defaults</TabsTrigger>
              <TabsTrigger value="mapping">Full mapping</TabsTrigger>
            </TabsList>

            <TabsContent value="defaults" className="space-y-4 pt-4">
              {data.companyDefaults.map((d) => (
                <div key={d.role} className="grid grid-cols-1 gap-2 border-b pb-4 sm:grid-cols-2 sm:items-start">
                  <div>
                    <p className="text-sm font-medium">{d.label}</p>
                    <p className="text-xs text-muted-foreground">{d.hint}</p>
                  </div>
                  <RoleSelect role={d.role} />
                </div>
              ))}
            </TabsContent>

            <TabsContent value="mapping" className="space-y-6 pt-4">
              {data.roleGroups.map((g) => (
                <div key={g.group} className="space-y-3">
                  <h4 className="text-sm font-semibold">{g.group}</h4>
                  {g.roles.map((r) => (
                    <div key={r.role} className="grid grid-cols-1 gap-2 border-b pb-3 sm:grid-cols-2 sm:items-start">
                      <div>
                        <p className="text-sm font-medium">{r.label}</p>
                        <p className="font-mono text-xs text-muted-foreground">{r.role}</p>
                      </div>
                      <RoleSelect role={r.role} />
                    </div>
                  ))}
                </div>
              ))}
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  )
}

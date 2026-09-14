"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Checkbox } from "@/components/ui/checkbox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
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
import {
  BookOpen, Coins, Plus, Pencil, Trash2, ChevronRight, ChevronDown,
  Lock, Loader2Icon, CornerDownRight, ShieldCheck, GitMerge, Settings2,
} from "lucide-react"
import { inr, inr0, financialYearFor } from "@/lib/finance-calc"
import {
  COA_ACCOUNT_TYPES,
  COA_SUB_TYPES_BY_TYPE,
  natureForAccountType,
} from "@/lib/finance-module-configs"
import { CoaMappingDialog } from "@/components/finance/coa-mapping-dialog"
import { CoaMergeDialog } from "@/components/finance/coa-merge-dialog"

type Row = Record<string, any>
type ApiShape = { rows: Row[]; summary: any }
type BalancesShape = { balances: Record<string, { net: number; balance: number; balance_type: string }> }

const ENDPOINT = "/api/finance/module/chart-of-accounts"
const BALANCES_ENDPOINT = "/api/finance/chart-of-accounts/balances"

/** Nature badge colouring — Debit vs Credit are the two natural balance sides. */
function natureVariant(nature: string): "default" | "secondary" {
  return nature === "Debit" ? "default" : "secondary"
}

type TreeNode = { row: Row; children: TreeNode[]; depth: number }

/**
 * Build a per-account-type forest from the flat account list. A row roots under
 * its account type when it has no parent, or when its parent is not present in
 * the dataset (so an orphan is never hidden). Children are ordered by code then
 * name so the hierarchy reads predictably.
 */
function buildForest(rows: Row[]): Record<string, TreeNode[]> {
  const byId = new Map<string, Row>()
  for (const r of rows) byId.set(String(r.account_id), r)

  const childrenOf = new Map<string, Row[]>()
  const roots: Row[] = []
  for (const r of rows) {
    const parentId = (r.parent_account_id ?? "").toString().trim()
    if (parentId && byId.has(parentId)) {
      const list = childrenOf.get(parentId) ?? []
      list.push(r)
      childrenOf.set(parentId, list)
    } else {
      roots.push(r)
    }
  }

  const sortRows = (a: Row, b: Row) =>
    String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")) ||
    String(a.account_name ?? "").localeCompare(String(b.account_name ?? ""))

  const attach = (row: Row, depth: number): TreeNode => {
    const kids = (childrenOf.get(String(row.account_id)) ?? []).sort(sortRows)
    return { row, depth, children: kids.map((k) => attach(k, depth + 1)) }
  }

  const forest: Record<string, TreeNode[]> = {}
  for (const type of COA_ACCOUNT_TYPES) forest[type] = []
  for (const root of roots.sort(sortRows)) {
    const type = COA_ACCOUNT_TYPES.includes(root.account_group) ? root.account_group : "Asset"
    forest[type].push(attach(root, 0))
  }
  return forest
}

/** Flatten a filtered forest into rows, keeping any node that matches the query
 * or has a descendant that does (ancestors stay so the path is visible). */
function flattenFiltered(nodes: TreeNode[], match: (r: Row) => boolean): TreeNode[] {
  const out: TreeNode[] = []
  for (const node of nodes) {
    const keptChildren = flattenFiltered(node.children, match)
    if (match(node.row) || keptChildren.length) {
      out.push({ ...node, children: [] })
      out.push(...keptChildren)
    }
  }
  return out
}

const SETTINGS_CHECKBOXES: { key: string; label: string }[] = [
  { key: "gst_applicable", label: "GST applicable" },
  { key: "tds_applicable", label: "TDS applicable" },
  { key: "bank_cash_account", label: "Bank / Cash account" },
  { key: "reconciliation_required", label: "Reconciliation required" },
]

type FormState = Record<string, string>

function emptyForm(): FormState {
  return {
    account_name: "",
    account_code: "",
    account_group: "Asset",
    account_type: "",
    parent_account_id: "",
    remarks: "",
    opening_balance: "",
    opening_balance_date: "",
    financial_year: "",
    active_status: "Active",
    tax_category: "",
    effective_from: "",
    effective_to: "",
    gst_applicable: "",
    tds_applicable: "",
    bank_cash_account: "",
    reconciliation_required: "",
  }
}

export function ChartOfAccountsClient() {
  const [search, setSearch] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [presetParent, setPresetParent] = useState<Row | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeSource, setMergeSource] = useState<Row | null>(null)

  const { data, mutate } = useSWR<ApiShape>(ENDPOINT, fetcher)
  const { data: balanceData, mutate: mutateBalances } = useSWR<BalancesShape>(BALANCES_ENDPOINT, fetcher)
  const rows = data?.rows ?? []
  const summary = data?.summary ?? {}
  const balances = balanceData?.balances ?? {}

  const forest = useMemo(() => buildForest(rows), [rows])

  const matcher = useMemo(() => {
    const q = search.trim().toLowerCase()
    return (r: Row) =>
      !q ||
      [r.account_name, r.account_code, r.account_type, r.account_id]
        .map((v) => String(v ?? "").toLowerCase())
        .some((s) => s.includes(q))
  }, [search])

  function toggle(type: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  function openNew() {
    setEditing(null)
    setPresetParent(null)
    setDialogOpen(true)
  }
  function openEdit(row: Row) {
    setEditing(row)
    setPresetParent(null)
    setDialogOpen(true)
  }
  function openChild(parent: Row) {
    setEditing(null)
    setPresetParent(parent)
    setDialogOpen(true)
  }

  async function remove(row: Row) {
    setDeleteError(null)
    if (!confirm(`Delete ${row.account_name} (${row.account_id})? This cannot be undone.`)) return
    setDeletingId(row.id)
    try {
      const res = await fetch(`${ENDPOINT}?id=${row.id}`, { method: "DELETE" })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setDeleteError(body.error || "This account could not be deleted.")
        return
      }
      mutate()
    } finally {
      setDeletingId(null)
    }
  }

  const totalAccounts = summary.total_rows ?? rows.length
  const totalOpening = summary.total_opening ?? 0

  return (
    <main className="space-y-8 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Finance masters</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance">Chart of Accounts</h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => setMappingOpen(true)}>
            <Settings2 data-icon="inline-start" />
            Account mapping
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setMergeSource(null)
              setMergeOpen(true)
            }}
          >
            <GitMerge data-icon="inline-start" />
            Merge accounts
          </Button>
          <Button onClick={openNew}>
            <Plus data-icon="inline-start" />
            New account
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Total Accounts</span>
              <BookOpen className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{totalAccounts}</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Opening Balance</span>
              <Coins className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{inr0(totalOpening)}</span>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="pt-6">
          <Input
            placeholder="Search by name, code or sub type..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-md"
          />
        </CardContent>
      </Card>

      {deleteError && (
        <Alert variant="destructive">
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        {COA_ACCOUNT_TYPES.map((type) => {
          const nodes = flattenFiltered(forest[type] ?? [], matcher)
          const isCollapsed = collapsed.has(type)
          const nature = natureForAccountType(type)
          return (
            <Card key={type}>
              <CardContent className="pt-6">
                <button
                  type="button"
                  onClick={() => toggle(type)}
                  className="flex w-full items-center gap-2 text-left"
                  aria-expanded={!isCollapsed}
                >
                  {isCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                  <span className="text-sm font-semibold">{type}</span>
                  <Badge variant={natureVariant(nature)} className="ml-1">{nature}</Badge>
                  <Badge variant="secondary" className="ml-auto">{nodes.length} accounts</Badge>
                </button>

                {!isCollapsed && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="p-2 font-medium">Account</th>
                          <th className="p-2 font-medium">Code</th>
                          <th className="p-2 font-medium">Sub type</th>
                          <th className="p-2 font-medium">Nature</th>
                          <th className="p-2 text-right font-medium">Opening</th>
                          <th className="p-2 text-right font-medium">Current (GL)</th>
                          <th className="p-2 font-medium">Status</th>
                          <th className="p-2 text-right font-medium">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {nodes.length === 0 && (
                          <tr>
                            <td colSpan={8} className="p-6 text-center text-muted-foreground">
                              No accounts in this group.
                            </td>
                          </tr>
                        )}
                        {nodes.map(({ row, depth }) => {
                          const isSystem = Number(row.is_system) === 1
                          return (
                            <tr key={row.id} className="border-b hover:bg-muted/40">
                              <td className="p-2">
                                <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                                  {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />}
                                  <span className="font-medium">{row.account_name}</span>
                                  {isSystem && (
                                    <Badge variant="outline" className="gap-1 text-[10px]">
                                      <ShieldCheck className="size-3" />
                                      System
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="p-2 font-mono text-xs">{row.account_code || "—"}</td>
                              <td className="p-2">{row.account_type || "—"}</td>
                              <td className="p-2">
                                <Badge variant={natureVariant(row.nature)}>{row.nature || natureForAccountType(row.account_group)}</Badge>
                              </td>
                              <td className="p-2 text-right tabular-nums">{inr(row.opening_balance)}</td>
                              <td className="p-2 text-right tabular-nums">
                                {(() => {
                                  const bal = balances[String(row.account_id)]
                                  if (!bal || bal.balance === 0) return <span className="text-muted-foreground">—</span>
                                  return (
                                    <span>
                                      {inr(bal.balance)}{" "}
                                      <span className="text-xs text-muted-foreground">{bal.balance_type === "Debit" ? "Dr" : "Cr"}</span>
                                    </span>
                                  )
                                })()}
                              </td>
                              <td className="p-2">
                                <Badge variant={row.active_status === "Active" ? "default" : "outline"}>
                                  {row.active_status || "Active"}
                                </Badge>
                              </td>
                              <td className="p-2">
                                <div className="flex items-center justify-end gap-1">
                                  <Button variant="ghost" size="icon" aria-label="Add child account" onClick={() => openChild(row)}>
                                    <Plus className="size-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" aria-label="Edit" onClick={() => openEdit(row)}>
                                    <Pencil className="size-4" />
                                  </Button>
                                  {!isSystem && (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label="Merge into another account"
                                      title="Merge into another account"
                                      onClick={() => {
                                        setMergeSource(row)
                                        setMergeOpen(true)
                                      }}
                                    >
                                      <GitMerge className="size-4" />
                                    </Button>
                                  )}
                                  {isSystem ? (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label="System account — protected"
                                      disabled
                                      title="System account — protected from deletion"
                                    >
                                      <Lock className="size-4 text-muted-foreground" />
                                    </Button>
                                  ) : (
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      aria-label="Delete"
                                      disabled={deletingId === row.id}
                                      onClick={() => remove(row)}
                                    >
                                      {deletingId === row.id ? <Loader2Icon className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                                    </Button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <AccountDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        record={editing}
        presetParent={presetParent}
        rows={rows}
        onSaved={() => {
          setDialogOpen(false)
          mutate()
          mutateBalances()
        }}
      />

      <CoaMappingDialog open={mappingOpen} onOpenChange={setMappingOpen} accounts={rows} />

      <CoaMergeDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        accounts={rows}
        presetSource={mergeSource}
        onMerged={() => {
          mutate()
          mutateBalances()
        }}
      />
    </main>
  )
}

/**
 * Collect an account and all of its descendants so they can be excluded from the
 * parent picker (an account may never be parented under itself or its subtree).
 */
function descendantIds(rows: Row[], accountId: string): Set<string> {
  const childrenOf = new Map<string, Row[]>()
  for (const r of rows) {
    const p = (r.parent_account_id ?? "").toString().trim()
    if (!p) continue
    const list = childrenOf.get(p) ?? []
    list.push(r)
    childrenOf.set(p, list)
  }
  const banned = new Set<string>([accountId])
  const stack = [accountId]
  while (stack.length) {
    const cur = stack.pop()!
    for (const child of childrenOf.get(cur) ?? []) {
      const id = String(child.account_id)
      if (!banned.has(id)) {
        banned.add(id)
        stack.push(id)
      }
    }
  }
  return banned
}

function AccountDialog({
  open,
  onOpenChange,
  record,
  presetParent,
  rows,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  record: Row | null
  presetParent: Row | null
  rows: Row[]
  onSaved: () => void
}) {
  const [form, setForm] = useState<FormState>(emptyForm)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)

  // Reset the form whenever the dialog opens for a new target.
  const seedKey = `${open}:${record?.id ?? ""}:${presetParent?.account_id ?? ""}`
  useMemo(() => {
    if (!open) return
    setError(null)
    setShowAdvanced(false)
    const base = emptyForm()
    if (record) {
      for (const key of Object.keys(base)) {
        const v = record[key]
        if (key in { gst_applicable: 1, tds_applicable: 1, bank_cash_account: 1, reconciliation_required: 1 }) {
          base[key] = v ? "1" : ""
        } else {
          base[key] = v === null || v === undefined ? "" : String(v)
        }
      }
    } else if (presetParent) {
      base.account_group = COA_ACCOUNT_TYPES.includes(presetParent.account_group) ? presetParent.account_group : "Asset"
      base.account_type = presetParent.account_type ?? ""
      base.parent_account_id = String(presetParent.account_id ?? "")
    }
    setForm(base)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey])

  const isSystem = Number(record?.is_system) === 1
  const nature = natureForAccountType(form.account_group)
  const derivedFy = form.opening_balance_date && !form.financial_year ? financialYearFor(form.opening_balance_date) : form.financial_year

  const subTypes = COA_SUB_TYPES_BY_TYPE[form.account_group] ?? []

  // Immediate duplicate-code detection (case-insensitive) so a colliding code is
  // flagged before the save round-trip. Mirrors the authoritative server guard
  // in lib/finance-coa.ts → guardChartOfAccountWrite, which remains the source
  // of truth; this is purely a faster, inline signal to the user.
  const codeConflict = useMemo(() => {
    const code = form.account_code.trim().toLowerCase()
    if (!code) return false
    return rows.some(
      (r) =>
        String(r.account_code ?? "").trim().toLowerCase() === code &&
        String(r.id) !== String(record?.id ?? ""),
    )
  }, [rows, form.account_code, record])

  // Valid parents: same account type, not the record itself or its subtree.
  const parentOptions = useMemo(() => {
    const banned = record?.account_id ? descendantIds(rows, String(record.account_id)) : new Set<string>()
    return rows
      .filter((r) => r.account_group === form.account_group && !banned.has(String(r.account_id)))
      .sort((a, b) => String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")))
  }, [rows, form.account_group, record])

  function set(key: string, value: string) {
    setForm((prev) => {
      const next = { ...prev, [key]: value }
      // Changing the account type invalidates a parent from another type.
      if (key === "account_group" && next.parent_account_id) {
        const parent = rows.find((r) => String(r.account_id) === next.parent_account_id)
        if (!parent || parent.account_group !== value) next.parent_account_id = ""
      }
      return next
    })
  }

  async function submit() {
    if (!form.account_name.trim()) {
      setError("Account name is required")
      return
    }
    if (codeConflict) {
      setError(`Account code "${form.account_code.trim()}" is already in use. Codes must be unique.`)
      return
    }
    setLoading(true)
    setError(null)
    const payload: Record<string, any> = { ...form }
    for (const c of SETTINGS_CHECKBOXES) payload[c.key] = form[c.key] ? 1 : 0
    if (record?.id) payload.id = record.id
    try {
      const res = await fetch(ENDPOINT, {
        method: record ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(body.error || "Unable to save the account.")
        setLoading(false)
        return
      }
      setLoading(false)
      onSaved()
    } catch {
      setError("Something went wrong. Please try again.")
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {record ? `Edit account · ${record.account_id ?? ""}` : presetParent ? `New account under ${presetParent.account_name}` : "New account"}
          </DialogTitle>
          <DialogDescription>
            The Account ID is generated automatically (COA-0001). Nature and the financial year are derived for you.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="flex flex-col gap-6 py-2"
        >
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          {isSystem && (
            <Alert>
              <AlertDescription className="flex items-center gap-2 text-sm">
                <ShieldCheck className="size-4 shrink-0" />
                This is a system account used by the posting engine. Its code, type and status are locked.
              </AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            <h3 className="text-sm font-semibold">Account</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor="account_name">Account name</FieldLabel>
                <Input id="account_name" value={form.account_name} onChange={(e) => set("account_name", e.target.value)} required />
              </Field>
              <Field>
                <FieldLabel htmlFor="account_code">Account code</FieldLabel>
                <Input
                  id="account_code"
                  value={form.account_code}
                  onChange={(e) => set("account_code", e.target.value)}
                  placeholder="Unique code, e.g. 1200"
                  disabled={isSystem}
                  aria-invalid={codeConflict}
                />
                {codeConflict && (
                  <p className="text-xs text-destructive">This code is already used by another account. Codes must be unique.</p>
                )}
              </Field>
              <Field>
                <FieldLabel>Account type</FieldLabel>
                <Select value={form.account_group} onValueChange={(v) => set("account_group", v)} disabled={isSystem}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {COA_ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Sub type</FieldLabel>
                <Select value={form.account_type || "none"} onValueChange={(v) => set("account_type", v === "none" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select sub type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {subTypes.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Parent account</FieldLabel>
                <Select value={form.parent_account_id || "none"} onValueChange={(v) => set("parent_account_id", v === "none" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="No parent (top level)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No parent (top level)</SelectItem>
                    {parentOptions.map((p) => (
                      <SelectItem key={p.account_id} value={String(p.account_id)}>
                        {p.account_code ? `${p.account_code} · ` : ""}{p.account_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Nature (auto)</FieldLabel>
                <div className="flex h-10 items-center">
                  <Badge variant={natureVariant(nature)}>{nature}</Badge>
                </div>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="remarks">Description</FieldLabel>
              <Textarea id="remarks" value={form.remarks} onChange={(e) => set("remarks", e.target.value)} rows={2} />
            </Field>
          </FieldGroup>

          <FieldGroup>
            <h3 className="text-sm font-semibold">Balances</h3>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="opening_balance">Opening balance</FieldLabel>
                <Input id="opening_balance" type="number" step="0.01" value={form.opening_balance} onChange={(e) => set("opening_balance", e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="opening_balance_date">Opening balance date</FieldLabel>
                <Input id="opening_balance_date" type="date" value={form.opening_balance_date} onChange={(e) => set("opening_balance_date", e.target.value)} />
              </Field>
              <Field>
                <FieldLabel htmlFor="financial_year">Financial year</FieldLabel>
                <Input
                  id="financial_year"
                  value={form.financial_year}
                  onChange={(e) => set("financial_year", e.target.value)}
                  placeholder={derivedFy || "Auto from opening date"}
                />
              </Field>
              <Field>
                <FieldLabel>Status</FieldLabel>
                <Select value={form.active_status} onValueChange={(v) => set("active_status", v)} disabled={isSystem}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Active">Active</SelectItem>
                    <SelectItem value="Inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </FieldGroup>

          <div>
            <Button type="button" variant="ghost" size="sm" onClick={() => setShowAdvanced((s) => !s)}>
              {showAdvanced ? <ChevronDown data-icon="inline-start" /> : <ChevronRight data-icon="inline-start" />}
              Additional settings
            </Button>
            {showAdvanced && (
              <FieldGroup className="mt-3">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {SETTINGS_CHECKBOXES.map((c) => (
                    <label key={c.key} className="flex items-center gap-2 text-sm">
                      <Checkbox
                        checked={!!form[c.key]}
                        onCheckedChange={(v) => set(c.key, v ? "1" : "")}
                      />
                      {c.label}
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <Field>
                    <FieldLabel htmlFor="tax_category">Tax category</FieldLabel>
                    <Input id="tax_category" value={form.tax_category} onChange={(e) => set("tax_category", e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="effective_from">Effective from</FieldLabel>
                    <Input id="effective_from" type="date" value={form.effective_from} onChange={(e) => set("effective_from", e.target.value)} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="effective_to">Effective to</FieldLabel>
                    <Input id="effective_to" type="date" value={form.effective_to} onChange={(e) => set("effective_to", e.target.value)} />
                  </Field>
                </div>
              </FieldGroup>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={loading || codeConflict}>
              {loading && <Loader2Icon data-icon="inline-start" className="animate-spin" />}
              {record ? "Save changes" : "Create account"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

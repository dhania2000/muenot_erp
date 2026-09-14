"use client"

import { useEffect, useMemo, useState } from "react"
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  BookOpen, Coins, Plus, Pencil, Trash2, ChevronRight, ChevronLeft, ChevronDown,
  Lock, Loader2Icon, CornerDownRight, ShieldCheck, GitMerge, Settings2,
  Download, Upload, SlidersHorizontal, Network, List, CalendarClock,
  Wallet, Landmark, TrendingUp, TrendingDown, CircleCheck,
} from "lucide-react"
import { inr, inr0, financialYearFor } from "@/lib/finance-calc"
import {
  COA_ACCOUNT_TYPES,
  COA_SUB_TYPES_BY_TYPE,
  natureForAccountType,
} from "@/lib/finance-module-configs"
import {
  resolveClassification,
  BS_ASSET_GROUPS,
  BS_LIABILITY_GROUPS,
  PL_INCOME_GROUPS,
  PL_EXPENSE_GROUPS,
  CASHFLOW_GROUPS,
} from "@/lib/finance-classification"
import { exportRowsToExcel } from "@/lib/excel-export"
import { CoaMappingDialog } from "@/components/finance/coa-mapping-dialog"
import { CoaMergeDialog } from "@/components/finance/coa-merge-dialog"
import { CoaImportDialog } from "@/components/finance/coa-import-dialog"
import { CoaOpeningBalancesDialog } from "@/components/finance/coa-opening-balances-dialog"

type Row = Record<string, any>
type ApiShape = { rows: Row[]; summary: any }
type BalancesShape = { balances: Record<string, { net: number; balance: number; balance_type: string }> }

const ENDPOINT = "/api/finance/module/chart-of-accounts"
const BALANCES_ENDPOINT = "/api/finance/chart-of-accounts/balances"
const CONFIG_ENDPOINT = "/api/finance/chart-of-accounts/config"

type RoleMapping = { role: string; effective_account_id: string | null }
type RoleGroup = { group: string; roles: { role: string; label: string }[] }
type ConfigShape = { mappings: RoleMapping[]; roleGroups: RoleGroup[] }

/** A single account's reporting group + Cash Flow activity, as compact badges. */
function ClassificationBadges({ row }: { row: Row }) {
  const c = resolveClassification(row)
  const group = c.section === "ProfitAndLoss" ? c.pnlGroup : c.bsGroup
  const overridden = c.section === "ProfitAndLoss" ? c.pnlOverridden : c.bsOverridden
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <Badge variant="outline" className="font-normal">{group}</Badge>
        {overridden && (
          <span className="text-[10px] font-medium uppercase text-muted-foreground" title="Manually pinned classification">
            pinned
          </span>
        )}
      </span>
      <span className="text-[11px] text-muted-foreground">{c.cashFlowGroup} activity</span>
    </div>
  )
}

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

type FlatNode = { row: Row; depth: number; hasChildren: boolean }

/**
 * Flatten a filtered forest into hierarchy rows while honouring a per-parent
 * collapse set. A parent is emitted whenever it matches or has a matching
 * descendant; its (matching) descendants follow unless the parent is collapsed.
 * `hasChildren` reflects whether there are matching children to reveal, so the
 * toggle only appears when it actually does something. Collapse is honoured only
 * when nothing is narrowing the list (`honorCollapse`) — an active search/filter
 * force-expands so a match can never hide behind a collapsed parent.
 */
function flattenTree(
  nodes: TreeNode[],
  match: (r: Row) => boolean,
  opts: { collapsed: Set<string>; honorCollapse: boolean },
): FlatNode[] {
  const out: FlatNode[] = []
  for (const node of nodes) {
    const keptChildren = flattenTree(node.children, match, opts)
    if (match(node.row) || keptChildren.length) {
      out.push({ row: node.row, depth: node.depth, hasChildren: keptChildren.length > 0 })
      const collapsedHere = opts.honorCollapse && opts.collapsed.has(String(node.row.account_id))
      if (!collapsedHere) out.push(...keptChildren)
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
    bs_group: "",
    pnl_group: "",
    cashflow_group: "",
  }
}

const NATURE_FILTERS = ["All", "Debit", "Credit"] as const
const STATUS_FILTERS = ["All", "Active", "Inactive", "Archived"] as const

type Filters = {
  type: string
  subType: string
  nature: string
  parent: string
  status: string
  minBalance: string
  maxBalance: string
}

const EMPTY_FILTERS: Filters = {
  type: "All",
  subType: "All",
  nature: "All",
  parent: "All",
  status: "All",
  minBalance: "",
  maxBalance: "",
}

export function ChartOfAccountsClient() {
  const [search, setSearch] = useState("")
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [collapsedNodes, setCollapsedNodes] = useState<Set<string>>(new Set())
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Row | null>(null)
  const [presetParent, setPresetParent] = useState<Row | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [mappingOpen, setMappingOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [mergeSource, setMergeSource] = useState<Row | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [obYearsAccount, setObYearsAccount] = useState<Row | null>(null)
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree")
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [exportingLedger, setExportingLedger] = useState(false)
  const [flatPageSize, setFlatPageSize] = useState(50)
  const [flatPage, setFlatPage] = useState(1)

  const { data, mutate } = useSWR<ApiShape>(ENDPOINT, fetcher)
  const { data: balanceData, mutate: mutateBalances } = useSWR<BalancesShape>(BALANCES_ENDPOINT, fetcher)
  const { data: configData } = useSWR<ConfigShape>(CONFIG_ENDPOINT, fetcher)
  const rows = data?.rows ?? []
  const summary = data?.summary ?? {}
  const balances = balanceData?.balances ?? {}

  // account_id → the posting roles it currently serves (Bank, GST Output CGST,
  // TDS Payable, …). Built by inverting the same role→account mapping the
  // posting engine resolves, so a head is tagged with exactly the roles it is
  // wired to — never a guess.
  const rolesByAccount = useMemo(() => {
    const labelByRole = new Map<string, string>()
    for (const g of configData?.roleGroups ?? []) for (const r of g.roles) labelByRole.set(r.role, r.label)
    const map = new Map<string, string[]>()
    for (const m of configData?.mappings ?? []) {
      const id = m.effective_account_id ? String(m.effective_account_id) : ""
      if (!id) continue
      const label = labelByRole.get(m.role) ?? m.role
      const list = map.get(id) ?? []
      list.push(label)
      map.set(id, list)
    }
    return map
  }, [configData])

  const forest = useMemo(() => buildForest(rows), [rows])

  // account_id → account (for resolving a row's parent name/code in search & filters).
  const byId = useMemo(() => {
    const m = new Map<string, Row>()
    for (const r of rows) m.set(String(r.account_id), r)
    return m
  }, [rows])

  // Parent accounts that actually have children — the only useful parent-filter options.
  const parentOptions = useMemo(() => {
    const ids = new Set<string>()
    for (const r of rows) {
      const p = (r.parent_account_id ?? "").toString().trim()
      if (p && byId.has(p)) ids.add(p)
    }
    return Array.from(ids)
      .map((id) => byId.get(id)!)
      .sort((a, b) =>
        String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")) ||
        String(a.account_name ?? "").localeCompare(String(b.account_name ?? "")),
      )
  }, [rows, byId])

  const subTypeOptions = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      const t = String(r.account_type ?? "").trim()
      if (t) set.add(t)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [rows])

  const activeFilterCount = useMemo(
    () =>
      (Object.keys(EMPTY_FILTERS) as (keyof Filters)[]).filter(
        (k) => filters[k] !== EMPTY_FILTERS[k],
      ).length,
    [filters],
  )

  const matcher = useMemo(() => {
    const q = search.trim().toLowerCase()
    const min = filters.minBalance.trim() === "" ? null : Number(filters.minBalance)
    const max = filters.maxBalance.trim() === "" ? null : Number(filters.maxBalance)
    return (r: Row) => {
      // Text search — name, code, sub type, id AND the parent account's name/code.
      if (q) {
        const parent = byId.get((r.parent_account_id ?? "").toString().trim())
        const haystack = [
          r.account_name, r.account_code, r.account_type, r.account_id,
          parent?.account_name, parent?.account_code,
        ]
          .map((v) => String(v ?? "").toLowerCase())
        if (!haystack.some((s) => s.includes(q))) return false
      }
      if (filters.subType !== "All" && String(r.account_type ?? "") !== filters.subType) return false
      if (filters.nature !== "All") {
        const nat = String(r.nature || natureForAccountType(r.account_group))
        if (nat !== filters.nature) return false
      }
      if (filters.parent !== "All" && String(r.parent_account_id ?? "") !== filters.parent) return false
      if (filters.status !== "All" && String(r.active_status || "Active") !== filters.status) return false
      if (min !== null || max !== null) {
        const bal = balances[String(r.account_id)]?.balance ?? 0
        const abs = Math.abs(Number(bal))
        if (min !== null && abs < min) return false
        if (max !== null && abs > max) return false
      }
      return true
    }
  }, [search, filters, byId, balances])

  function toggle(type: string) {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(type)) next.delete(type)
      else next.add(type)
      return next
    })
  }

  // Per-parent collapse in the hierarchy view. Collapsing a node hides its
  // whole subtree; expand/collapse-all operate on every parent that has
  // children (parentOptions already tracks exactly those heads).
  function toggleNode(id: string) {
    setCollapsedNodes((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  function expandAll() {
    setCollapsedNodes(new Set())
  }
  function collapseAll() {
    setCollapsedNodes(new Set(parentOptions.map((p) => String(p.account_id))))
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

  // Dashboard KPIs derived from the same live account list + GL balances the
  // table renders — never a separate/duplicate source. `active` counts heads
  // whose lifecycle state is Active (blank defaults to Active), and each group
  // total is the sum of the accounts' current GL balances (absolute), giving a
  // trial-balance snapshot per section straight from the ledger.
  const stats = useMemo(() => {
    const groupTotal: Record<string, number> = { Asset: 0, Liability: 0, Income: 0, Expense: 0 }
    const groupCount: Record<string, number> = { Asset: 0, Liability: 0, Income: 0, Expense: 0 }
    let active = 0
    for (const r of rows) {
      const status = String(r.active_status || "Active")
      if (status === "Active") active += 1
      const group = String(r.account_group ?? "")
      if (group in groupTotal) {
        groupCount[group] += 1
        const bal = balances[String(r.account_id)]?.balance
        groupTotal[group] += Math.abs(Number(bal ?? r.opening_balance ?? 0))
      }
    }
    return { active, groupTotal, groupCount }
  }, [rows, balances])

  // --- Exports (Excel) ------------------------------------------------------
  // All exports read the same live data the page shows; none create a copy.
  function exportAccounts() {
    const ordered = [...rows].sort(
      (a, b) =>
        COA_ACCOUNT_TYPES.indexOf(a.account_group) - COA_ACCOUNT_TYPES.indexOf(b.account_group) ||
        String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")),
    )
    exportRowsToExcel("chart-of-accounts", ordered, [
      { header: "Account ID", value: (r) => r.account_id },
      { header: "Account Code", value: (r) => r.account_code ?? "" },
      { header: "Account Name", value: (r) => r.account_name },
      { header: "Account Type", value: (r) => r.account_group },
      { header: "Sub Type", value: (r) => r.account_type ?? "" },
      { header: "Nature", value: (r) => r.nature || natureForAccountType(r.account_group) },
      {
        header: "Parent Code",
        value: (r) => byId.get(String(r.parent_account_id ?? ""))?.account_code ?? "",
      },
      {
        header: "Parent Name",
        value: (r) => byId.get(String(r.parent_account_id ?? ""))?.account_name ?? "",
      },
      { header: "Opening Balance", value: (r) => Number(r.opening_balance ?? 0) },
      { header: "Opening Balance Date", value: (r) => r.opening_balance_date ?? "" },
      { header: "Financial Year", value: (r) => r.financial_year ?? "" },
      { header: "Status", value: (r) => r.active_status || "Active" },
    ])
  }

  function exportBalances() {
    const ordered = [...rows].sort(
      (a, b) =>
        COA_ACCOUNT_TYPES.indexOf(a.account_group) - COA_ACCOUNT_TYPES.indexOf(b.account_group) ||
        String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")),
    )
    exportRowsToExcel("account-balances", ordered, [
      { header: "Account ID", value: (r) => r.account_id },
      { header: "Account Code", value: (r) => r.account_code ?? "" },
      { header: "Account Name", value: (r) => r.account_name },
      { header: "Account Type", value: (r) => r.account_group },
      { header: "Opening Balance", value: (r) => Number(r.opening_balance ?? 0) },
      { header: "Current Balance", value: (r) => Number(balances[String(r.account_id)]?.balance ?? 0) },
      {
        header: "Dr/Cr",
        value: (r) => balances[String(r.account_id)]?.balance_type ?? natureForAccountType(r.account_group),
      },
    ])
  }

  async function exportLedger() {
    setExportingLedger(true)
    try {
      const res = await fetch("/api/finance/chart-of-accounts/ledger-export")
      const body = await res.json().catch(() => ({}))
      const ledgerRows: Row[] = Array.isArray(body?.rows) ? body.rows : []
      if (ledgerRows.length === 0) {
        alert("There are no posted ledger entries to export yet.")
        return
      }
      exportRowsToExcel("account-ledgers", ledgerRows, [
        { header: "Account Code", value: (r) => r.account_code ?? "" },
        { header: "Account Name", value: (r) => r.account_name ?? "" },
        { header: "Account Type", value: (r) => r.account_group ?? "" },
        { header: "Date", value: (r) => r.transaction_date ?? "" },
        { header: "Voucher No", value: (r) => r.voucher_no ?? "" },
        { header: "Voucher Type", value: (r) => r.voucher_type ?? "" },
        { header: "Reference", value: (r) => r.reference_no ?? "" },
        { header: "Party", value: (r) => r.party_name ?? "" },
        { header: "Description", value: (r) => r.description ?? "" },
        { header: "Debit", value: (r) => Number(r.debit ?? 0) },
        { header: "Credit", value: (r) => Number(r.credit ?? 0) },
        { header: "Balance", value: (r) => Number(r.balance ?? 0) },
        { header: "Dr/Cr", value: (r) => r.balance_type ?? "" },
        { header: "Source", value: (r) => r.source_module ?? "" },
        { header: "Source Ref", value: (r) => r.source_reference ?? "" },
      ])
    } catch {
      alert("Could not prepare the ledger export. Please try again.")
    } finally {
      setExportingLedger(false)
    }
  }

  // Flat view: every account matching the active search/filters, flattened
  // across account types and paged (requirement 111). The tree view keeps the
  // full hierarchy (bounded master data) while the flat list is the scalable,
  // paginated surface for a large Chart of Accounts.
  const flatAll = useMemo(() => {
    return rows
      .filter((r) => (filters.type === "All" || String(r.account_group) === filters.type) && matcher(r))
      .sort(
        (a, b) =>
          COA_ACCOUNT_TYPES.indexOf(a.account_group) - COA_ACCOUNT_TYPES.indexOf(b.account_group) ||
          String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")) ||
          String(a.account_name ?? "").localeCompare(String(b.account_name ?? "")),
      )
  }, [rows, filters, matcher])

  const flatTotalPages = Math.max(Math.ceil(flatAll.length / flatPageSize), 1)
  const flatSafePage = Math.min(flatPage, flatTotalPages)
  const flatSlice = flatAll.slice((flatSafePage - 1) * flatPageSize, flatSafePage * flatPageSize)

  // Reset to the first page whenever the result set or page size changes, so a
  // stale page number can never strand the user on an empty page.
  useEffect(() => {
    setFlatPage(1)
  }, [search, filters, flatPageSize, viewMode])

  function renderAccountRow(row: Row, depth: number) {
    const isSystem = Number(row.is_system) === 1
    return (
      <tr key={row.id} className="border-b hover:bg-muted/40">
        <td className="p-2">
          <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
            {depth > 0 && <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />}
            <a
              href={`/modules/finance/chart-of-accounts/${encodeURIComponent(String(row.account_id))}`}
              className="font-medium text-primary hover:underline"
            >
              {row.account_name}
            </a>
            {isSystem && (
              <Badge variant="outline" className="gap-1 text-[10px]">
                <ShieldCheck className="size-3" />
                System
              </Badge>
            )}
          </div>
        </td>
        <td className="p-2 font-mono text-xs text-muted-foreground">{row.account_id}</td>
        <td className="p-2 font-mono text-xs">{row.account_code || "—"}</td>
        <td className="p-2">{row.account_type || "—"}</td>
        <td className="p-2 align-top">
          <ClassificationBadges row={row} />
          {(() => {
            const roles = rolesByAccount.get(String(row.account_id)) ?? []
            if (roles.length === 0) return null
            return (
              <div className="mt-1 flex flex-wrap gap-1">
                {roles.map((label) => (
                  <Badge key={label} variant="secondary" className="text-[10px] font-normal">{label}</Badge>
                ))}
              </div>
            )
          })()}
        </td>
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
            <Button
              variant="ghost"
              size="icon"
              aria-label="View ledger & account detail"
              title="View ledger, journal, transactions & balance"
              render={<a href={`/modules/finance/chart-of-accounts/${encodeURIComponent(String(row.account_id))}`} />}
            >
              <BookOpen className="size-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Add child account" onClick={() => openChild(row)}>
              <Plus className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Opening balances by year"
              title="Opening balances by financial year"
              onClick={() => setObYearsAccount(row)}
            >
              <CalendarClock className="size-4" />
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
  }

  const tableHead = (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th className="p-2 font-medium">Account</th>
        <th className="p-2 font-medium">Account ID</th>
        <th className="p-2 font-medium">Code</th>
        <th className="p-2 font-medium">Sub type</th>
        <th className="p-2 font-medium">Reporting</th>
        <th className="p-2 font-medium">Nature</th>
        <th className="p-2 text-right font-medium">Opening</th>
        <th className="p-2 text-right font-medium">Current (GL)</th>
        <th className="p-2 font-medium">Status</th>
        <th className="p-2 text-right font-medium">Actions</th>
      </tr>
    </thead>
  )

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
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload data-icon="inline-start" />
            Import
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="outline">
                  <Download data-icon="inline-start" />
                  Export
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Export to Excel</DropdownMenuLabel>
              <DropdownMenuItem onClick={exportAccounts}>Chart of Accounts</DropdownMenuItem>
              <DropdownMenuItem onClick={exportBalances}>Account balances (trial balance)</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={exportLedger} disabled={exportingLedger}>
                {exportingLedger ? "Preparing ledger…" : "Account ledgers (all postings)"}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              <span className="text-xs font-medium text-muted-foreground">Active Accounts</span>
              <CircleCheck className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{stats.active}</span>
            <span className="text-[11px] text-muted-foreground">
              {totalAccounts - stats.active} inactive / archived
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Assets</span>
              <Wallet className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{inr0(stats.groupTotal.Asset)}</span>
            <span className="text-[11px] text-muted-foreground">{stats.groupCount.Asset} accounts</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Liabilities</span>
              <Landmark className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{inr0(stats.groupTotal.Liability)}</span>
            <span className="text-[11px] text-muted-foreground">{stats.groupCount.Liability} accounts</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Income</span>
              <TrendingUp className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{inr0(stats.groupTotal.Income)}</span>
            <span className="text-[11px] text-muted-foreground">{stats.groupCount.Income} accounts</span>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="flex flex-col gap-2 pt-6">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Expenses</span>
              <TrendingDown className="size-4 text-muted-foreground" />
            </div>
            <span className="text-xl font-semibold tracking-tight">{inr0(stats.groupTotal.Expense)}</span>
            <span className="text-[11px] text-muted-foreground">{stats.groupCount.Expense} accounts</span>
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
        <CardContent className="space-y-4 pt-6">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="Search by name, code, sub type or parent..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="max-w-md flex-1"
            />
            <Button
              variant={showFilters || activeFilterCount > 0 ? "secondary" : "outline"}
              onClick={() => setShowFilters((v) => !v)}
            >
              <SlidersHorizontal data-icon="inline-start" />
              Filters
              {activeFilterCount > 0 && (
                <Badge variant="default" className="ml-1">{activeFilterCount}</Badge>
              )}
            </Button>
            <div className="ml-auto inline-flex overflow-hidden rounded-md border">
              <Button
                variant={viewMode === "tree" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none"
                onClick={() => setViewMode("tree")}
                aria-pressed={viewMode === "tree"}
              >
                <Network data-icon="inline-start" />
                Hierarchy
              </Button>
              <Button
                variant={viewMode === "flat" ? "secondary" : "ghost"}
                size="sm"
                className="rounded-none"
                onClick={() => setViewMode("flat")}
                aria-pressed={viewMode === "flat"}
              >
                <List data-icon="inline-start" />
                Flat
              </Button>
            </div>
            {viewMode === "tree" && (
              <div className="inline-flex overflow-hidden rounded-md border">
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-none"
                  onClick={expandAll}
                  disabled={collapsedNodes.size === 0}
                >
                  <ChevronDown data-icon="inline-start" />
                  Expand all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-none"
                  onClick={collapseAll}
                >
                  <ChevronRight data-icon="inline-start" />
                  Collapse all
                </Button>
              </div>
            )}
          </div>

          {showFilters && (
            <div className="grid grid-cols-1 gap-4 border-t pt-4 sm:grid-cols-2 lg:grid-cols-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Account type</label>
                <Select value={filters.type} onValueChange={(v) => setFilters((f) => ({ ...f, type: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">All types</SelectItem>
                    {COA_ACCOUNT_TYPES.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Sub type</label>
                <Select value={filters.subType} onValueChange={(v) => setFilters((f) => ({ ...f, subType: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">All sub types</SelectItem>
                    {subTypeOptions.map((t) => (
                      <SelectItem key={t} value={t}>{t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Nature</label>
                <Select value={filters.nature} onValueChange={(v) => setFilters((f) => ({ ...f, nature: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {NATURE_FILTERS.map((t) => (
                      <SelectItem key={t} value={t}>{t === "All" ? "All natures" : t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Parent account</label>
                <Select value={filters.parent} onValueChange={(v) => setFilters((f) => ({ ...f, parent: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="All">All parents</SelectItem>
                    {parentOptions.map((p) => (
                      <SelectItem key={String(p.account_id)} value={String(p.account_id)}>
                        {p.account_code ? `${p.account_code} · ` : ""}{p.account_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Status</label>
                <Select value={filters.status} onValueChange={(v) => setFilters((f) => ({ ...f, status: v }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {STATUS_FILTERS.map((t) => (
                      <SelectItem key={t} value={t}>{t === "All" ? "All statuses" : t}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">Balance range (absolute)</label>
                <div className="flex items-center gap-2">
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder="Min"
                    value={filters.minBalance}
                    onChange={(e) => setFilters((f) => ({ ...f, minBalance: e.target.value }))}
                  />
                  <span className="text-muted-foreground">–</span>
                  <Input
                    type="number"
                    inputMode="decimal"
                    placeholder="Max"
                    value={filters.maxBalance}
                    onChange={(e) => setFilters((f) => ({ ...f, maxBalance: e.target.value }))}
                  />
                </div>
              </div>
              <div className="flex items-end sm:col-span-2 lg:col-span-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setFilters(EMPTY_FILTERS)}
                  disabled={activeFilterCount === 0}
                >
                  Clear all filters
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {deleteError && (
        <Alert variant="destructive">
          <AlertDescription>{deleteError}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-6">
        {COA_ACCOUNT_TYPES.filter((type) => filters.type === "All" || filters.type === type).map((type) => {
          // Hierarchy view keeps the parent→child tree with per-parent collapse
          // (force-expanded while a search/filter is active so matches stay
          // visible); flat view lists every matching account of this type at
          // depth 0, sorted by code then name.
          const honorCollapse = search.trim() === "" && activeFilterCount === 0
          const nodes: FlatNode[] =
            viewMode === "tree"
              ? flattenTree(forest[type] ?? [], matcher, { collapsed: collapsedNodes, honorCollapse })
              : rows
                  .filter((r) => String(r.account_group) === type && matcher(r))
                  .sort(
                    (a, b) =>
                      String(a.account_code ?? "").localeCompare(String(b.account_code ?? "")) ||
                      String(a.account_name ?? "").localeCompare(String(b.account_name ?? "")),
                  )
                  .map((row) => ({ row, depth: 0, hasChildren: false }))
          // Header count is the full matching set for this type, independent of
          // which parents happen to be collapsed, so the badge never jumps.
          const matchCount =
            viewMode === "tree" ? flattenFiltered(forest[type] ?? [], matcher).length : nodes.length
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
                  <Badge variant="secondary" className="ml-auto">{matchCount} accounts</Badge>
                </button>

                {!isCollapsed && (
                  <div className="mt-4 overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th className="p-2 font-medium">Account</th>
                          <th className="p-2 font-medium">Account ID</th>
                          <th className="p-2 font-medium">Code</th>
                          <th className="p-2 font-medium">Sub type</th>
                          <th className="p-2 font-medium">Reporting</th>
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
                            <td colSpan={10} className="p-6 text-center text-muted-foreground">
                              No accounts in this group.
                            </td>
                          </tr>
                        )}
                        {nodes.map(({ row, depth, hasChildren }) => {
                          const isSystem = Number(row.is_system) === 1
                          return (
                            <tr key={row.id} className="border-b hover:bg-muted/40">
                              <td className="p-2">
                                <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                                  {viewMode === "tree" && hasChildren ? (
                                    <button
                                      type="button"
                                      onClick={() => toggleNode(String(row.account_id))}
                                      aria-expanded={!honorCollapse || !collapsedNodes.has(String(row.account_id))}
                                      aria-label={
                                        collapsedNodes.has(String(row.account_id))
                                          ? `Expand child accounts of ${row.account_name}`
                                          : `Collapse child accounts of ${row.account_name}`
                                      }
                                      className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                                    >
                                      {honorCollapse && collapsedNodes.has(String(row.account_id)) ? (
                                        <ChevronRight className="size-3.5" />
                                      ) : (
                                        <ChevronDown className="size-3.5" />
                                      )}
                                    </button>
                                  ) : depth > 0 ? (
                                    <CornerDownRight className="size-3.5 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <span className="inline-block size-4 shrink-0" />
                                  )}
                                  <a
                                    href={`/modules/finance/chart-of-accounts/${encodeURIComponent(String(row.account_id))}`}
                                    className="font-medium text-primary hover:underline"
                                  >
                                    {row.account_name}
                                  </a>
                                  {isSystem && (
                                    <Badge variant="outline" className="gap-1 text-[10px]">
                                      <ShieldCheck className="size-3" />
                                      System
                                    </Badge>
                                  )}
                                </div>
                              </td>
                              <td className="p-2 font-mono text-xs text-muted-foreground">{row.account_id}</td>
                              <td className="p-2 font-mono text-xs">{row.account_code || "—"}</td>
                              <td className="p-2">{row.account_type || "—"}</td>
                              <td className="p-2 align-top">
                                <ClassificationBadges row={row} />
                                {(() => {
                                  const roles = rolesByAccount.get(String(row.account_id)) ?? []
                                  if (roles.length === 0) return null
                                  return (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {roles.map((label) => (
                                        <Badge key={label} variant="secondary" className="text-[10px] font-normal">{label}</Badge>
                                      ))}
                                    </div>
                                  )
                                })()}
                              </td>
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
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="View ledger & account detail"
                                    title="View ledger, journal, transactions & balance"
                                    render={<a href={`/modules/finance/chart-of-accounts/${encodeURIComponent(String(row.account_id))}`} />}
                                  >
                                    <BookOpen className="size-4" />
                                  </Button>
                                  <Button variant="ghost" size="icon" aria-label="Add child account" onClick={() => openChild(row)}>
                                    <Plus className="size-4" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    aria-label="Opening balances by year"
                                    title="Opening balances by financial year"
                                    onClick={() => setObYearsAccount(row)}
                                  >
                                    <CalendarClock className="size-4" />
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

      <CoaOpeningBalancesDialog
        open={!!obYearsAccount}
        onOpenChange={(v) => !v && setObYearsAccount(null)}
        account={obYearsAccount}
        onSaved={() => {
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

  // Live reporting classification for the account being edited — auto-derived
  // from the same fields the statements engine reads, with any pinned override
  // applied. Recomputed as the form changes so the user sees exactly where this
  // head will land on the Balance Sheet / P&L / Cash Flow before saving.
  const classification = useMemo(
    () =>
      resolveClassification({
        account_group: form.account_group,
        account_type: form.account_type,
        account_code: form.account_code,
        account_name: form.account_name,
        gst_applicable: form.gst_applicable ? 1 : 0,
        tds_applicable: form.tds_applicable ? 1 : 0,
        bank_cash_account: form.bank_cash_account ? 1 : 0,
        bs_group: form.bs_group,
        pnl_group: form.pnl_group,
        cashflow_group: form.cashflow_group,
      }),
    [form],
  )
  const isPnl = classification.section === "ProfitAndLoss"
  const groupKey = isPnl ? "pnl_group" : "bs_group"
  const autoGroup = isPnl ? classification.autoPnlGroup : classification.autoBsGroup
  const groupOptions: readonly string[] =
    form.account_group === "Asset"
      ? BS_ASSET_GROUPS
      : form.account_group === "Liability"
        ? BS_LIABILITY_GROUPS
        : form.account_group === "Equity"
          ? ["Capital & Reserves"]
          : form.account_group === "Income"
            ? PL_INCOME_GROUPS
            : PL_EXPENSE_GROUPS

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
      // Changing the account type also invalidates any pinned reporting group
      // (a Balance Sheet group makes no sense once the account is an expense),
      // so the classification falls back to auto for the new type.
      if (key === "account_group") {
        next.bs_group = ""
        next.pnl_group = ""
        next.cashflow_group = ""
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

          <FieldGroup>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-semibold">Reporting classification</h3>
              <span className="text-xs text-muted-foreground">
                Groups this head on the {isPnl ? "Profit & Loss" : "Balance Sheet"} & Cash Flow
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Auto-derived from the account type, code and name. Leave on <span className="font-medium">Auto</span> unless
              you need to pin this account to a specific statement group — the same accounts are used, nothing is duplicated.
            </p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel>{isPnl ? "Profit & Loss group" : "Balance Sheet group"}</FieldLabel>
                <Select
                  value={form[groupKey] || "auto"}
                  onValueChange={(v) => set(groupKey, v === "auto" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto · {autoGroup}</SelectItem>
                    {groupOptions.map((g) => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel>Cash Flow activity</FieldLabel>
                <Select
                  value={form.cashflow_group || "auto"}
                  onValueChange={(v) => set("cashflow_group", v === "auto" ? "" : v)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto · {classification.autoCashFlowGroup}</SelectItem>
                    {CASHFLOW_GROUPS.map((g) => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 rounded-md border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Effective:</span>
              <Badge variant="outline" className="font-normal">
                {isPnl ? classification.pnlGroup : classification.bsGroup}
              </Badge>
              <span className="text-muted-foreground">·</span>
              <Badge variant="outline" className="font-normal">{classification.cashFlowGroup} activity</Badge>
              {(isPnl ? classification.pnlOverridden : classification.bsOverridden) ||
              classification.cashFlowOverridden ? (
                <span className="ml-1 font-medium uppercase text-muted-foreground">pinned</span>
              ) : null}
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

"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import useSWR from "swr"
import { toast } from "sonner"
import { fetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import {
  ArrowUpDown,
  Boxes,
  Download,
  FileText,
  History,
  Layers,
  Package,
  PackageX,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Trash2,
  TrendingDown,
  Upload,
  X,
} from "lucide-react"

// ── Types (mirrored from the API) ────────────────────────────────────────────

type Caps = {
  canViewCost: boolean
  canViewMargin: boolean
  canAdjustStock: boolean
  canChangeStatus: boolean
  canManageCategories: boolean
  canImportExport: boolean
  canManageSettings: boolean
  canCreate: boolean
}

type ProductRow = {
  id: number
  product_id: string
  name: string
  sku: string | null
  product_code: string | null
  category: string | null
  subcategory: string | null
  brand: string | null
  product_type: string
  track_inventory: number
  unit: string | null
  hsn_sac: string | null
  gst_rate: number
  selling_price: number
  purchase_price: number | null
  cost_price: number | null
  mrp: number | null
  current_stock: number
  reorder_level: number
  min_stock: number
  status: string
  stock_status: string
  preferred_vendor_name: string | null
  image_url: string | null
}

type Metrics = {
  total_products: number
  active_products: number
  in_stock: number
  low_stock: number
  out_of_stock: number
  inventory_cost: number | null
  stock_value: number
}

type FilterOptions = {
  categories: { name: string; parent: string | null }[]
  brands: string[]
  gstRates: number[]
  vendors: { id: string; name: string }[]
  productTypes: string[]
  units: string[]
  statuses: string[]
  stockStatuses: string[]
}

type ListResponse = {
  rows: ProductRow[]
  total: number
  page: number
  pageSize: number
  metrics: Metrics
  filterOptions: FilterOptions
  caps: Caps
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const inr = (v: number | null | undefined) =>
  v == null
    ? "—"
    : new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number(v))

const qty = (v: number | null | undefined) =>
  v == null ? "0" : new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(Number(v))

function stockStatusBadge(status: string) {
  const map: Record<string, string> = {
    "In Stock": "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    "Low Stock": "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
    "Out of Stock": "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  }
  return map[status] ?? "bg-muted text-muted-foreground"
}

function lifecycleBadge(status: string) {
  const map: Record<string, string> = {
    Active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
    Inactive: "bg-muted text-muted-foreground",
    Discontinued: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  }
  return map[status] ?? "bg-muted text-muted-foreground"
}

// ── Metric card ──────────────────────────────────────────────────────────────

function Metric({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: string
  icon: any
  tone?: string
}) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${tone ?? "bg-muted"}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">{label}</p>
          <p className="truncate text-lg font-semibold tabular-nums">{value}</p>
        </div>
      </CardContent>
    </Card>
  )
}

// ── Main component ───────────────────────────────────────────────────────────

const EMPTY_FILTERS = {
  search: "",
  category: "",
  product_type: "",
  status: "",
  stock_status: "",
}

export function ProductCatalogClient() {
  const [filters, setFilters] = useState({ ...EMPTY_FILTERS })
  const [sort, setSort] = useState<{ field: string; dir: "asc" | "desc" }>({ field: "created_at", dir: "desc" })
  const [page, setPage] = useState(1)
  const pageSize = 25

  const [detailId, setDetailId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [editRow, setEditRow] = useState<ProductRow | null>(null)
  const [categoriesOpen, setCategoriesOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const params = useMemo(() => {
    const sp = new URLSearchParams()
    for (const [k, v] of Object.entries(filters)) if (v) sp.set(k, v)
    sp.set("sort", sort.field)
    sp.set("dir", sort.dir)
    sp.set("page", String(page))
    sp.set("pageSize", String(pageSize))
    return sp.toString()
  }, [filters, sort, page])

  const listKey = `/api/products?${params}`
  const { data, isLoading, mutate } = useSWR<ListResponse>(listKey, fetcher)

  const caps = data?.caps
  const metrics = data?.metrics
  const fo = data?.filterOptions
  const rows = data?.rows ?? []
  const total = data?.total ?? 0
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  const setFilter = (k: keyof typeof filters, v: string) => {
    setPage(1)
    setFilters((f) => ({ ...f, [k]: v }))
  }

  const toggleSort = (field: string) => {
    setSort((s) => (s.field === field ? { field, dir: s.dir === "asc" ? "desc" : "asc" } : { field, dir: "asc" }))
  }

  const activeFilterCount = Object.entries(filters).filter(([k, v]) => v && k !== "search").length

  const refreshAll = useCallback(() => {
    mutate()
  }, [mutate])

  const onExport = async () => {
    try {
      const sp = new URLSearchParams()
      for (const [k, v] of Object.entries(filters)) if (v) sp.set(k, v)
      const res = await fetch(`/api/products/export?${sp.toString()}`)
      if (!res.ok) throw new Error("Export failed")
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `products-${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      toast.error((e as Error).message)
    }
  }

  const onImportFile = async (file: File) => {
    const form = new FormData()
    form.append("file", file)
    const res = await fetch("/api/products/import", { method: "POST", body: form })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(body.error || "Import failed")
      return
    }
    const summary = body.summary ?? {}
    toast.success(
      `Imported ${summary.created ?? 0} product(s)${summary.skipped ? `, skipped ${summary.skipped}` : ""}${summary.failed ? `, ${summary.failed} failed` : ""}`,
    )
    refreshAll()
  }

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Product Catalog</h1>
          <p className="text-sm text-muted-foreground">Manage products, stock, pricing and inventory movements.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Refresh
          </Button>
          {caps?.canImportExport && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) onImportFile(f)
                  e.target.value = ""
                }}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="mr-2 h-4 w-4" />
                Import
              </Button>
              <Button variant="outline" size="sm" onClick={onExport}>
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </>
          )}
          {caps?.canManageCategories && (
            <Button variant="outline" size="sm" onClick={() => setCategoriesOpen(true)}>
              <Layers className="mr-2 h-4 w-4" />
              Categories
            </Button>
          )}
          {caps?.canManageSettings && (
            <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="mr-2 h-4 w-4" />
              Settings
            </Button>
          )}
          {caps?.canCreate && (
            <Button
              size="sm"
              onClick={() => {
                setEditRow(null)
                setFormOpen(true)
              }}
            >
              <Plus className="mr-2 h-4 w-4" />
              New Product
            </Button>
          )}
        </div>
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <Metric label="Total Products" value={qty(metrics?.total_products)} icon={Package} tone="bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300" />
        <Metric label="Active" value={qty(metrics?.active_products)} icon={Boxes} tone="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <Metric label="In Stock" value={qty(metrics?.in_stock)} icon={Boxes} tone="bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300" />
        <Metric label="Low Stock" value={qty(metrics?.low_stock)} icon={TrendingDown} tone="bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300" />
        <Metric label="Out of Stock" value={qty(metrics?.out_of_stock)} icon={PackageX} tone="bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300" />
        <Metric
          label={caps?.canViewCost ? "Inventory Value" : "Stock Value"}
          value={inr(caps?.canViewCost ? metrics?.inventory_cost ?? 0 : metrics?.stock_value ?? 0)}
          icon={Boxes}
          tone="bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300"
        />
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search name, SKU, product ID, HSN…"
              className="pl-8"
              value={filters.search}
              onChange={(e) => setFilter("search", e.target.value)}
            />
          </div>
          <Select value={filters.category || "all"} onValueChange={(v) => setFilter("category", v === "all" ? "" : v)}>
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Categories</SelectItem>
              {fo?.categories.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.product_type || "all"} onValueChange={(v) => setFilter("product_type", v === "all" ? "" : v)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {fo?.productTypes.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.stock_status || "all"} onValueChange={(v) => setFilter("stock_status", v === "all" ? "" : v)}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Stock" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Stock</SelectItem>
              {fo?.stockStatuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.status || "all"} onValueChange={(v) => setFilter("status", v === "all" ? "" : v)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              {fo?.statuses.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {activeFilterCount > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setPage(1)
                setFilters((f) => ({ ...EMPTY_FILTERS, search: f.search }))
              }}
            >
              <X className="mr-1 h-4 w-4" />
              Clear ({activeFilterCount})
            </Button>
          )}
        </CardContent>
      </Card>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("product_id")}>
                    <span className="inline-flex items-center gap-1">Product <ArrowUpDown className="h-3 w-3" /></span>
                  </TableHead>
                  <TableHead className="cursor-pointer" onClick={() => toggleSort("name")}>
                    <span className="inline-flex items-center gap-1">Name / SKU <ArrowUpDown className="h-3 w-3" /></span>
                  </TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Category</TableHead>
                  <TableHead className="text-right">Stock</TableHead>
                  <TableHead className="text-right cursor-pointer" onClick={() => toggleSort("selling_price")}>
                    <span className="inline-flex items-center gap-1">Selling <ArrowUpDown className="h-3 w-3" /></span>
                  </TableHead>
                  {caps?.canViewCost && <TableHead className="text-right">Cost</TableHead>}
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow>
                    <TableCell colSpan={caps?.canViewCost ? 8 : 7} className="h-24 text-center text-muted-foreground">
                      Loading products…
                    </TableCell>
                  </TableRow>
                )}
                {!isLoading && rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={caps?.canViewCost ? 8 : 7} className="h-24 text-center text-muted-foreground">
                      No products found.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id} className="cursor-pointer" onClick={() => setDetailId(r.id)}>
                    <TableCell className="font-mono text-xs">{r.product_id}</TableCell>
                    <TableCell>
                      <div className="font-medium">{r.name}</div>
                      {r.sku && <div className="text-xs text-muted-foreground">SKU: {r.sku}</div>}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{r.product_type}</Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">{r.category || "—"}</TableCell>
                    <TableCell className="text-right">
                      {r.track_inventory ? (
                        <div className="flex flex-col items-end gap-0.5">
                          <span className="tabular-nums">{qty(r.current_stock)} {r.unit || ""}</span>
                          <Badge className={`${stockStatusBadge(r.stock_status)} text-[10px]`} variant="secondary">
                            {r.stock_status}
                          </Badge>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">Not tracked</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{inr(r.selling_price)}</TableCell>
                    {caps?.canViewCost && <TableCell className="text-right tabular-nums">{inr(r.cost_price)}</TableCell>}
                    <TableCell>
                      <Badge className={lifecycleBadge(r.status)} variant="secondary">
                        {r.status}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total === 0 ? "0" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)}`} of {total}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span>
            Page {page} / {totalPages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            Next
          </Button>
        </div>
      </div>

      {/* Detail sheet */}
      {detailId != null && caps && fo && (
        <ProductDetailSheet
          id={detailId}
          caps={caps}
          filterOptions={fo}
          onClose={() => setDetailId(null)}
          onChanged={refreshAll}
          onEdit={(row) => {
            setEditRow(row)
            setFormOpen(true)
          }}
        />
      )}

      {/* Create / edit form */}
      {formOpen && fo && (
        <ProductFormDialog
          open={formOpen}
          onOpenChange={setFormOpen}
          editRow={editRow}
          filterOptions={fo}
          caps={caps}
          onSaved={refreshAll}
        />
      )}

      {categoriesOpen && (
        <CategoriesDialog open={categoriesOpen} onOpenChange={setCategoriesOpen} onChanged={refreshAll} />
      )}
      {settingsOpen && <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />}
    </div>
  )
}

// ── Product form dialog ──────────────────────────────────────────────────────

const PRODUCT_TYPES_NON_STOCK = new Set(["Service", "Digital"])

function ProductFormDialog({
  open,
  onOpenChange,
  editRow,
  filterOptions,
  caps,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  editRow: ProductRow | null
  filterOptions: FilterOptions
  caps?: Caps
  onSaved: () => void
}) {
  const isEdit = !!editRow
  const [form, setForm] = useState<Record<string, any>>(() => ({
    name: editRow?.name ?? "",
    sku: editRow?.sku ?? "",
    product_code: editRow?.product_code ?? "",
    product_type: editRow?.product_type ?? "Goods",
    category: editRow?.category ?? "",
    subcategory: editRow?.subcategory ?? "",
    brand: editRow?.brand ?? "",
    unit: editRow?.unit ?? "Nos",
    hsn_sac: editRow?.hsn_sac ?? "",
    gst_applicable: editRow ? undefined : true,
    gst_rate: editRow?.gst_rate ?? 18,
    selling_price: editRow?.selling_price ?? "",
    purchase_price: editRow?.purchase_price ?? "",
    cost_price: editRow?.cost_price ?? "",
    mrp: editRow?.mrp ?? "",
    opening_stock: "",
    reorder_level: editRow?.reorder_level ?? "",
    min_stock: editRow?.min_stock ?? "",
    description: "",
    status: editRow?.status ?? "Active",
  }))
  const [saving, setSaving] = useState(false)
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }))

  const tracksStock = !PRODUCT_TYPES_NON_STOCK.has(String(form.product_type))

  const submit = async (allowDuplicate = false) => {
    if (!String(form.name).trim()) {
      toast.error("Product Name is required.")
      return
    }
    setSaving(true)
    try {
      const payload = { ...form, allow_duplicate: allowDuplicate }
      const res = await fetch(isEdit ? `/api/products/${editRow!.id}` : "/api/products", {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409 && body.requiresOverride === "duplicate") {
        setSaving(false)
        if (confirm(`${body.error}\n\nAdd anyway?`)) submit(true)
        return
      }
      if (!res.ok) throw new Error(body.error || "Save failed")
      toast.success(isEdit ? "Product updated" : "Product created")
      onSaved()
      onOpenChange(false)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit ${editRow!.product_id}` : "New Product"}</DialogTitle>
          <DialogDescription>
            {isEdit ? "Update product details. Price changes are tracked in history." : "Add a product to the catalog."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Label>Product Name *</Label>
              <Input value={form.name} onChange={(e) => set("name", e.target.value)} />
            </div>
            <div>
              <Label>SKU</Label>
              <Input value={form.sku} onChange={(e) => set("sku", e.target.value)} />
            </div>
            <div>
              <Label>Product Code</Label>
              <Input value={form.product_code} onChange={(e) => set("product_code", e.target.value)} />
            </div>
            <div>
              <Label>Type</Label>
              <Select value={form.product_type} onValueChange={(v) => set("product_type", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {filterOptions.productTypes.map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Unit</Label>
              <Select value={form.unit} onValueChange={(v) => set("unit", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {filterOptions.units.map((u) => (
                    <SelectItem key={u} value={u}>
                      {u}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Category</Label>
              <Input value={form.category} onChange={(e) => set("category", e.target.value)} list="cat-list" />
              <datalist id="cat-list">
                {filterOptions.categories.map((c) => (
                  <option key={c.name} value={c.name} />
                ))}
              </datalist>
            </div>
            <div>
              <Label>Brand</Label>
              <Input value={form.brand} onChange={(e) => set("brand", e.target.value)} />
            </div>
            <div>
              <Label>HSN / SAC</Label>
              <Input value={form.hsn_sac} onChange={(e) => set("hsn_sac", e.target.value)} />
            </div>
            <div>
              <Label>GST Rate (%)</Label>
              <Input type="number" value={form.gst_rate} onChange={(e) => set("gst_rate", e.target.value)} />
            </div>
          </div>

          <Separator />

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <Label>Selling Price</Label>
              <Input type="number" value={form.selling_price} onChange={(e) => set("selling_price", e.target.value)} />
            </div>
            <div>
              <Label>MRP</Label>
              <Input type="number" value={form.mrp} onChange={(e) => set("mrp", e.target.value)} />
            </div>
            {caps?.canViewCost && (
              <>
                <div>
                  <Label>Purchase Price</Label>
                  <Input type="number" value={form.purchase_price} onChange={(e) => set("purchase_price", e.target.value)} />
                </div>
                <div>
                  <Label>Cost Price</Label>
                  <Input type="number" value={form.cost_price} onChange={(e) => set("cost_price", e.target.value)} />
                </div>
              </>
            )}
          </div>

          {tracksStock && (
            <>
              <Separator />
              <div className="grid grid-cols-3 gap-3">
                {!isEdit && (
                  <div>
                    <Label>Opening Stock</Label>
                    <Input type="number" value={form.opening_stock} onChange={(e) => set("opening_stock", e.target.value)} />
                  </div>
                )}
                <div>
                  <Label>Reorder Level</Label>
                  <Input type="number" value={form.reorder_level} onChange={(e) => set("reorder_level", e.target.value)} />
                </div>
                <div>
                  <Label>Min Stock</Label>
                  <Input type="number" value={form.min_stock} onChange={(e) => set("min_stock", e.target.value)} />
                </div>
              </div>
            </>
          )}

          <div>
            <Label>Description</Label>
            <Textarea value={form.description} onChange={(e) => set("description", e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => submit(false)} disabled={saving}>
            {saving ? "Saving…" : isEdit ? "Save Changes" : "Create Product"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Product detail sheet ─────────────────────────────────────────────────────

function ProductDetailSheet({
  id,
  caps,
  filterOptions,
  onClose,
  onChanged,
  onEdit,
}: {
  id: number
  caps: Caps
  filterOptions: FilterOptions
  onClose: () => void
  onChanged: () => void
  onEdit: (row: ProductRow) => void
}) {
  const detailKey = `/api/products/${id}`
  const { data, mutate } = useSWR<any>(detailKey, fetcher)
  const stockKey = `/api/products/${id}/stock`
  const { data: stockData, mutate: mutateStock } = useSWR<any>(stockKey, fetcher)
  const auditKey = `/api/products/${id}/audit`
  const { data: auditData } = useSWR<any>(auditKey, fetcher)

  const p = data?.product
  const margin = data?.margin
  const vendors = data?.vendors ?? []
  const documents = data?.documents ?? []
  const priceHistory = data?.priceHistory ?? []

  const refreshAll = () => {
    mutate()
    mutateStock()
    onChanged()
  }

  const changeStatus = async (status: string) => {
    const reason = prompt(`Reason for changing status to "${status}"?`) ?? ""
    const res = await fetch(`/api/products/${id}/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status, reason }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return toast.error(body.error || "Failed")
    toast.success(`Status changed to ${status}`)
    refreshAll()
  }

  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {!p ? (
          <div className="p-6 text-sm text-muted-foreground">Loading…</div>
        ) : (
          <>
            <SheetHeader className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <SheetTitle className="text-lg">{p.name}</SheetTitle>
                <Badge className={lifecycleBadge(p.status)} variant="secondary">
                  {p.status}
                </Badge>
              </div>
              <SheetDescription className="font-mono text-xs">
                {p.product_id}
                {p.sku ? ` · SKU ${p.sku}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="flex flex-wrap gap-2 px-4">
              <Button size="sm" variant="outline" onClick={() => onEdit(p)}>
                Edit
              </Button>
              {caps.canChangeStatus && p.status !== "Active" && (
                <Button size="sm" variant="outline" onClick={() => changeStatus("Active")}>
                  Activate
                </Button>
              )}
              {caps.canChangeStatus && p.status === "Active" && (
                <Button size="sm" variant="outline" onClick={() => changeStatus("Inactive")}>
                  Deactivate
                </Button>
              )}
              {caps.canChangeStatus && p.status !== "Discontinued" && (
                <Button size="sm" variant="outline" onClick={() => changeStatus("Discontinued")}>
                  Discontinue
                </Button>
              )}
            </div>

            <Tabs defaultValue="overview" className="px-4 pb-6 pt-2">
              <TabsList className="flex w-full flex-wrap">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                {Number(p.track_inventory) === 1 && <TabsTrigger value="stock">Stock</TabsTrigger>}
                <TabsTrigger value="vendors">Vendors</TabsTrigger>
                <TabsTrigger value="docs">Docs</TabsTrigger>
                <TabsTrigger value="history">Pricing</TabsTrigger>
                <TabsTrigger value="audit">Audit</TabsTrigger>
              </TabsList>

              {/* Overview */}
              <TabsContent value="overview" className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Type" value={p.product_type} />
                  <Field label="Category" value={p.category || "—"} />
                  <Field label="Brand" value={p.brand || "—"} />
                  <Field label="Unit" value={p.unit || "—"} />
                  <Field label="HSN/SAC" value={p.hsn_sac || "—"} />
                  <Field label="GST Rate" value={`${qty(p.gst_rate)}%`} />
                  <Field label="Selling Price" value={inr(p.selling_price)} />
                  <Field label="MRP" value={inr(p.mrp)} />
                  {caps.canViewCost && <Field label="Purchase Price" value={inr(p.purchase_price)} />}
                  {caps.canViewCost && <Field label="Cost Price" value={inr(p.cost_price)} />}
                  {margin && (
                    <Field label="Margin" value={`${inr(margin.amount)} (${qty(margin.percent)}%)`} />
                  )}
                  {Number(p.track_inventory) === 1 && (
                    <>
                      <Field label="Current Stock" value={`${qty(p.current_stock)} ${p.unit || ""}`} />
                      <Field label="Stock Status" value={p.stock_status} />
                      <Field label="Reorder Level" value={qty(p.reorder_level)} />
                      <Field label="Min Stock" value={qty(p.min_stock)} />
                    </>
                  )}
                </div>
                {p.description && (
                  <div>
                    <p className="text-xs text-muted-foreground">Description</p>
                    <p className="text-sm">{p.description}</p>
                  </div>
                )}
              </TabsContent>

              {/* Stock */}
              {Number(p.track_inventory) === 1 && (
                <TabsContent value="stock" className="mt-3 space-y-4">
                  {caps.canAdjustStock && (
                    <StockAdjustForm productId={id} unit={p.unit} onDone={refreshAll} />
                  )}
                  <div>
                    <p className="mb-2 text-sm font-medium">Movement Ledger</p>
                    <div className="overflow-x-auto rounded-md border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Date</TableHead>
                            <TableHead>Type</TableHead>
                            <TableHead className="text-right">Qty</TableHead>
                            <TableHead className="text-right">Balance</TableHead>
                            <TableHead>Reference</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(stockData?.ledger ?? []).length === 0 && (
                            <TableRow>
                              <TableCell colSpan={5} className="h-16 text-center text-sm text-muted-foreground">
                                No movements yet.
                              </TableCell>
                            </TableRow>
                          )}
                          {(stockData?.ledger ?? []).map((m: any) => (
                            <TableRow key={m.id}>
                              <TableCell className="whitespace-nowrap text-xs">
                                {String(m.movement_date || m.created_at || "").slice(0, 10)}
                              </TableCell>
                              <TableCell className="text-xs">{m.movement_type}</TableCell>
                              <TableCell className={`text-right tabular-nums ${Number(m.quantity) < 0 ? "text-red-600" : "text-emerald-600"}`}>
                                {Number(m.quantity) > 0 ? "+" : ""}
                                {qty(m.quantity)}
                              </TableCell>
                              <TableCell className="text-right tabular-nums">{qty(m.balance_after ?? m.after_qty)}</TableCell>
                              <TableCell className="text-xs text-muted-foreground">{m.reference || "—"}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                </TabsContent>
              )}

              {/* Vendors */}
              <TabsContent value="vendors" className="mt-3">
                <VendorsPanel productId={id} vendors={vendors} canEdit onChanged={refreshAll} caps={caps} />
              </TabsContent>

              {/* Documents */}
              <TabsContent value="docs" className="mt-3">
                <DocumentsPanel productId={id} documents={documents} onChanged={refreshAll} />
              </TabsContent>

              {/* Pricing history */}
              <TabsContent value="history" className="mt-3">
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Field</TableHead>
                        <TableHead className="text-right">Old</TableHead>
                        <TableHead className="text-right">New</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {priceHistory.length === 0 && (
                        <TableRow>
                          <TableCell colSpan={4} className="h-16 text-center text-sm text-muted-foreground">
                            No price changes recorded.
                          </TableCell>
                        </TableRow>
                      )}
                      {priceHistory.map((h: any) => (
                        <TableRow key={h.id}>
                          <TableCell className="whitespace-nowrap text-xs">
                            {String(h.changed_at || "").slice(0, 10)}
                          </TableCell>
                          <TableCell className="text-xs">{h.field}</TableCell>
                          <TableCell className="text-right tabular-nums">{inr(h.old_value)}</TableCell>
                          <TableCell className="text-right tabular-nums">{inr(h.new_value)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </TabsContent>

              {/* Audit */}
              <TabsContent value="audit" className="mt-3">
                <div className="space-y-2">
                  {(auditData?.audit ?? []).length === 0 && (
                    <p className="text-sm text-muted-foreground">No audit entries.</p>
                  )}
                  {(auditData?.audit ?? []).map((a: any) => (
                    <div key={a.id} className="flex items-start gap-2 rounded-md border p-2 text-sm">
                      <History className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                      <div>
                        <p>
                          <span className="font-medium">{a.action}</span>
                          {a.field ? ` · ${a.field}` : ""}
                        </p>
                        {(a.old_value != null || a.new_value != null) && (
                          <p className="text-xs text-muted-foreground">
                            {String(a.old_value ?? "—")} → {String(a.new_value ?? "—")}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {a.user_name || "System"} · {String(a.created_at || "").slice(0, 16).replace("T", " ")}
                          {a.reason ? ` · ${a.reason}` : ""}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  )
}

// ── Stock adjust form ────────────────────────────────────────────────────────

function StockAdjustForm({ productId, unit, onDone }: { productId: number; unit: string | null; onDone: () => void }) {
  const [type, setType] = useState("Increase")
  const [quantity, setQuantity] = useState("")
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    if (!reason.trim()) return toast.error("A reason is required.")
    setBusy(true)
    try {
      const res = await fetch(`/api/products/${productId}/stock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ adjustment_type: type, quantity: Number(quantity), reason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Adjustment failed")
      toast.success(`Stock ${type.toLowerCase()}d · new balance ${qty(body.after)}`)
      setQuantity("")
      setReason("")
      onDone()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-md border p-3">
      <p className="mb-2 text-sm font-medium">Adjust Stock</p>
      <div className="grid grid-cols-2 gap-2">
        <Select value={type} onValueChange={setType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Increase">Increase</SelectItem>
            <SelectItem value="Decrease">Decrease</SelectItem>
            <SelectItem value="Set">Set to</SelectItem>
          </SelectContent>
        </Select>
        <Input
          type="number"
          placeholder={`Quantity ${unit ? `(${unit})` : ""}`}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
        />
      </div>
      <Input className="mt-2" placeholder="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} />
      <Button className="mt-2 w-full" size="sm" onClick={submit} disabled={busy}>
        {busy ? "Applying…" : "Apply Adjustment"}
      </Button>
    </div>
  )
}

// ── Vendors panel ────────────────────────────────────────────────────────────

function VendorsPanel({
  productId,
  vendors,
  onChanged,
  caps,
}: {
  productId: number
  vendors: any[]
  canEdit?: boolean
  onChanged: () => void
  caps: Caps
}) {
  const [vendorId, setVendorId] = useState("")
  const [vendorName, setVendorName] = useState("")
  const [vendorPrice, setVendorPrice] = useState("")
  const [preferred, setPreferred] = useState(false)

  const add = async () => {
    if (!vendorId.trim()) return toast.error("Vendor ID is required.")
    const res = await fetch(`/api/products/${productId}/vendors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vendor_id: vendorId,
        vendor_name: vendorName,
        vendor_price: Number(vendorPrice) || 0,
        is_preferred: preferred,
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return toast.error(body.error || "Failed")
    toast.success("Vendor saved")
    setVendorId("")
    setVendorName("")
    setVendorPrice("")
    setPreferred(false)
    onChanged()
  }

  const remove = async (vid: string) => {
    const res = await fetch(`/api/products/${productId}/vendors?vendor_id=${encodeURIComponent(vid)}`, {
      method: "DELETE",
    })
    if (!res.ok) return toast.error("Failed")
    toast.success("Vendor removed")
    onChanged()
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        {vendors.length === 0 && <p className="text-sm text-muted-foreground">No vendors linked.</p>}
        {vendors.map((v) => (
          <div key={v.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
            <div>
              <p className="font-medium">
                {v.vendor_name || v.vendor_id}
                {Number(v.is_preferred) === 1 && (
                  <Badge className="ml-2" variant="secondary">
                    Preferred
                  </Badge>
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {v.vendor_id}
                {caps.canViewCost && v.vendor_price ? ` · ${inr(v.vendor_price)}` : ""}
              </p>
            </div>
            <Button size="icon" variant="ghost" onClick={() => remove(v.vendor_id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
      <Separator />
      <div className="grid grid-cols-2 gap-2">
        <Input placeholder="Vendor ID" value={vendorId} onChange={(e) => setVendorId(e.target.value)} />
        <Input placeholder="Vendor Name" value={vendorName} onChange={(e) => setVendorName(e.target.value)} />
        {caps.canViewCost && (
          <Input
            type="number"
            placeholder="Vendor Price"
            value={vendorPrice}
            onChange={(e) => setVendorPrice(e.target.value)}
          />
        )}
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={preferred} onCheckedChange={setPreferred} />
          Preferred
        </label>
      </div>
      <Button size="sm" onClick={add}>
        <Plus className="mr-1 h-4 w-4" />
        Add Vendor
      </Button>
    </div>
  )
}

// ── Documents panel ──────────────────────────────────────────────────────────

function DocumentsPanel({
  productId,
  documents,
  onChanged,
}: {
  productId: number
  documents: any[]
  onChanged: () => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const upload = async (file: File) => {
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("doc_type", file.type.startsWith("image/") ? "Image" : "Product Document")
      const res = await fetch(`/api/products/${productId}/documents`, { method: "POST", body: form })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(body.error || "Upload failed")
      toast.success("Document uploaded")
      onChanged()
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const remove = async (docId: number) => {
    const res = await fetch(`/api/products/${productId}/documents?doc_id=${docId}`, { method: "DELETE" })
    if (!res.ok) return toast.error("Failed")
    toast.success("Document removed")
    onChanged()
  }

  return (
    <div className="space-y-3">
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0]
          if (f) upload(f)
          e.target.value = ""
        }}
      />
      <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={uploading}>
        <Upload className="mr-1 h-4 w-4" />
        {uploading ? "Uploading…" : "Upload Document"}
      </Button>
      <div className="space-y-2">
        {documents.length === 0 && <p className="text-sm text-muted-foreground">No documents.</p>}
        {documents.map((d) => (
          <div key={d.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
            <a href={d.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 hover:underline">
              <FileText className="h-4 w-4 text-muted-foreground" />
              <span>{d.file_name}</span>
              <Badge variant="outline" className="text-[10px]">
                {d.doc_type}
              </Badge>
            </a>
            <Button size="icon" variant="ghost" onClick={() => remove(d.id)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Categories dialog ────────────────────────────────────────────────────────

function CategoriesDialog({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onChanged: () => void
}) {
  const { data, mutate } = useSWR<any>("/api/products/categories", fetcher)
  const [name, setName] = useState("")
  const [parent, setParent] = useState("")
  const categories = data?.categories ?? []

  const add = async () => {
    if (!name.trim()) return toast.error("Category name is required.")
    const res = await fetch("/api/products/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parent: parent || null }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return toast.error(body.error || "Failed")
    toast.success("Category saved")
    setName("")
    setParent("")
    mutate()
    onChanged()
  }

  const remove = async (id: number) => {
    const res = await fetch(`/api/products/categories?id=${id}`, { method: "DELETE" })
    if (!res.ok) return toast.error("Failed")
    toast.success("Category retired")
    mutate()
    onChanged()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Categories</DialogTitle>
          <DialogDescription>Organize products into categories and subcategories.</DialogDescription>
        </DialogHeader>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {categories.map((c: any) => (
            <div key={c.id} className="flex items-center justify-between rounded-md border p-2 text-sm">
              <span>
                {c.parent ? <span className="text-muted-foreground">{c.parent} / </span> : null}
                {c.name}
                <span className="ml-2 text-xs text-muted-foreground">({c.product_count})</span>
              </span>
              <Button size="icon" variant="ghost" onClick={() => remove(c.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
        <Separator />
        <div className="grid grid-cols-2 gap-2">
          <Input placeholder="New category name" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="Parent (optional)" value={parent} onChange={(e) => setParent(e.target.value)} list="parent-cats" />
          <datalist id="parent-cats">
            {categories.filter((c: any) => !c.parent).map((c: any) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </div>
        <DialogFooter>
          <Button onClick={add}>
            <Plus className="mr-1 h-4 w-4" />
            Add Category
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ── Settings dialog ──────────────────────────────────────────────────────────

function SettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { data, mutate } = useSWR<any>("/api/products/settings", fetcher)
  const s = data?.settings
  const [form, setForm] = useState<Record<string, string> | null>(null)
  const current = form ?? s
  const set = (k: string, v: string) => setForm({ ...(current ?? {}), [k]: v })

  const save = async () => {
    const res = await fetch("/api/products/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(current),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) return toast.error(body.error || "Failed")
    toast.success("Settings saved")
    mutate()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Inventory Settings</DialogTitle>
          <DialogDescription>Defaults applied across the product catalog.</DialogDescription>
        </DialogHeader>
        {!current ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <div className="grid gap-3">
            <div>
              <Label>Global Low-Stock Threshold</Label>
              <Input
                type="number"
                value={current.low_stock_threshold}
                onChange={(e) => set("low_stock_threshold", e.target.value)}
              />
            </div>
            <div>
              <Label>Default Unit</Label>
              <Input value={current.default_unit} onChange={(e) => set("default_unit", e.target.value)} />
            </div>
            <div>
              <Label>Default GST Rate (%)</Label>
              <Input type="number" value={current.default_gst_rate} onChange={(e) => set("default_gst_rate", e.target.value)} />
            </div>
            <div>
              <Label>Default Valuation Method</Label>
              <Select value={current.default_valuation} onValueChange={(v) => set("default_valuation", v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Weighted Average">Weighted Average</SelectItem>
                  <SelectItem value="FIFO">FIFO</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <label className="flex items-center justify-between rounded-md border p-3 text-sm">
              <span>Allow Negative Stock</span>
              <Switch
                checked={current.negative_stock_allowed === "1"}
                onCheckedChange={(v) => set("negative_stock_allowed", v ? "1" : "0")}
              />
            </label>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!current}>
            Save Settings
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

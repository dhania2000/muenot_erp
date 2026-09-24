"use client"

import { useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import useSWR from "swr"
import { fetcher } from "@/lib/fetcher"
import type { PortalItem } from "@/lib/portal/store"
import { ItemList } from "@/components/portal/item-list"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Plus, Minus, Loader2, Search, ShoppingCart, Trash2, PackageSearch } from "lucide-react"

type CatalogProduct = {
  id: number
  product_code: string
  name: string
  sku: string | null
  description: string | null
  category: string | null
  unit: string
  selling_price: number
  mrp: number
  image_url: string | null
}

function formatINR(value: number) {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 2,
    }).format(value)
  } catch {
    return `₹${value.toFixed(2)}`
  }
}

export function OrdersView({ items }: { items: PortalItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [notes, setNotes] = useState("")
  // productId -> quantity
  const [cart, setCart] = useState<Record<number, number>>({})

  const { data, isLoading } = useSWR<{ products: CatalogProduct[] }>(
    open ? "/api/portal/catalog" : null,
    fetcher,
    { revalidateOnFocus: false },
  )
  const products = data?.products ?? []
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku ?? "").toLowerCase().includes(q) ||
        p.product_code.toLowerCase().includes(q) ||
        (p.category ?? "").toLowerCase().includes(q),
    )
  }, [products, search])

  const cartEntries = useMemo(
    () => Object.entries(cart).map(([id, qty]) => ({ product: byId.get(Number(id)), quantity: qty })),
    [cart, byId],
  )
  const cartCount = cartEntries.reduce((sum, e) => sum + e.quantity, 0)
  const cartTotal = cartEntries.reduce(
    (sum, e) => sum + (e.product ? Number(e.product.selling_price) * e.quantity : 0),
    0,
  )

  function setQty(id: number, qty: number) {
    setCart((prev) => {
      const next = { ...prev }
      if (qty <= 0) delete next[id]
      else next[id] = Math.min(qty, 100000)
      return next
    })
  }

  function reset() {
    setSearch("")
    setNotes("")
    setCart({})
    setError(null)
  }

  async function submit() {
    if (cartCount === 0) {
      setError("Add at least one product to your order")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/portal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: Object.entries(cart).map(([id, qty]) => ({ productId: Number(id), quantity: qty })),
          description: notes.trim() || null,
        }),
      })
      const resData = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(resData?.error || "Could not place your order. Please try again.")
        return
      }
      setOpen(false)
      reset()
      router.refresh()
    } catch {
      setError("Could not place your order. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  const placeOrderButton = (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" className="gap-2">
          <Plus className="h-4 w-4" />
          Place order
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[85vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 py-4">
          <DialogTitle>Place a new order</DialogTitle>
          <DialogDescription>
            Browse the catalog, choose quantities, and send your order to your account team.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col">
          <div className="border-b px-6 py-3">
            <div className="relative">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search products by name, SKU, or category"
                className="pl-8"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-3">
            {isLoading ? (
              <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
                Loading catalog…
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 py-12 text-center text-muted-foreground">
                <PackageSearch className="h-8 w-8" />
                <p className="text-sm">
                  {products.length === 0 ? "No products are available to order yet." : "No products match your search."}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col divide-y">
                {filtered.map((p) => {
                  const qty = cart[p.id] ?? 0
                  return (
                    <li key={p.id} className="flex items-center gap-3 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate font-medium">{p.name}</span>
                          {p.category && (
                            <Badge variant="secondary" className="shrink-0 text-[10px]">
                              {p.category}
                            </Badge>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                          <span className="font-mono">{p.sku || p.product_code}</span>
                          <span className="font-medium text-foreground">{formatINR(Number(p.selling_price))}</span>
                          <span>/ {p.unit}</span>
                        </div>
                      </div>
                      {qty === 0 ? (
                        <Button type="button" variant="outline" size="sm" onClick={() => setQty(p.id, 1)}>
                          Add
                        </Button>
                      ) : (
                        <div className="flex items-center gap-1">
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setQty(p.id, qty - 1)}
                            aria-label={`Decrease ${p.name}`}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </Button>
                          <Input
                            value={qty}
                            onChange={(e) => {
                              const n = Number.parseInt(e.target.value.replace(/\D/g, ""), 10)
                              setQty(p.id, Number.isNaN(n) ? 0 : n)
                            }}
                            inputMode="numeric"
                            className="h-8 w-14 text-center"
                            aria-label={`Quantity for ${p.name}`}
                          />
                          <Button
                            type="button"
                            variant="outline"
                            size="icon"
                            className="h-8 w-8"
                            onClick={() => setQty(p.id, qty + 1)}
                            aria-label={`Increase ${p.name}`}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          {cartCount > 0 && (
            <div className="border-t bg-muted/30 px-6 py-3">
              <div className="mb-2 flex items-center gap-2 text-sm font-medium">
                <ShoppingCart className="h-4 w-4" />
                Order summary
                <Badge variant="secondary">{cartCount} item{cartCount === 1 ? "" : "s"}</Badge>
              </div>
              <ul className="flex max-h-28 flex-col gap-1 overflow-y-auto text-sm">
                {cartEntries.map(({ product, quantity }) =>
                  product ? (
                    <li key={product.id} className="flex items-center justify-between gap-2">
                      <span className="truncate text-muted-foreground">
                        {product.name} <span className="tabular-nums">× {quantity}</span>
                      </span>
                      <span className="flex items-center gap-2 tabular-nums">
                        {formatINR(Number(product.selling_price) * quantity)}
                        <button
                          type="button"
                          onClick={() => setQty(product.id, 0)}
                          className="text-muted-foreground hover:text-destructive"
                          aria-label={`Remove ${product.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </span>
                    </li>
                  ) : null,
                )}
              </ul>
              <div className="mt-2 flex items-center justify-between border-t pt-2 text-sm font-semibold">
                <span>Estimated total</span>
                <span className="tabular-nums">{formatINR(cartTotal)}</span>
              </div>
            </div>
          )}

          <div className="border-t px-6 py-3">
            <Label htmlFor="order-notes" className="text-xs text-muted-foreground">
              Notes (optional)
            </Label>
            <Textarea
              id="order-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Delivery preferences, or anything else we should know."
              rows={2}
              className="mt-1"
            />
          </div>
        </div>

        {error && <p className="px-6 text-sm text-destructive">{error}</p>}

        <DialogFooter className="border-t px-6 py-4">
          <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={submitting || cartCount === 0} className="gap-2">
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            Submit order{cartCount > 0 ? ` · ${formatINR(cartTotal)}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  return <ItemList resource="orders" title="Orders" items={items} headerAction={placeOrderButton} />
}

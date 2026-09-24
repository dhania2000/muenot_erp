"use client"

import { useState } from "react"
import { useRouter } from "next/navigation"
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
import { Plus, Loader2 } from "lucide-react"

export function OrdersView({ items }: { items: PortalItem[] }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState("")
  const [description, setDescription] = useState("")
  const [amount, setAmount] = useState("")
  const [currency, setCurrency] = useState("")

  function reset() {
    setTitle("")
    setDescription("")
    setAmount("")
    setCurrency("")
    setError(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!title.trim()) {
      setError("A short order summary is required")
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch("/api/portal/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || null,
          amount: amount.trim() || null,
          currency: currency.trim() || null,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data?.error || "Could not place your order. Please try again.")
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
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Place a new order</DialogTitle>
            <DialogDescription>
              Send an order request to your account team. They&apos;ll confirm the details with you.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="order-title">Order summary</Label>
              <Input
                id="order-title"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="e.g. 500 units of Product A"
                maxLength={200}
                required
                autoFocus
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="order-description">Details (optional)</Label>
              <Textarea
                id="order-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Specifications, delivery preferences, or anything else we should know."
                rows={4}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="order-amount">Estimated amount (optional)</Label>
                <Input
                  id="order-amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="order-currency">Currency (optional)</Label>
                <Input
                  id="order-currency"
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  placeholder="USD"
                  maxLength={10}
                />
              </div>
            </div>

            {error && <p className="text-sm text-destructive">{error}</p>}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting} className="gap-2">
              {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Submit order
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )

  return <ItemList resource="orders" title="Orders" items={items} headerAction={placeOrderButton} />
}
